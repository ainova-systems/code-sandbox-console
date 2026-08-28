---
description: "Project-specific configuration consumed by the dev and git rules and skills"
---

# Project Profile

Pinned answers for the shared rules and skills, so they behave as this repository already does.
Values are resolved from here first; only an unset key falls back to auto-detection.

## Branching

- default_branch: main
- integration_branch: none
- branch_prefixes: feature/, bugfix/, hotfix/, release/
- update_strategy: merge
- protected_branches: main

## Commits

- commit_style: pack-default
- reference_ids: FR-0xx
- artifact_language: english

## Verification

- typecheck: none
- lint: none
- test: none
- verify: npm run verify
- coverage_gate: none

`npm run verify` is strict typecheck plus the esbuild bundle, and CI runs exactly it. There is no
test runner and no linter — the three keys above are unset because the tools do not exist, not
because the gate is optional.

## Workspace

- handoff_dir: auto

## Pull requests

- platform: github
- cli: gh
- pr_target: auto
- merge_method: squash
- auto_open_pr: true
- pr_template: auto
- pr_risk_size: on
- pr_size_thresholds: small <= 5 files & 50 lines; large >= 20 files or 400 lines; else medium
- pr_risk_globs: high: .github/workflows/**, src/sbx.ts, src/terminal.ts, src/secrets.ts, src/blobs.ts; medium: src/ops.ts, src/extension.ts, src/config.ts, src/sandbox.ts, src/form.ts; low: **/*.md, docs/**
- delete_local_branch: true
- delete_remote_branch: true
- post_merge: none

The high-risk globs are the CI workflow, credential handling and the two modules that shape sbx
CLI invocations; medium is the shared modules a change can ripple through.

## Releases

- release_flow: tag-on-default
- changelog: assembled
- release_cut: release-pr
- release_artifact: github-release
- release_notes: changelog-section
- tagger: maintainer
- version_source: package.json
- tag_format: vX.Y.Z

Publishing to the VS Code Marketplace is not covered by these keys — it is a separate human gate,
sequenced by the `vscode-publish-marketplace` skill.

## Documentation

- specs_dir: docs/specs
- spec_grouping: flat
- execution_mode: supervised
- features_dir: none
- rules_dir: none
- decisions_dir: none
- adr_naming: date

Specs here are append-only iteration records named `00N - <Iteration>.md`, split across
`docs/specs/drafts/` and `docs/specs/completed/` — not the `NNN-<slug>/` requirements-plus-plan
folders the schema's default assumes, and not the `@ainova-systems/spec` package's model, which
this project does not install. Functional truth is the single file `docs/Features.md`, which is
why `features_dir` is unset.

## Tracker

- tracker: github
- tracker_cli: gh
- tracker_item_ref: #123
