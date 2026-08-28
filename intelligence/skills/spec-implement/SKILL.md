---
name: spec-implement
description: "Implement one iteration spec end to end, ending with the canonical docs synced and the verify gate green"
argument-hint: "[spec number, e.g. 020]"
---

# Implement an iteration spec

The repeatable unit of work in this repo: one FR-scoped iteration, from spec to green verify.
The `sandbox-console` and `sandbox-console-src` rules carry the constraints — this skill
sequences the work, it does not restate them.

## Steps

1. **Anchor.** Read the iteration spec (`spec-draft` writes it when the change is substantial and
   has none), the FR entries it cites in `docs/Features.md`, and the touched sections of
   `docs/Architecture.md`.
2. **Branch** per the profile: `feature/<slug>` off `main`.
3. **Place the code** using the module map and its dependency direction. A new command lands in
   `package.json` `contributes`, `src/extension.ts` and — when palette and Explorer share it —
   `src/ops.ts`, all in the same change.
4. **Sync the docs in the same change.** Apply the spec's docs-sync checklist to
   `docs/Features.md` and `docs/Architecture.md`, flip the spec status to
   `Status: shipped with this iteration`, and `git mv` it from `docs/specs/drafts/` to
   `docs/specs/completed/` — fixing its `../../` doc links if the move changes their depth. A
   shipped spec never stays in `drafts/`.
5. **Cite `FR-0xx`** in code comments wherever the code now carries the requirement.
6. **Verify**: the profile `verify` command exits 0.

## Verify

`npm run verify` exits 0; the spec sits in `docs/specs/completed/` with a shipped status; the
canonical docs describe the code as it now behaves.

## Scope / hand-off

Review before committing — `dev-review-changes`. Manual acceptance of a behaviour change —
`vscode-run-local`, whose steps go into the PR's "How to Verify". Then `git-commit-push` and
`git-open-pr`.
