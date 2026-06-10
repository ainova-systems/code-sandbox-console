# 004 — Default Sandbox Picker (FR-050)

> **Iteration spec — immutable history.** Describes what changed in this iteration and
> why. The current truth lives in [`../Architecture.md`](../Architecture.md) and
> [`../Features.md`](../Features.md); where this spec disagrees with them, they win.
>
> **Period:** 2026-06-10 · **Base:** branch `feature/open-source-readiness`

## What & why

Local `.vsix` testing surfaced a UX gap: the status bar item read **"Claude Sandbox"**
— the agent label of the *first* recipe entry — instead of the sandbox's own name, and
there was no way to choose which sandbox the status bar and the single-action palette
commands (Connect/Stop/Shell/Rebuild) target.

## What changed

- **Status bar shows the active sandbox by display name** (`title || key`, matching the
  Explorer), with the state icon; the agent moved into the tooltip.
- **Clicking the status bar (or `Sandbox: Switch Sandbox`) opens a picker**: one defined
  sandbox connects directly; several show a Quick Pick of all recipe sandboxes (state +
  agent + default marker) plus a "New Sandbox…" entry; none routes to the New Sandbox
  form. Picking a sandbox connects to it and makes it the **locally active** one.
- **Three-level resolution of the active sandbox** (FR-050): locally last-picked key
  (per working copy, `workspaceState`) → the recipe's `default: true` entry (committed,
  shared, settable via a checkbox in the New/Edit form — single default per recipe) →
  the first recipe entry.
- Startup discovery messages use the same display name
  (`Sandbox Backend (Claude) found · running`).

## Decisions

- `default` is a committed recipe field (team-shared starting point), while the
  last-picked key is deliberately local — different developers work on different
  sandboxes of the same repo.
- The palette single-action commands follow the same resolution rather than growing
  their own pickers; the Explorer remains the surface for operating on a specific
  non-active sandbox.
