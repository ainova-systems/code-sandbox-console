---
name: dev-review-changes
description: Review a diff against this repo's load-bearing invariants - module boundaries, sbx CLI containment, security and UX invariants, docs drift. Use before every commit of non-trivial work and on any PR diff.
---

# dev-review-changes

A findings-producing review, scoped to what actually breaks this product. Read the diff first
(`git diff`, `git diff main...`, or `gh pr diff <n>`), then walk the checklist. Report each
finding as `file:line - what and why`; no findings is a valid result and is said plainly.

## Checklist

1. **Module boundaries** (CLAUDE.md "Module map"): the dependency direction holds; nothing
   imports from `extension.ts`; shared palette/Explorer flows stay in `ops.ts` so the two
   surfaces cannot drift.
2. **CLI containment**: every child-process `sbx` invocation is in `src/sbx.ts`; interactive
   shellArgs in `src/terminal.ts`; if either changed shape, the rendered template in
   `src/script.ts` was updated in the same diff.
3. **Security invariants** (Architecture §8-§9; these are release-hardening guarantees):
   - secret values travel only over stdin pipes - never argv, env, image layers, or logs;
   - the argv allowlist asserts in `sbx.ts` still cover every new invocation;
   - dockerfile/context paths stay contained inside the repo;
   - webview HTML keeps its CSP; no remote content.
4. **UX invariants** (Features §3-§4): attach ("Connect") remains the primary action when a
   sandbox exists; no implicit default sandbox appears; terminal-first holds (no chat panels);
   startup stays quiet and writes nothing into `.sandbox/`.
5. **Docs drift**: if the diff changes behaviour, the same diff updates `docs/Features.md` /
   `docs/Architecture.md` and carries its `00N` spec with the status flipped to shipped and
   the file moved from `docs/specs/drafts/` to `docs/specs/completed/`. FR ids cited in the
   code match real entries.
6. **Gate**: `npm run verify` exits 0 on the reviewed tree.

## Escalation

Findings in categories 2-3 are High risk by the repo's own classification - name that in the
review so the PR's Risk field matches.
