---
name: dev-onboard
description: Bring a clean machine to a green verify and a running extension - prerequisites, install, verify, F5 smoke run, and the map of where truth lives. Use on first contact with this repo, human or agent.
---

# dev-onboard

From clean checkout to working setup. Steps 1-2 contain manual installs an agent cannot do;
finish by printing the punchlist of whatever remains for the human.

## Steps

1. **Prerequisites** (check, and punchlist what is missing):
   - Node.js 20+ (`node --version`);
   - VS Code 1.90+;
   - Docker Sandboxes - required for real sandbox runs, optional for build-only work. Windows
     install lands `sbx` at `%LOCALAPPDATA%\DockerSandboxes\bin\sbx.exe` (not on PATH); probe
     with `sbx version` at that path, and note that sign-in is a manual browser step.
2. **Git identity**: commits carry no agent identity in messages (see `git-commit-push`);
   nothing to configure beyond a normal user.
3. `npm install`.
4. `npm run verify` - must exit 0. This one command is the repo's whole correctness gate
   (strict typecheck + bundle); CI runs the same thing.
5. **Smoke run**: F5 in VS Code (Extension Development Host). Expect: quiet startup, no
   notifications; a "Sandboxes" view in the Explorer; `+ New Sandbox` in the status bar for a
   repo without sandboxes.
6. **Where truth lives** (read in this order): CLAUDE.md (rules, module map, git workflow) ·
   `docs/Features.md` (functional truth, FR ids) · `docs/Architecture.md` (technical truth) ·
   `docs/specs/completed/` (immutable history; `docs/specs/drafts/` holds work in flight).
   Working skills: `spec-new-iteration`, `spec-implement`,
   `ext-run-local`, `dev-review-changes`, `git-commit-push`, `git-open-pr`.

## Exit

Print: verify result, what was smoke-tested, and the manual punchlist (typically: Docker
Sandboxes install/sign-in, VS Code F5 run).
