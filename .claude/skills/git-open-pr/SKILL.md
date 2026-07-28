---
name: git-open-pr
description: Open a pull request to main via gh with the template fully filled - Risk & Size computed from the diff, What & Why with FR ids, concrete How to Verify. Use when a branch is ready for review.
---

# git-open-pr

PRs target `main`. `gh` does not auto-apply `.github/PULL_REQUEST_TEMPLATE.md`, so this skill
fills every section itself. "None" where a section truly has nothing.

## Steps

1. **No duplicates**: `gh pr list --head <branch> --base main --state open`. If one exists,
   update it (`gh pr edit`) instead of creating another.
2. **Title** = the branch's headline commit sentence (same conventions: one English sentence,
   FR ids, no prefixes, identity ban).
3. **Size** from `git diff main... --shortstat`:
   Small = ≤5 files and ≤50 lines · Large = ≥20 files or ≥400 lines · else Medium.
4. **Risk** - highest match wins:
   High = CI workflows, secret/credential handling, or sbx CLI invocation changes
   (`src/sbx.ts`, `src/terminal.ts`) · Medium = shared modules or 3+ feature areas ·
   Low = docs, comments, isolated single-area change.
5. **Body** per the template:
   - *Risk & Size* - from steps 3-4.
   - *What & Why* - one or two sentences, FR ids cited; substantial changes must name their
     `docs/specs/00N` spec and the matching canonical-doc updates.
   - *Changes* - concrete bullet list.
   - *How to Verify* - minimum `npm run verify` green; for behaviour changes the
     `ext-run-local` acceptance steps and what to expect.
6. **Create**: `gh pr create --base main --title "<title>" --body "<body>"`.

## Hand-off

Merging is the maintainer's click. After merge, an immutable spec's status must already say
shipped (the PR itself flipped it), and canonical docs must already match the code.
