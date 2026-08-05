# 014 — Truthful Recipe State

> **Iteration spec — immutable history.** Describes what changed in this iteration and
> why. The current truth lives in [`../../Architecture.md`](../../Architecture.md) and
> [`../../Features.md`](../../Features.md); where this spec disagrees with them, they win.
>
> **Period:** 2026-07-29 · **Base:** `main` after spec 013
>
> **Status: shipped with this iteration.** Features FR-009/FR-057 and Architecture
> §4/§6/§12/§14 carry the current truth.

## What & why

Spec 013 made *operations* honest — what is running, how to stop it, that it runs once.
Acceptance for it then produced three failures that share a different root: the recipe and
the names derived from it go stale or collide, and the UI keeps acting on the old value.
All three were observed in one session on a real project.

**The Explorer does not notice a recipe edited on disk.** `tree.ts` resolves a node's
`SandboxRef` — and therefore its `key` — when the tree renders, and only refreshes on
focus change, terminal events, and lifecycle completion. Editing `.sandbox/config.yaml`
outside VS Code (or in another window) leaves nodes carrying the previous `key`, so
Connect goes out under the *old* sandbox name until something happens to refresh. Observed
consequence: a sandbox key was renamed to escape an unusable name, Connect was clicked
immediately, and it failed under the old name — which read as "renaming does not help" and
cost several wrong conclusions before the stale node was found. The recipe is a committed
file the docs actively tell people to edit by hand (FR-009), so editing it outside the form
is a supported path, not an edge case.

**New-sandbox keys recycle.** The form derives a new key from the agent id and takes the
first free one — `claude`, then `claude-2`, `claude-3`. The rule keeps the key independent
of the mutable `title`, which is right, but the *source* being the agent id has two costs.
Sandbox names read `tomis-next-claude-2-37ab1` rather than anything about the sandbox; and
because the search is a dense counter over a tiny namespace, **a key freed by a rename or a
removal is immediately handed to the next new sandbox**. In the session above that reissued
a key whose sbx name was permanently unusable (Architecture §14 / upstream
[#129](https://github.com/docker/sbx-releases/issues/129)) moments after the rename that
escaped it — the fix walked straight back into the fault.

**Nothing remembers an unusable name.** When `sbx create` fails because the name is claimed
by leaked runtime state, spec 013 explains the failure well (`explainCreateFailure`) but the
extension forgets it immediately. The same name can be derived again, and will be.

The through-line: the recipe is treated as a snapshot taken once and as a namespace with no
memory. Both assumptions are cheap to hold and both were observed producing wrong actions.

## What changed

**FR-009 (extended): the Explorer follows the recipe.** A `FileSystemWatcher` over
`.sandbox/*.yaml` (the recipe and `identity.yaml`), held by `extension.ts` and debounced
300 ms, refreshes the status bar and fires `sandboxConsole.refresh` — which drops the
tree's cached refs — so a recipe edited on disk takes effect without a manual Refresh.
Read-only discovery is preserved (FR-002): the watcher observes, it never writes.

**FR-057: new-sandbox keys derive from the title.** At *creation only*, the key is derived
from the entered title, sanitised to the key charset (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, capped
at 40 chars) — `Backend API (v2)` → `backend-api-v2` — falling back to the agent id when the
title is empty or sanitises away (e.g. a fully non-ASCII title). The uniqueness suffix stays
for genuine collisions. The key remains **frozen** afterwards: the form already locks it in
edit mode, so renaming a title never touches the sandbox name, generated Dockerfile, or
image tag. The invariant was only ever "the key must not *track* the title"; seeding it
once does not violate that, and the previous wording conflated the two.

Consequence to accept deliberately: the default Dockerfile name follows the key
(`<key>.Dockerfile`), so two Claude sandboxes no longer *default* to one shared
`claude.Dockerfile` and one shared image. Sharing stays available — typing the same file
name in both is still how it is expressed, and is now explicit rather than accidental.

**FR-057: unusable names are remembered.** `sbx.ts` now raises the leaked-state 500 as a
typed `NameClaimedError` (so no caller re-parses CLI output), `ops.ts` records the name in
the new `names.ts` — per working copy, `workspaceState` — when a create fails with it, and
key derivation skips any candidate that would produce a recorded name. This is a workaround
for an upstream defect with no released fix, so it is scoped, local, and self-limiting: it
stores names (capped at the last 50), never removes sandboxes, and a `sbx reset` simply
makes the list irrelevant.

## Decisions

- **Watch the recipe, do not poll it.** Discovery is already event-driven and silent
  (FR-002, spec 009); a watcher fits that model, a timer would reintroduce background
  `sbx ls` traffic for a file that changes rarely.
- **Derive the key at creation, freeze it forever.** The alternative — keeping the key in
  sync with the title — would rename sandbox names, Dockerfiles and image tags under a live
  instance, which is exactly what the original rule existed to prevent.
- **Remember unusable names rather than probing for them.** There is no way to ask sbx
  whether a name is claimed by leaked state: `sbx ls` does not list it and `sbx rm` reports
  "not found" (Architecture §14). Observed failure is the only available signal.
- **Local, not committed.** The record is a property of one machine's sbx runtime, not of
  the project, so it belongs in `workspaceState` beside the identity — never in the
  committed recipe.
