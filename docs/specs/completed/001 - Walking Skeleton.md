# 001 — Walking Skeleton (v0.1)

> **Iteration spec — immutable history.** Describes what changed in this iteration and
> why. The current truth lives in [`../../Architecture.md`](../../Architecture.md) and
> [`../../Features.md`](../../Features.md); where this spec disagrees with them, they win.
>
> **Period:** 2026-06-08 … 2026-06-09 ·
> **Commits:** `6a8ce18` (FRD), `3000351`, `e65eb54`

## What & why

First working version: run Claude Code inside an isolated, persistent Docker Sandbox
from VS Code, terminal-first. Scope was deliberately a walking skeleton — Claude only,
create/attach/stop/shell, no Explorer, no multi-agent.

## Key decisions

- **Pivot: raw Docker → `sbx`.** The first prototype drove `docker run`/`docker exec`
  with a hand-rolled auth volume and base image. Wrong altitude: container-level
  isolation only, and it reimplemented persistence/policies/credentials that Docker
  Sandboxes provide natively (microVM). The raw-Docker backend was removed entirely —
  do not reintroduce it.
- **Native VS Code terminals** with `shellPath = sbx.exe` — a real PTY (ConPTY) for
  free, no `node-pty` dependency.
- **No `sbx start` exists** — resume is `sbx run <name>`; `sbx exec` auto-starts.
- **Credentials:** rely on sbx's native OAuth `/login` fallback (host-global via the
  credential proxy); the extension provisions nothing in v0.1. Plaintext
  `ANTHROPIC_API_KEY` env var explicitly rejected. The host's `~/.claude` is never
  read (deliberate microVM isolation).
- **Identity:** a single gitignored `.sandbox` JSON file (`{ id: <uuid>, name }`) per
  working tree; sandbox name `<name>-<agent>`, one sandbox per (repo, agent).
  *(Superseded in [002](002%20-%20Managed%20Sandbox%20UI.md): `.sandbox/` folder,
  committed recipe + local short id.)*
- **One-click `Create Claude Sandbox` command** as the first-run flow.
  *(Removed in [003](003%20-%20Open-Source%20Readiness.md): no implicit Claude.)*

## Verification snapshot (as of this iteration)

- `sbx` CLI surface (run/create/ls/stop/rm/exec) verified against `sbx v0.31.3`.
- Create → ls → stop lifecycle, persistence (stop retains / rm destroys): verified.
- Workspace mount confirmed: host drives at `/<drive>` (an earlier "empty workspace"
  scare was a probe of the wrong dir, `/home/agent/workspace`).
- End-to-end via F5 user-confirmed: Create Claude Sandbox → terminal → authenticated
  `claude`.
