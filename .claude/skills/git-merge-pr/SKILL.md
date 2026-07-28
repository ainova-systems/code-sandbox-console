---
name: git-merge-pr
description: Merge a ready PR safely - verify CI is green, no unresolved review threads or unanswered comments, then squash-merge with remote branch deletion and clean up locally (main + pull + delete local branch). Use when a PR is approved for merge.
---

# git-merge-pr

Merging is deliberate: every gate below must pass BEFORE `gh pr merge`. A failed gate stops
the skill — report what blocked and never merge around it.

## Readiness gates

1. **PR state**: `gh pr view <n> --json state,mergeable,reviewDecision`
   - `state` must be `OPEN`; `mergeable` must be `MERGEABLE` (conflicts → rebase the
     branch first, then restart this skill).
   - `reviewDecision` must not be `CHANGES_REQUESTED`. (`null`/`APPROVED` are both fine —
     this repo has no required-review rule.)
2. **Build green**: `gh pr checks <n>` — every check `pass`. Pending → wait
   (`gh pr checks <n> --watch`); failing → fix on the branch, never merge over red.
3. **No unresolved review threads**:
   `gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved}}}}}' -F o=<owner> -F r=<repo> -F n=<n>`
   — every `isResolved` must be `true`. An unresolved thread means an unhandled review
   point: address it in code or answer it in the thread, resolve it, then re-run the gates.
4. **No unanswered comments**: `gh pr view <n> --comments` — plain PR comments cannot be
   "resolved", so read them; each one must be either acted on or answered with a reply.
   A question with no reply is an unhandled comment — handle it first.

## Merge

5. `gh pr merge <n> --squash --delete-branch` — squash keeps `main` one-commit-per-PR
   (the squash title stays the PR title = the commit-message sentence). `--delete-branch`
   removes the remote branch.

## Local cleanup

6. `git checkout main && git pull` — fast-forward to the merge result.
7. Delete the local branch if it survived (running the merge from inside the repo usually
   lets `gh` delete it; verify): `git branch --list <branch>` → if present,
   `git branch -D <branch>`. `-D` is required — squash merges leave no ancestry, so
   `git branch -d` refuses even though the work is fully merged. Only delete after step 6
   confirmed the squash commit is on `main`.
8. Confirm clean state: `git status` (clean, on `main`), `gh pr view <n>` shows `MERGED`.

## Hand-off

`main` now carries the change; the branch is gone locally and remotely. If the PR shipped
an iteration spec, it is immutable from this point (see CLAUDE.md documentation model).
