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
open a Shell and read the evidence:

Everything except the first line lands in `$SANDBOX_WORKSPACE/dist/lifecycle-hooks.log`, and
every start mints a `run=<uuid>` that the service repeats in its heartbeats — that pairing is
what makes a restart provable rather than plausible.

| Check | Command in the sandbox | Expected |
|---|---|---|
| `setup` ran once, **before** the clone existed | `cat /tmp/hooks-setup-evidence.txt` | `workspace_exists=no source_readable=yes` — the create-time phase cannot see the workspace under `mount: clone`; the read-only host tree it can |
| `startup` ran, and reached files git does not carry | `ls $SANDBOX_WORKSPACE/dist` | `README.from-source.md`, `source-top-level.txt` — copied out of `/run/sandbox/source`, which the clone itself does not contain |
| the clone matches the host checkout | `grep startup.begin $SANDBOX_WORKSPACE/dist/lifecycle-hooks.log` | `source_head` and `workspace_head` are the same short commit |
| `services` stays up | `grep -c service.heartbeat $SANDBOX_WORKSPACE/dist/lifecycle-hooks.log` | grows by one every ~5s |
| **every start replays both hooks** | Stop, then Connect, then `grep -E 'startup.begin\|service.start' …/lifecycle-hooks.log` | a **second** pair with a **new** `run=` and a **new** `pid=` — a surviving process would keep the old ones. `Sandbox: Show Log` also gains a `# startup hooks — <name>` block with `ok` per hook |
| **an edit applies on restart** | add a `startup` line (e.g. `date -u >> "$SANDBOX_WORKSPACE/dist/edited.txt"`), Save, then Stop → Connect | the new command ran: `edited.txt` exists and `/tmp/sandbox-console-hooks.log` lists one more `ok startup[n]`. No Rebuild, no extra action — the form says as much on Save |
| a failure is not swallowed | set a `startup` line to `exit 7`, Save, then Stop → Connect | warning naming the sandbox with **Show Log** / **Open Shell**; the log shows `fail startup[n] exit=7` and the hooks after it are skipped; the sandbox itself stays up (that is sbx's behaviour, not a bug) |
| `setup` is the exception | edit a `setup` line, Save | a modal asking for a **Rebuild**, explaining that the install phase only runs while a sandbox is created; declining still confirms the save |
| the generated CLI agrees | `bash .sandbox/scripts/sbx.sh connect hooks-demo` from Git Bash on a fresh instance | the same kit and the same evidence — parity is required (CLAUDE.md), and the bash reader supports plain/quoted scalars only, never `- |` block scalars |

`dist/` is this repo's gitignored build output, so the evidence never dirties the clone.

## Reference points

Explorer view id `sandboxConsoleExplorer`; commands are under the `Sandbox` category in the
palette. Sandbox lifecycle states surface as `running` / `stopped` / `absent` on tree nodes.
