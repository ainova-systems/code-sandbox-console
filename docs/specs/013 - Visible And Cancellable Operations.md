# 013 — Visible And Cancellable Operations

> **Iteration spec — immutable history.** Describes what changed in this iteration and
> why. The current truth lives in [`../Architecture.md`](../Architecture.md) and
> [`../Features.md`](../Features.md); where this spec disagrees with them, they win.
>
> **Period:** 2026-07-29 · **Base:** `main` after spec 012
>
> **Status: shipped with this iteration.** Features FR-054/FR-055/FR-056 (and the updated
> §10 progress paragraph, FR-007, FR-032) and Architecture §4/§11/§12 carry the current
> truth.

## What & why

Rebuild is the longest operation in the product and the least observable one. Clicking
Rebuild on a Dockerfile-backed sandbox raises one static notification — *"Rebuilding
image `<tag>`…"* — and then shows nothing for minutes. Underneath, `images.buildAndLoad`
runs `docker build --pull` (FR-053 re-fetches the whole agent base on every rebuild)
through a **buffered** `execFile`: not one line of output reaches the user until the
process exits. The notification is non-cancellable by construction (spec 008's
`ops.withProgress`) and its message never changes, so a healthy multi-minute build and a
wedged one are indistinguishable.

Users respond exactly the way spec 008 predicted they respond to silence — they click
again. Here the second click is not merely redundant. `sandboxConsole.rebuild` (palette)
and `sandboxConsole.item.rebuild` (Explorer) both call `ops.rebuildRef` with **no
in-flight guard**, so a second pipeline starts on the same sandbox: two `docker build`
runs writing the same tag, then racing `sbx rm` / `sbx create` on one sandbox name. The
observed symptom is two stacked *"Rebuilding image…"* notifications; the unobserved one
is a create that fails, or succeeds against a half-removed instance.

The New Sandbox form has the same silence with a different failure mode. Its host side
already ignores re-entrant submits (the `saving` flag in `form.ts`), but the webview
gives no sign of it: **Save** stays enabled and the panel stays open until `apply()`
resolves — which, for a sandbox that must build an image first, is the same several
minutes. The second click is silently dropped, which reads as "the button doesn't work".

Spec 008 established the invariant that no lifecycle click may be a silent gap. It fixed
the *beginning* of the gap. This iteration fixes its *duration*: what is happening while
it runs, how to stop it, and the guarantee that it can only be happening once.

## What changed

**FR-054: one lifecycle operation per sandbox at a time.** `ops.ts` gained an in-flight
registry keyed by sbx name and valued with the operation's label. Every lifecycle entry
point (`createOrAttach`, `rebuildRef`, `stopRef`, `destroyRef`, `shellRef`) runs through
it. A second invocation while one is in flight does **not** start a pipeline and does
**not** silently await one: it surfaces *"`<op>` is already running for `<name>`"* with a
**Show Log** action. The guard sits in `ops.ts`, below every caller, so the palette
commands, the Explorer node actions, and the form's save path are covered by one
implementation and can never drift apart. `destroyRef` returns whether it ran, because
"Remove from config" must keep the recipe entry when its destroy was declined — the same
rule the code already followed for a *failed* destroy, so a live microVM is never
orphaned.

The webview form got the matching *visual* half: on submit, **Save** is disabled and
relabelled to the running phase (*Creating…* / *Applying…*), the rest of the form is
disabled with it, and an inline status line replaces the silent wait. Cancel is disabled
too — closing the panel would not stop the work; the way out is the progress
notification's own Cancel. Any failure that keeps the panel open posts `idle` back to the
webview so the form is handed to the user for a retry.

**FR-055: an operation log.** A new `src/log.ts` owns a single `Sandbox Console` output
channel and the `spawn`-based runner that replaced the buffered `promisify(execFile)`
runners in `sbx.ts` and `images.ts`. It streams `stdout`/`stderr` line by line into the
channel while still accumulating the text every existing error message relies on, so no
caller's `code`-based error handling changed. Each invocation is bracketed by a
`$ <exe> <args…>` header and a `→ exit <code> (<time>)` footer, so the channel reads as a
log of operations rather than a trace, and every line carries an `[n]` invocation tag —
FR-054 serialises one sandbox, not the machine, so concurrent operations on different
sandboxes interleave their output (observed during acceptance: a `create`'s header and
error landed between two `stop`s' headers and their exit lines). `log.ts` deliberately
knows no CLI strings — the containment rule that keeps them in `sbx.ts` / `images.ts` is
unaffected.

The same stream drives the notification: the most recent output line is pushed into
`progress.report({ message })`, so the progress box shows `#8 [4/9] RUN npm install`
instead of standing still. `Sandbox: Show Log` (`sandboxConsole.showLog`) reveals the
channel, sits in the Sandboxes view's overflow menu, and is offered as an action on the
busy warning and on every error notification.

Two deliberate consequences:

- **Discovery calls stay out of the channel unless they fail.** `sbx ls --json`,
  `template ls`, and the `--help` probes run on focus change and tree render; logging
  them would bury the operations. Logging their *failures* is a net gain — several of
  them currently swallow errors (`templateExists` returns `false`, `listSecrets` returns
  `[]`), so a broken CLI degrades silently today.
- **Secret values never reach the channel.** `runWithStdin` (`secretSet`, `ghAuthLogin`)
  keeps its own non-streaming path: the header is logged, the piped value is not, and
  neither is the child's output. FR-032's "never in argv, never in an env var" gains
  "never in the log".

**FR-056: cancellable long operations.** `ops.withProgress` takes a `cancellable` flag and
threads the `CancellationToken` into the spawn runner, which kills the child on cancel (on
Windows via a `taskkill /T` process-tree kill — `child.kill()` leaves grandchildren
running). Cancellation applies to the operations that are actually long — image
build/refresh and `sbx create`; `sbx stop` and `sbx rm` stay non-cancellable, because
interrupting them is strictly worse than waiting for them.

The runner itself stays cancellation-agnostic: a killed child exits non-zero like any
other failure, and `withProgress` — which owns the token — converts that into a
`Cancelled`. That is what makes cancelling *any* rebuild stage abandon the whole rebuild
rather than fall through to the next one. `rebuildRef` tracks what each stage leaves
behind and re-raises `Cancelled` with it, so the report names the resulting state instead
of pretending the sandbox is untouched: cancelled during the build, the sandbox is still
there; cancelled after the removal, the previous instance is gone and Connect recreates
it.

**Kill only what is safe to kill — sbx children are never killed.** Manual acceptance
found this in two steps, and the second overturned the first.

The first symptom: killing `sbx create` stops the CLI but not the backend, so the sandbox
came up seconds later — cancel produced a *running* sandbox the user had just asked not to
create. The obvious answer was a rollback, and it worked: `createSandbox` caught its own
`Cancelled` and removed the sandbox with `sbx rm --force`, exit 0.

The second symptom killed the approach. The next create under that name failed with
`create runtime: sandboxd error: status 500: failed to create network: Error response
from daemon: already exists` — and kept failing. The kill had landed during
*Configuring Docker*, leaving a network inside the sbx runtime; `sbx rm` removed the
sandbox record but not that network, and afterwards `sbx rm` reported the name as
"not found" while the network kept rejecting every create. That daemon is not the host's
docker (host `docker network ls` shows nothing), so the network is unreachable from
outside; `sbx diagnose` passes 7/7 without noticing it; and the only tool that clears it
is `sbx reset`, which destroys every sandbox on the machine. **The name was poisoned
permanently — a far worse outcome than the slow, silent rebuild this iteration set out to
fix.**

The upstream tracker confirms the mechanism and that it is not ours to fix:
[#129](https://github.com/docker/sbx-releases/issues/129) documents the same leak from a
`sbx stop` that outran the CLI's own 120s timeout — *any* cleanup interrupted after the
runtime entry is deleted but before the container/network/volume are gone claims the name
forever — and [#353](https://github.com/docker/sbx-releases/issues/353) states the only
documented recovery is a full `sbx reset`. All open, no released fix at v0.31.3. So
interrupting sbx mid-flight is not a thing to do carefully; it is a thing not to do.

`sbx.run` therefore sets `killOnCancel: false` for every sbx invocation: cancelling waits
for the command to finish and `ops.rollbackCreate` then removes the completed sandbox — a
clean removal, because sbx itself finished and knows every resource it made. `docker`
calls keep their kill, since cache layers are harmless. The progress box switches to
"Cancelling…" the instant the button is pressed so the wait is not read as an ignored
click. The create-stage detail is more specific than `rebuildRef`'s stage note, so it wins
when both exist. `sbx.explainCreateFailure` recognises the leaked-name 500 and answers it
with the cheap way out (change the sandbox's `key`) instead of a raw daemon error.

## Decisions

- **The guard reports, it does not queue.** Attaching the second click to the first
  operation's promise would look like it worked and then produce one result for two
  requests. Naming the in-flight operation — with a link to its log — is the honest
  answer, and it is what makes the doubled Rebuild impossible rather than merely
  invisible.
- **The guard lives in `ops.ts`, not in the command layer.** Confirmation prompts stay in
  the command layer (spec 008's split); the mutual exclusion belongs with the work.
- **A plain output channel, not a `LogOutputChannel`.** Level-prefixed, timestamped lines
  are right for a trace and wrong for streamed `docker build` output, which users read as
  build output. The channel formats its own headers and passes child output through
  verbatim.
- **A channel, not a terminal.** Terminal-first (§4 of Features) governs *agent
  interaction*; a build log is not an agent session, and a real terminal would compete
  with the sandbox terminals for the panel and die with the operation.
- **Cancel never kills a process whose partial state its own tooling cannot clean up.**
  Neither CLI's death stops its backend, but the residues differ in kind. An abandoned
  `docker build` leaves cache layers — harmless, even useful, so it is killed freely and
  the message never claims the build was reverted. A half-killed `sbx create` leaves
  runtime state only `sbx reset` can clear, so it is not killed at all: it runs to
  completion and is then removed. The rule is not "kill and hope" but "return to the state
  the operation started from, by a route that tooling can actually complete" — and where
  that costs latency, latency is the cheaper thing to spend.
- **The cancel that has to wait must say so.** Because the sbx child keeps running, the
  progress box would otherwise look identical to an ignored click for the whole wait. It
  reports "Cancelling…" immediately and prefixes the streamed lines afterwards.
- **The form gets feedback, not a second guard.** The host-side `saving` flag already
  prevents a double submit correctly; the defect is purely that the webview never showed
  it. FR-054's UI half is about making an existing guarantee visible.
