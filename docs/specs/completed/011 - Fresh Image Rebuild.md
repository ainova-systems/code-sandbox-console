# 011 — Fresh Image Rebuild

> **Iteration spec — immutable history.** Describes what changed in this iteration and
> why. The current truth lives in [`../../Architecture.md`](../../Architecture.md) and
> [`../../Features.md`](../../Features.md); where this spec disagrees with them, they win.
>
> **Period:** 2026-07-28 · **Base:** `main` after spec 010
>
> **Status: shipped with this iteration.** Features FR-053 (and the updated FR-007/FR-008)
> and Architecture §7/§11 carry the current truth.

## What & why

Rebuild promised a fresh sandbox but reused stale images at every layer, so a rebuilt
sandbox came back with a months-old agent CLI and no way to update short of `sbx reset`
(which destroys every sandbox on the machine):

- The **sbx template store** caches the default agent images
  (`docker/sandbox-templates:<flavor>`): the first create pulls, every later create reuses
  the cache. Observed live: a claude template over a month old. `sbx` v0.31.3 has no
  `pull`/`update` command and no `--pull` flag; per the upstream docs the cache is cleared
  only by `sbx reset`.
- **Custom Dockerfile builds** ran `docker build` without `--pull`, so the
  `FROM docker/sandbox-templates:<flavor>` base came from the host docker cache (observed:
  7 weeks old). Rebuild faithfully rebuilt new layers on an old base.
- **Pulled custom images** (`image` without `dockerfile`) were fetched only when missing
  from the store, never refreshed.

Existing sandboxes are persistent microVMs and are never touched by an image refresh —
a fresh template affects only sandboxes created or rebuilt after it. The store is
machine-global, so other projects' future creates also pick up the refreshed default
images; that is normal image-cache behaviour.

## What changed

**FR-053: Rebuild always starts from the freshest obtainable image.** Per environment
kind:

- **Custom Dockerfile** — `docker build` now runs with `--pull`, so the agent base image
  is re-fetched before layers rebuild. A failed pull fails the build (unchanged hard-gate
  semantics).
- **Pulled custom image** (`image`, no `dockerfile`) — the rebuild runs
  `docker pull` → `docker save` → `sbx template load` to replace the stored template.
  Best-effort: when the pull fails (offline, or a local-only image such as one loaded by
  hand), the rebuild warns and continues from the cached template. The template is never
  removed, because a local-only image would be unrecoverable.
- **Default agent image** — before recreating, the rebuild removes the matching
  `docker/sandbox-templates` entries (flavor prefixed by the agent id) from the sbx store
  via `sbx template rm`, so the create that follows re-pulls the current image. These are
  Docker-registry images by definition, so removal is safe; offline the create fails with
  the CLI's own clear error.

Supporting changes:

- `src/sbx.ts` gained `templateList()` (parsed `sbx template ls`) and `templateRemove()`,
  keeping every CLI string in the wrapper module.
- `src/images.ts` owns the refresh policy (`refreshForRebuild`), the `--pull` build, and
  the extracted `saveAndLoad` used by both the build and the pull paths.
- `src/ops.ts` `rebuildRef` runs the refresh behind the existing progress notification and
  surfaces the cached-image fallback as a warning, never as a failure.
- The generated `.sandbox/scripts/sbx.sh` mirrors the same semantics in `cmd_rebuild`
  (`refresh_image` + `docker build --pull`), per the script-parity carve-out.
