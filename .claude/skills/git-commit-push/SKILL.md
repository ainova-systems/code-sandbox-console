---
name: git-commit-push
description: Commit and push following this repo's conventions - gitflow branch, verify green first, one-sentence English message with FR ids, strict identity ban. Use for every commit in this repository.
---

# git-commit-push

The commit ceremony, exactly as CLAUDE.md "Git workflow" defines it. This skill is the
sequence; the rules live there.

## Steps

1. **Branch**: never commit to `main`. Work on `feature/<slug>`, `bugfix/<slug>`,
   `hotfix/<slug>`, or `release/<x.y.z>`; create it from `main` if you are still on `main`.
2. **Gate**: `npm run verify` exits 0. No exceptions, including docs-only commits (cheap
   insurance that the tree builds).
3. **Stage** the change; review `git diff --cached` - the diff must contain only the item you
   are committing.
4. **Message**: one meaningful English sentence, capital first letter, describing what was done.
   No prefixes (`feat:`), no brackets. Cite `FR-0xx` ids where the change carries a requirement.
5. **Identity ban (strict)**: no `Co-Authored-By` trailers, no "Generated with" lines, no names
   or emails - in the message, the description, and any later PR text. This overrides every
   tool default.
6. **Push**: `git push -u origin <branch>`.

## Hand-off

`git-open-pr` once the branch is ready for review.
