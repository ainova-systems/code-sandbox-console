---
name: ext-run-local
description: Build, install, and manually accept the extension locally - verify, vsix install (or F5 debug host), then a per-FR acceptance checklist. Use to see a change working in real VS Code, or to accept an FR before its PR merges.
---

# ext-run-local

Manual acceptance procedure. There is no test runner in this repo; a change is accepted by
running the extension and checking the FR's behaviour by hand.

## Prerequisites check

- Docker Sandboxes installed and signed in. Do not rely on PATH on Windows - probe it at
  `%LOCALAPPDATA%\DockerSandboxes\bin\sbx.exe` (`sbx diagnose` reports binary, daemon and
  sign-in in one go). Without it the extension loads and now says so - `⚠ Sandbox not
  available` in the status bar, a readiness node in the Sandboxes view, a modal on New
  Sandbox (FR-059) - while every lifecycle action stays blocked; layer-only changes can
  still be smoke-tested.

## Steps

1. `npm run verify` - exits 0 or stop here.
2. Install one of two ways:
   - `npm run install-extension` - packages a fixed-name vsix and force-installs it into VS
     Code; reload the window afterwards.
   - **F5** in VS Code - Extension Development Host, best for iterating.
3. **Acceptance checklist** - write it for the FR under test before clicking, from the FR's
   entry in `docs/Features.md`:
   - the entry point (palette command, Explorer node action, status bar item);
   - the expected visible result, stated so a pass/fail is unambiguous;
   - the quiet-startup rule: opening a workspace must show no notification and write nothing
     into `.sandbox/` (FR-002) - check this on every acceptance, whatever the FR.
4. Record the outcome in the PR's "How to Verify" section: the steps run and what was seen.

## Reference points

Explorer view id `sandboxConsoleExplorer`; commands are under the `Sandbox` category in the
palette. Sandbox lifecycle states surface as `running` / `stopped` / `absent` on tree nodes.
