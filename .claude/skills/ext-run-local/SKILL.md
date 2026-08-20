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

## Lifecycle hooks (FR-060) — ready-made acceptance

This repo's own `.sandbox/config.yaml` carries a `hooks-demo` sandbox (agent `shell`,
`mount: clone`) whose commands exist to be checked rather than to do work. Connect it, then
open a Shell and read the evidence.

Two logs, and only two. **`/tmp/hooks.log`** is what the demo's own commands write — one
file, chronological, one block per start. **`/tmp/sandbox-console-hooks.log`** is the
extension's verdict log (`ok` / `fail` per command), truncated at every start, and the file
the VS Code warning is based on.

| Check | In the sandbox | Expected |
|---|---|---|
| `setup` ran once, **before** the clone existed | `cat /tmp/hooks.log` (first line) | `setup … workspace_exists=no source_readable=yes` — the create-time phase cannot see the workspace under `mount: clone`; the read-only host tree it can |
| `startup` reached files git does not carry | same file, `startup` lines | `copied README.md out of the read-only host tree`, and `dist/extension.js=yes (the clone has=no)` — the whole point of `$SANDBOX_SOURCE` |
| the clone matches the host checkout | same file | `head=` and `clone_head=` are the same short commit |
| `services` stays up | `tail -3 /tmp/hooks.log` | a `service alive pid=…` line every ~10s |
| **every start replays both hooks** | Stop, then Connect, then `cat /tmp/hooks.log` | a second `===== start … =====` block with a **new** service pid — a surviving process would keep the old one |
| **an edit applies on restart** | change the `EDIT ME` line from `v1` to `v2`, Save, Stop → Connect | the new block reads `===== start v2 =====`. No Rebuild and nothing else to press; the form says as much on Save. Start from the Explorer or `sbx.sh connect` — a bare `sbx run` does not regenerate the runner |
| a failure is not swallowed | set a `startup` line to `exit 7`, Save, Stop → Connect | a warning naming the sandbox with **Show Log** / **Open Shell**; `/tmp/sandbox-console-hooks.log` shows `fail startup[n] exit=7`, the commands after it skipped, the sandbox still running |
| a dead service is not called started | set a `services` line to `exit 3`, Save, Stop → Connect | `fail service[n] exited immediately` with its output quoted beneath, and `=== hooks end ok, 1 service(s) failed to start` |
| `setup` is the exception | edit the `setup` line, Save | a modal asking for a **Rebuild**, explaining that the install phase only runs while a sandbox is created; declining still confirms the save |
| the generated CLI agrees | `bash .sandbox/scripts/sbx.sh connect hooks-demo` from Git Bash on a fresh instance | the same kit, runner and evidence — parity is required (CLAUDE.md), and the bash reader supports plain/quoted scalars only, never `- |` block scalars |

Writing to `/tmp` keeps both this repository and the sandbox's private clone clean.

## Reference points

Explorer view id `sandboxConsoleExplorer`; commands are under the `Sandbox` category in the
palette. Sandbox lifecycle states surface as `running` / `stopped` / `absent` on tree nodes.
