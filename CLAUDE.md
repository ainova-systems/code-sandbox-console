# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Terminal-first VS Code extension that runs AI coding agents (Claude first) inside
isolated, persistent **Docker Sandboxes** (`sbx` microVMs). The extension is a thin
orchestration layer over the `sbx` CLI — it does **not** manage containers itself.

- Requirements: `docs/FRD.md` (referenced by `FR-0xx` IDs throughout the code).
- Design & decisions: `docs/ARCHITECTURE.md` — read it before changing backend behaviour.

## Build & check

- `npm install` — dependencies (all dev-only: esbuild, typescript, @types/vscode, @vscode/vsce).
- `npm run build` — bundle to `dist/extension.js` (esbuild).
- `npm run watch` — rebuild on change.
- `npx tsc --noEmit` — typecheck (strict). **This is the real correctness gate** —
  esbuild bundles without type-checking, so always run `tsc` too.
- `npm run package` — produce a `.vsix` (vsce).
- Run/debug: open the folder in VS Code and press **F5** (Extension Development Host).

There is no test runner yet; verification is `tsc --noEmit` + manual run + direct `sbx`
probing. "Build is green" = `tsc --noEmit` clean AND `npm run build` succeeds.

## Backend model (the load-bearing part)

- Everything goes through the `sbx` CLI. `src/sbx.ts` is the ONLY module that shapes
  sbx commands — keep CLI strings there.
- **`sbx` is not on PATH** (Windows): it lives at
  `%LOCALAPPDATA%\DockerSandboxes\bin\sbx.exe`. `sbxPath()` resolves it; that same path
  is used as the terminal `shellPath`.
- **There is no `sbx start`** — resume a stopped sandbox with `sbx run <name>` (or
  `sbx exec`, which auto-starts).
- Lifecycle: Create/Attach → `sbx run`; Stop → `sbx stop`; destroy → `sbx rm --force`;
  discovery → `sbx ls --json`.
- **Workspace mount (Windows):** the host drive `D:` is mounted in the sandbox at `/d`;
  the workspace is `/d/<path>`. `sbx run` drops the agent there. For `exec`-based
  shells, translate the host path with `sbx.hostToSandboxPath()` and pass `-w`.
  `/home/agent/workspace` is an empty decoy — **not** the mount.
- Persistence is native to sbx: `stop` keeps state, `rm` destroys it. Do not add volumes.

## Credentials

Fixed priority: **OAuth `/login` (default fallback) → API key in the OS keychain via
`sbx secret set -g anthropic` (next) → never a plaintext `ANTHROPIC_API_KEY` env var.**
The host's existing `~/.claude` login is **not** reused (deliberate microVM isolation).
The extension provisions nothing in v0.1.

## Module map

`src/extension.ts` (commands + startup discovery UX), `identity.ts` (`.sandbox`
`{id,name}`), `sbx.ts` (CLI wrapper + path resolution + `hostToSandboxPath`),
`sandbox.ts` (naming + lifecycle over sbx), `terminal.ts` (native terminals driving
sbx), `agents.ts` (registry). Dependency direction: `extension → {sandbox, terminal,
identity, agents}`; `sandbox → sbx`.

## Binding UX invariants (not preferences)

When a sandbox exists, **Attach is the primary action and resume is the default** —
never steer toward a duplicate (FRD §3/§4). Terminal-first: every agent interaction is
a terminal window; no chat panels or custom agent UI. `.sandbox` (gitignored,
per-working-tree) keys identity on a stable local id — a fresh clone or git worktree
gets its own.

## Conventions

- Keep `docs/FRD.md` authoritative; cite `FR-0xx` IDs in code/commits for traceability.
- Do not reintroduce raw-Docker container management — the project deliberately pivoted
  away from it to `sbx` (ARCHITECTURE.md §2).
