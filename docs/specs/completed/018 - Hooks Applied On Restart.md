# 018 — Hooks Applied On Restart

> **Iteration spec — immutable history.** Describes what changed in this iteration and
> why. The current truth lives in [`../../Architecture.md`](../../Architecture.md) and
> [`../../Features.md`](../../Features.md); where this spec disagrees with them, they win.
>
> **Period:** 2026-08-20 · **Base:** `main` after spec 017
>
> **Status: shipped with this iteration.** FR-060's `startup`/`services` now take effect on
> the next start; the frozen-list rule, the Rebuild-to-change-a-command rule and
> `Run Hooks Now` are gone. Features FR-060/FR-007 and Architecture §4–§7, §12–§14 carry the
> current truth.

## What & why

FR-060 shipped with a rule nobody should have to hold in their head: the hook **list** is
bound when the sandbox is created (`sbx create --kit`), so editing `startup:` in the recipe
changed nothing until a **Rebuild** — a destructive recreate that costs the VM's state and,
under `mount: clone`, any uncommitted work in the private clone. `Run Hooks Now` softened
that by running the current commands once, but it could not persist them, so it produced the
one state this codebase refuses to ship elsewhere: **what runs now differs from what will run
next time**, with a notification left to explain the gap.

The expectation is the obvious one: *change the script, restart the instance, the hooks are
what I just wrote.* This iteration makes that true.

The realisation is that only the command **text** is frozen, not the behaviour. sbx bakes a
startup command at creation and replays it verbatim on every start — so the kit should carry
a **bootstrap** that runs a generated script, and the script is what changes. The pattern is
already the one this feature recommends to users (point a hook at a committed script, edit
the script freely); this applies it to the hook list itself.

`setup` stays creation-time by definition — it is the install phase, it has already run, and
re-running it is what a Rebuild is for.

## What changed

- **The kit carries a bootstrap, not the commands.** `kits.ts` renders a single startup
  entry, `bash "$SANDBOX_SOURCE/.sandbox/kits/<key>/startup.sh"`, and generates that script
  from the recipe's `startup` + `services` beside the kit. Under `mount: clone` the script is
  read from the read-only host tree (`/run/sandbox/source`), which is always the current one;
  under `direct` it is the workspace itself. `setup` is still rendered as literal
  `commands.install` entries — that phase cannot be re-run anyway.
- **The script is regenerated on every start path**, not only at create: Connect, Shell and
  Rebuild all rewrite it before the sandbox starts, so a recipe edited by hand (or pulled
  from git) is picked up by the next start with no further action. The generated CLI does the
  same in its connect path (FR-052).
- **`Run Hooks Now` and `sbx kit add` are gone.** With edits applying on restart, the action
  had nothing left to offer that Stop → Connect does not, and it was the only surface whose
  effect did not survive a restart. `kitAdd` leaves `sbx.ts` with it — one less dependency on
  an experimental upstream command.
- **The Edit form stops asking for a Rebuild for hook changes.** A changed `startup`/
  `services` list saves and says it applies on the next start; a changed `setup` list is the
  only hook change that still offers a Rebuild, and says why.
- **Hook results are read from the runner's own log, truncated per run.** The script writes
  `ok`/`fail <command> exit=<n>` lines to `/tmp/sandbox-console-hooks.log`, starting each run
  by truncating it, so the file always describes exactly the current start. That deletes the
  timestamp/baseline reasoning `reportStartupHooks` needed to tell this start's dispatcher
  block from the previous one, and the failure warning keeps working as before.
- **Services are backgrounded by the runner**, since the single bootstrap entry is a
  foreground command: each `services` entry is started detached with its output captured into
  its own file (an endless service must not flood the log the report reads). A service that
  is gone a second later is reported as `fail … exited immediately` with its output quoted
  into the main log — it does not stop the remaining hooks, but it is never called *started*,
  and the run's end marker says how many failed to come up.
- **A missing runner script fails loudly.** The bootstrap refuses with a message naming the
  file and the fix (Connect from VS Code, or `sbx.sh connect`, regenerates it) instead of
  silently starting a sandbox with no hooks — the kit directory is a gitignored artefact, so
  a fresh clone legitimately starts without one.

## Decisions

- **Restart is the apply mechanism, and it is the only one.** No second path, no one-shot
  action, no drift dialog: one rule the user can state back — *hooks are what the recipe said
  at the last start*.
- **`setup` deliberately keeps the old rule.** Applying an install command to a sandbox that
  already exists is not a phase sbx has, and pretending otherwise is what this iteration is
  removing everywhere else.
- **The runner script is generated, never authored.** It lives beside the generated kit,
  under the same gitignored `.sandbox/kits/<key>/`, and is rewritten from the recipe on every
  start path — a hand-edited copy is not a supported input.
- **Accepted against the real CLI before shipping.** A clone-mode sandbox was created with
  the bootstrap kit (six `startup` commands + one service, all `ok`, service heartbeating);
  the runner on the host was then regenerated with an extra command and the sandbox merely
  **restarted** — the new `startup[7]` ran, the hook log contained only that run, and the
  service came back with a new pid. No Rebuild, no second action.
- **The dispatcher's own log stays as a fallback, not the source.** sbx still records the
  bootstrap's overall `ok`/`fail` in `/var/log/sbx-kit-startup.log`; the extension reads its
  own per-command log first and falls back to the dispatcher's line when the runner never got
  far enough to write one.
