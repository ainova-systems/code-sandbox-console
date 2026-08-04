# 008 — Lifecycle Progress Feedback

> **Iteration spec — immutable history.** Describes what changed in this iteration and
> why. The current truth lives in [`../../Architecture.md`](../../Architecture.md) and
> [`../../Features.md`](../../Features.md); where this spec disagrees with them, they win.
>
> **Period:** 2026-06-11 · **Base:** `main` after spec 007
>
> **Status: shipped with this iteration** (`ops.ts` `withProgress` helper applied across
> every lifecycle op). Architecture §12 and Features §10 carry the current truth.

## What & why

Only two lifecycle steps surfaced a progress notification: the image build/rebuild and
Stop. The rest of the slow `sbx` work happened silently — programmatic `sbx create`
(Connect/Shell on an absent sandbox, Recreate after Rebuild) and `sbx rm` (Delete
instance, Remove from config, the recreate half of Rebuild) — so clicking those actions
left a several-second gap with no on-screen sign that anything had started. Users
reasonably read silence as "my click didn't register" and click again.

The image-rebuild box was already the right pattern; the fix is to apply it uniformly to
every long-running lifecycle action so each click gives instant feedback.

## What changed

- **One spinner helper in `ops.ts`.** `withProgress(title, task)` wraps
  `vscode.window.withProgress` at `ProgressLocation.Notification`, non-cancellable. The
  existing `ensureImageForRef` and `stopRef` boxes were refactored onto it (no behaviour
  change); a `createSandbox(ref, workspace)` helper wraps `sbx create` as
  *"Creating sandbox `<name>`…"*.
- **Create now shows a box.** `createOrAttach`, `rebuildRef`, and `shellRef` call
  `createSandbox` instead of `sandbox.create`, so the secrets/recreate paths that build
  the sandbox before attaching no longer run silent.
- **Stop / Delete / Recreate wrap terminal disposal too.** `stopRef`, `destroyRef`, and
  Rebuild's recreate step run `disposeSandboxTerminals` (up to ~4s) *inside* the spinner,
  so the box appears the instant the action is clicked — not only once the CLI call
  starts. Titles: *"Stopping `<name>`…"*, *"Removing sandbox `<name>`…"*.
- **All callers benefit.** Palette commands, the Explorer's per-node actions, and the
  New/Edit form all route lifecycle work through `ops.ts`, so the feedback is uniform
  without touching three call sites.

## Decisions

- **Interactive secret entry stays outside the spinner.** A progress notification must
  never compete with a modal input box, so the order is fixed:
  *build/create behind a spinner → prompt for missing secrets (FR-032) → attach a
  terminal*. The spinner wraps only the non-interactive `sbx` calls.
- **Terminal-based attach/resume and shells get no separate spinner.** `sbx run`
  (Connect on an existing sandbox) and `sbx exec` (Shell) open a native terminal
  immediately, and that terminal is its own progress surface — wrapping it would flash a
  redundant box for a millisecond.
- **Rebuild disposes terminals just before `sbx rm`, not before the image build.** The
  image build doesn't touch the running sandbox, so the agent terminal now stays live
  during the (potentially long) build and is closed only at the recreate — both cleaner
  UX and still exit-popup-safe (disposal completes before `sbx rm`).
- **No new FR.** This is a cross-cutting UX invariant over the existing lifecycle FRs
  (FR-003/004/005/006/007), recorded in Architecture §12 rather than as its own FR.
