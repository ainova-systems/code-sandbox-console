# 016 — Preflight Readiness UX

> **Iteration spec — immutable history.** Describes what changed in this iteration and
> why. The current truth lives in [`../../Architecture.md`](../../Architecture.md) and
> [`../../Features.md`](../../Features.md); where this spec disagrees with them, they win.
>
> **Period:** 2026-08-10 · **Base:** `main` after spec 015
>
> **Status: shipped with this iteration.** The extension states which prerequisite is
> missing instead of going quiet, and asks for host Docker only where it actually needs it;
> Features FR-059 and Architecture §4/§5/§7 carry the current truth.

## What & why

When `sbx` is not installed, the extension does not fail — it **disappears**, and every
surface tells the user something that is either nothing or false:

- **The status bar hides itself.** `refreshStatus()` bails to `statusItem.hide()` both when
  `sbx.available()` is false and when the later `sbx ls` throws (the not-signed-in case).
  Two distinct, fixable problems render identically to "the extension is not installed".
- **The Sandboxes view claims the repo has no sandboxes.** With no CLI, `load()` returns an
  empty tree and VS Code renders the `viewsWelcome`: *"No sandboxes yet for this repo."*
  That is false whenever the committed `config.yaml` (FR-009) defines sandboxes — and it
  points at **New Sandbox**, the one action that cannot work. The malformed-recipe case
  already refuses to lie here (`ConfigErrorNode`, spec 014); the missing-prerequisite case
  has no equivalent.
- **New Sandbox refuses without explaining.** The refusal itself is correct and already in
  place — `preflight()` runs before the form opens, so nothing is written to `.sandbox/` —
  but it is delivered as a non-modal notification that auto-dismisses. The user clicked a
  button, no form appeared, and seconds later the only explanation is gone.

The second half is the **Docker requirement, which the code overstates and mistimes.**
Upstream is explicit — *"Docker Desktop is not required to use `sbx`"*
([get-started prerequisites](https://docs.docker.com/ai/sandboxes/get-started/)): sbx runs
its own daemon and each sandbox carries its own inner Docker (Architecture §3). Host Docker
is needed **only where this extension itself invokes it** — the FR-008 custom-image build
(`docker build` → `docker save`) and the FR-053 image refresh (`docker pull`). Two
consequences today:

- The probe is wrong for the question it answers. `dockerAvailable()` runs `docker
  --version`, a client-only command that succeeds while the engine is stopped, so a "yes"
  does not mean a build can run. The real failure lands minutes later inside `docker build`.
- The requirement is invisible until it bites. A user picks *Custom: Dockerfile* in the
  form, fills everything in, presses Create, and only then learns that host Docker is
  needed at all.

Readiness is the first thing a new user meets. FR-002 makes **discovery** silent — silent
about sandboxes, not about a missing prerequisite.

## What changed

- **FR-059 Prerequisite readiness** (new): the extension states, on every passive surface,
  which prerequisite is missing and what to do about it — and blocks the actions that
  cannot work rather than letting them fail deep inside the CLI.
- **Readiness is asked of the installation itself.** The spec was drafted planning to infer
  it (a `version` probe, then guessing at `ls` stderr for the signed-out case). The CLI
  already answers it properly: `sbx diagnose -o json` reports CLI binary, daemon, version
  match, storage directories, directory permissions, socket and authentication, each with a
  `status`, a `message` and the CLI's own `hint`. Measured at ~480 ms — the same as the
  `sbx version` probe it replaces, since the cost is process start-up — so it sits on the
  passive path unchanged. `sbx.diagnose()` runs it; `prereq.ts` classifies it as **missing**
  / **signed-out** / **unhealthy**. Only a `fail` blocks; a `warn` does not.
- **The status bar never hides for a readiness reason.** It renders
  `$(warning) Sandbox not available` with a tooltip naming the missing piece and its remedy,
  and clicking it re-runs the report. `sbx` not found names the paths that were searched, so
  "installed, but not where we look" is diagnosable; signed-out asks for `sbx login` in the
  CLI's own words. Unchanged: no workspace → hidden; no recipe → `+ New Sandbox`.
- **New Sandbox refuses in a modal, not a toast.** The form still does not open. The dialog
  names the missing prerequisite, the expected install path, the `sbx login` follow-up, and
  carries **Install instructions** → <https://docs.docker.com/ai/sandboxes/>. Same shape as
  the FR-058 mount refusal and `showInvalidConfig`: modal because it ends the action the
  user just asked for.
- **The Sandboxes view says what is wrong instead of "No sandboxes yet".** A single
  readiness node replaces the empty tree — the `ConfigErrorNode` pattern, with the same
  click-to-act affordance. The same node covers an `sbx ls` that fails after readiness
  passed: rendering every entry as *not created* asserts a state nobody read, and
  contradicts the status bar, which reports that failure.
- **A `Sandbox: Check Prerequisites` command** re-runs the report — what the warning
  indicator and the readiness node open, and what makes an install or a `sbx login` take
  effect without reloading the window.
- **Host Docker is checked where it is required, and only there.** No global Docker
  preflight is added: it is not a prerequisite of the product. The New/Edit form states it
  inside the *Custom: Dockerfile* block, which is the **only** mode that needs it — a
  *Custom: image* is pulled by sbx itself, and the FR-053 refresh that does use `docker
  pull` already fails open. `dockerAvailable()` becomes `dockerState()`: `docker --version`
  for *installed*, then `docker info` for *engine reachable*, because the client-only
  `--version` succeeds while the engine is stopped. The notice is advisory — the build stays
  the gate, since Docker Desktop may be started in between.
- **The executable is resolved on every call.** `sbxPath()`/`dockerPath()` memoised their
  result for the lifetime of the extension host. Where the CLI lives is precisely what changes
  under a running extension — an install, a move, an uninstall — and a remembered answer
  survives all of them: a remembered *miss* kept a window that was open during an install
  broken until reload (its environment block, `PATH` included, predates the installer), and a
  remembered *hit* would outlive the binary it points at. Both caches are gone rather than
  revalidated: if correctness needs an `existsSync` on every call anyway, the memo buys
  nothing — and it sits in front of a `spawn` that costs three orders of magnitude more.

## Decisions

- **Docker is a conditional prerequisite, so its message is conditional too.** Putting
  Docker in the status bar or the New Sandbox refusal would assert a requirement upstream
  says does not exist. It belongs next to the choice that creates it.
- **No per-OS install command is executed or printed.** The extension links Docker's own
  page, which branches by platform; `sbx` has no official one-line installer. README's
  platform note already marks macOS/Linux untested — hardcoding install steps would be
  least reliable exactly where confidence is lowest.
- **Block, do not degrade.** The New Sandbox form is not opened in a disabled state: its
  agent and secret-service lists come from live `sbx` discovery and would silently fall back
  to the static registries, and Save would write a recipe entry for a sandbox that cannot be
  created. A form that cannot do its job is worse than a dialog that says why.
- **Readiness is not discovery.** FR-002 is unchanged and still holds: nothing here raises a
  notification on open or writes into `.sandbox/`. The status bar and the view already
  render passively — only what they render changes.
- **The status bar stays a single item.** No second "prerequisites" indicator: the missing
  CLI is a state of the same thing the item already reports.

- **Ask the tool, do not reverse-engineer it.** The drafted plan inferred readiness from a
  failed `ls` plus a regex over stderr. `sbx diagnose` is the supported, machine-readable
  answer to exactly this question, it names the broken check, and its `hint` is Docker's own
  remedy wording rather than ours. The open question the draft carried — how to recognise
  "not signed in" — dissolved: it is a named check with a status.
- **An unknown failed check is reported, not swallowed.** Classification matches check names
  (`/auth/i`, `/binary|cli/i`); anything else is surfaced verbatim as *unhealthy* with the
  CLI's message and hint. A future sbx that renames or adds a check therefore degrades to a
  correct-but-generic refusal instead of an "unknown error" or, worse, a false ready. The
  residual risk is recorded in Architecture §14.
- **An sbx too old for `diagnose` is ready, not broken.** The fallback is the previous
  `version` probe. This check exists to explain a broken install; it must not become a
  version requirement of its own.

## Verification

`npm run verify` green. Probed against sbx v0.31.3 on Windows 11 before writing the code:
`diagnose -o json` returns the seven checks quoted above and costs 464-495 ms across runs
(`version` 474-486 ms, `ls --json` 475-767 ms), and a spawn of the bare `sbx.exe` name off
PATH fails with `ENOENT`, which is the path the "not found" branch takes. The
not-signed-in and engine-down branches were **not** reproduced live — doing so means
signing out of Docker or stopping Docker Desktop on the machine — so they rest on the
report's own `status` field; the unknown-check fallback above is what keeps that safe.
Manual acceptance in a real window is the `ext-run-local` step and goes into the PR's
"How to Verify".
