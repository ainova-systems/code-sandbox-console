---
name: ext-add-feature
description: Implement one FR-scoped change end to end - module choice per the dependency map, package.json contributes for new commands, canonical docs synced, verify green. Use for any feature or behaviour change after its spec exists (run spec-new-iteration first for substantial changes).
---

# ext-add-feature

The repeatable unit of work in this repo: one FR-scoped iteration, from spec to green verify.
CLAUDE.md is the rule surface - this skill sequences it, it does not replace it.

## Steps

1. **Anchor**: read the iteration spec (or run `spec-new-iteration` if the change is substantial
   and has none), the FR entries it cites in `docs/Features.md`, and the touched sections of
   `docs/Architecture.md`.
2. **Choose modules** with the CLAUDE.md "Module map" and its dependency direction. Hard
   containment rules:
   - Every child-process `sbx` string lives in `src/sbx.ts`; interactive `run`/`exec` shellArgs
     live in `src/terminal.ts`. One carve-out: the bash template in `src/script.ts` renders sbx
     calls for external shells - keep it in sync when CLI shapes change, the extension never
     executes it.
   - Nothing may import from `extension.ts`.
3. **New command?** Then all three together: `contributes.commands` (+ menu/when clauses) in
   `package.json`, registration in `src/extension.ts`, and the shared flow in `src/ops.ts` if
   both palette and Explorer need it.
4. **Respect the traps** (they are documented in CLAUDE.md, they bite anyway): esbuild does not
   typecheck - only `npm run verify` proves the code; there is no `sbx start` - resume is
   `sbx run`; `/home/agent/workspace` is a decoy - the real mount is the translated host path;
   `sbx` is not on PATH on Windows.
5. **Protect the invariants**: attach ("Connect") stays the primary action when a sandbox
   exists; no implicit default sandbox; terminal-first (no chat panels); secrets only over
   stdin, never argv/env/image; argv allowlist and path containment stay intact.
6. **Sync the docs in the same change**: update `docs/Features.md` and `docs/Architecture.md`
   per the spec's docs-sync checklist, and flip the spec status to shipped. Cite `FR-0xx` in
   code comments where the code carries the requirement.
7. **Verify**: `npm run verify` must exit 0.

## Hand-off

`dev-review-changes` before committing; then `git-commit-push` and `git-open-pr`. Manual
acceptance is `ext-run-local`.
