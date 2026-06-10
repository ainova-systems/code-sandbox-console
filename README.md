# Sandbox Console

Run AI coding agents (Claude Code, Codex, Gemini, OpenCode, …) inside isolated, persistent
**Docker Sandboxes** (`sbx` microVMs) — terminal-first, straight from a Sandbox Explorer in
VS Code. It feels like a native terminal while execution happens in a microVM; you never
manage containers, images, or sandbox lifecycle by hand.

The extension is a thin orchestration layer over the `sbx` CLI; it does not manage
containers itself. Credentials can be scoped **per sandbox** via host-side proxying, so one
project's secrets need never be exposed to another's environment (globally-scoped
credentials are deliberately shared across all sandboxes) — and the agent runs in a
microVM, not on your host.

## Features

- **Sandbox Explorer** — a tree of this repo's sandboxes with live status; per-node actions
  appear on hover and follow a clear lifecycle (running → Stop → Edit / Rebuild / Delete →
  Remove), organised into optional groups.
- **New / Edit a sandbox** — a webview panel (no YAML by hand): agent, an optional **Title**
  and **Group**, the credentials it needs, ports, and environment. Saving writes
  `.sandbox/config.yaml` and applies to the instance.
- **Custom environments** — three modes per sandbox: the agent's **default image**, a
  **custom Dockerfile** (a starter is generated; built via `docker build` →
  `sbx template load`), or a **custom image** pulled as-is from a registry.
- **Credential provisioning** — tick the services a sandbox needs; values are prompted and
  stored via `sbx secret set` (piped over stdin, never in the repo or image). Global
  credentials are shown read-only, separate from per-sandbox ones. For `github` it also runs
  `gh auth login --with-token` inside so the `gh` CLI works.
- **Multi-agent & multi-sandbox** — one repo can run several agents/sandboxes; parallel work
  on the same repo uses git worktrees or `mount: clone`.

## Requirements

- VS Code **1.90+**.
- [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) (`sbx`) installed and signed in
  (`sbx login`).
- Docker (host) — only needed to build **custom Dockerfile** images.

**Platform support:** developed and verified on **Windows** (the `sbx` executable is
resolved from `%LOCALAPPDATA%\DockerSandboxes\bin`). macOS/Linux are **untested**: the
extension falls back to `sbx` on PATH and passes POSIX workspace paths through unchanged,
so they are expected to work — reports welcome.

## Install

Not yet published to the VS Code Marketplace. Install from a `.vsix`:

```sh
npm install
npm run package        # produces sandbox-console-<version>.vsix
code --install-extension sandbox-console-<version>.vsix
```

Or run it from source: open this folder in VS Code and press **F5** (Extension
Development Host).

## Configuration

Per-repo sandboxes live in a committed, compose-like recipe at `.sandbox/config.yaml`
(written by the form), including the project `name`. A short random id in
`.sandbox/identity.yaml` (gitignored) keeps each clone/copy conflict-free — the sbx sandbox
name is `<name>-<key>-<id>`.

```yaml
version: 1
name: my-repo
sandboxes:
  claude:
    agent: claude
    title: Backend
    group: Services
    secrets: [github]
    ports: [5173]
  dotnet:
    agent: shell
    image: myrepo-dotnet:latest
    dockerfile: dotnet.Dockerfile   # built and tagged as `image`
```

## Develop

- `npm install`
- `npm run build` — bundle to `dist/extension.js` (esbuild).
- `npm run watch` — rebuild on change.
- `npx tsc --noEmit` — strict typecheck (the real correctness gate).
- `npm run package` — produce a `.vsix` (vsce).
- Press **F5** to launch the Extension Development Host.

## Documentation

- [Features](docs/Features.md) — the functional truth (`FR-0xx` requirement IDs)
- [Architecture](docs/Architecture.md) — the technical truth (design & decisions)
- [Iteration specs](docs/specs/) — append-only history of substantial changes
- Upstream: [Docker Sandboxes docs](https://docs.docker.com/ai/sandboxes/)

## Built AI-first

Sandbox Console was designed and implemented by AI coding agents, end to end — a working
proof of [AI-First engineering](https://www.ainovasystems.com), not a claim about it.

---

Created by **Dmitrij Zykovic** — Fractional CTO at [Ainova Systems](https://www.ainovasystems.com)

Helping teams adopt AI automation, establish AI-First SDLC, and build fully autonomous AI engineering pipelines.

[LinkedIn](https://www.linkedin.com/in/dmitrijz/) · [Advisory & Consulting](https://www.ainovasystems.com)
