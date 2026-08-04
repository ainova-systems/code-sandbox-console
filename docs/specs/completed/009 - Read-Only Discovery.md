# 009 — Read-Only Discovery

> **Iteration spec — immutable history.** Describes what changed in this iteration and
> why. The current truth lives in [`../../Architecture.md`](../../Architecture.md) and
> [`../../Features.md`](../../Features.md); where this spec disagrees with them, they win.
>
> **Period:** 2026-06-12 · **Base:** `main` after spec 008
>
> **Status: shipped with this iteration.** Discovery (status bar + Sandboxes view) and
> activation no longer write into `.sandbox/`; Architecture §5/§6/§13 and Features
> FR-002 carry the current truth.

## What & why

Opening a workspace could silently create files under `.sandbox/`, even when the user
had no intention of running a sandbox in that checkout:

- The Sandboxes view's render path called `ensureIdentity`, so merely showing the tree
  (which can happen on activation) wrote `.sandbox/identity.yaml` and `.sandbox/.gitignore`
  whenever a committed `config.yaml` existed.
- Activation refreshed the generated project CLI by calling `ensureProjectScript`
  unconditionally, so opening a committed-recipe project (re)wrote
  `.sandbox/scripts/sbx.sh` and its `.gitattributes`.

For a shared repo whose `config.yaml` is committed by the team, a teammate who only
wanted to read code got an `.sandbox/` littered with untracked local files on open. That
contradicts FR-002's promise that discovery is passive: **opening a workspace should
observe, never mutate.** Files belong to the moment the user creates their first sandbox.

## What changed

- **The Sandboxes view lists the recipe read-only.** `tree.ts` `load()` now reads the
  identity with `readIdentity` instead of creating it with `ensureIdentity`. Without an
  identity nothing can have been created for this working copy, so every recipe entry is
  rendered **absent** (icon `add`, tooltip *"`<title/key>` — not created"*) and the
  `sbx ls` probe is skipped entirely. No `.sandbox/` write happens on render, focus
  change, or terminal open/close.
- **Node actions resolve identity lazily — and only the create/connect ones.** A
  `SandboxNode` now carries its `spec` and an *optional* `ref` (present only when an
  identity already existed at render time). The create/connect actions (Connect, Shell,
  Stop, Rebuild, Delete instance) go through `withNode()`, which resolves a missing ref
  via `ensureIdentity` + `primaryRef(…, node.key)` at click time — so `identity.yaml`
  (and the rest of `.sandbox/`) is written on the first create, exactly when it should be.
  The **recipe-only** actions (Edit, Remove from config) go through a separate
  `withRecipeNode()` that operates on `node.key`/`node.spec` and **never** creates an
  identity — editing or removing a definition is not "first use". Remove still destroys a
  live instance, but only via an already-resolved `node.ref`; with no identity none can
  exist, so there is nothing to destroy.
- **Validation survives the no-identity path.** `refs()` validates the recipe's
  argv-bound fields (`assertAgentId`/`assertImageTag`) as a side effect, and it is skipped
  when no identity exists. Those checks are factored into `sandbox.assertSpecsValid()` and
  run on the no-identity branch too, so a malformed `config.yaml` still renders as a single
  `ConfigErrorNode` immediately rather than looking valid until the first action.
- **The project CLI is refreshed, not created, on activation.** `ensureProjectScript`
  takes `{ createIfMissing }` (default `true`, used by form save so the first sandbox
  seeds the script). Activation passes `createIfMissing: false`: an already-present
  `sbx.sh` is still refreshed on a version upgrade, but a missing one is **not** created
  merely by opening the project.

## Decisions

- **First use = first create, not first open.** The trigger for writing `.sandbox/`
  artefacts is an explicit lifecycle action (New Sandbox save, or Connect/Shell on a
  node), never activation or a passive view render. No separate "Init sandbox" button is
  introduced — initialisation is implicit in the create flow the user already takes.
- **Read-only checkouts now list, not blank.** Because discovery no longer needs to write
  `identity.yaml`, a read-only checkout (where the write used to fail) renders the recipe
  as a normal absent tree instead of falling back to the empty "No sandboxes yet" welcome.
- **Provisional names aren't fabricated.** Before an identity exists the exact sbx name
  (`<name>-<key>-<id>`) is unknown, so absent nodes show the display label and "not
  created" rather than inventing an `<id>` that would not match the eventual sandbox.
- **No new FR.** This strengthens FR-002 (discovery is not just silent but non-mutating)
  and is recorded in Architecture §5/§6/§13; the lifecycle FRs are unchanged.
