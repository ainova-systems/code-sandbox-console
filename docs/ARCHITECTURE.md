# Architecture — Ainoflow Sandbox Terminal

> **Status:** Draft, tracks the v0.1 walking skeleton.
> **Companion docs:** [FRD.md](FRD.md) (requirements). Requirement IDs (`FR-0xx`)
> below refer to that document.

## 1. Purpose & scope

This document describes how the extension is built. The product goal (see FRD):
run AI coding agents (Claude Code first) inside isolated, persistent sandboxes,
from a terminal that feels native to VS Code — with the user never having to think
about containers or sandbox lifecycle.

v0.1 scope is a **walking skeleton**: Claude only, create/attach/stop/shell, on top
of Docker Sandboxes. Explorer sidebar, multi-agent, MCP, and policy UIs are deferred
(§11).

## 2. Core architectural decision

The extension is a **thin orchestration layer over Docker Sandboxes (`sbx`)** — it
does not manage containers itself.

This was a deliberate pivot. The first prototype drove raw Docker
(`docker run`/`docker exec`) with a hand-rolled auth volume and base image. That was
the wrong altitude: it gave only container-level isolation (shared host kernel) and
forced us to reimplement persistence, network/filesystem policies, agent launching,
and credential handling — all of which `sbx` already provides natively, and more
strongly (microVM isolation). The raw-Docker backend was removed.

`sbx` (verified `v0.31.3` on the dev machine) gives us, out of the box:

- **microVM isolation** — separate kernel, a Docker daemon *inside* each sandbox.
- **native persistence** — installed packages, config, and state survive stop/start.
- **credential proxy** — secrets stay on the host; the sandbox sees a sentinel.
- **network allow-list** and **filesystem modes** (direct vs `--clone` read-only).
- **first-class agents** — `claude`, `codex`, `gemini`, `copilot`, `cursor`, `shell`, …

## 3. System context

```text
VS Code window
  └─ Ainoflow Sandbox Terminal (extension, this repo)
        │  spawns the sbx CLI (child_process + native terminal)
        ▼
  sbx CLI  ──────────────►  sbx daemon  ──────────►  microVM sandbox
  (host)                    (host)                    ├─ agent (claude)
        ▲                                             ├─ workspace mount
        │ host-side credential proxy                  └─ inner Docker daemon
        └─ real Anthropic creds (keychain/OAuth) injected into outbound calls;
           sandbox only ever sees a "proxy-managed" sentinel
```

The host repository is the source of truth; the sandbox is a disposable execution
environment around it.

## 4. Module breakdown

All source is in `src/`. The extension bundles to `dist/extension.js` via esbuild.

| Module | Responsibility |
|---|---|
| `extension.ts` | Activation, command registration, startup discovery UX (FRD §3, "Attach before Create"). Orchestrates the flows below. |
| `identity.ts` | Reads/writes the committed `.sandbox` repo identity (`{id, name}`). FR-001. |
| `sbx.ts` | The only place that knows the `sbx` CLI. Resolves the `sbx` executable, runs `version`/`ls --json`/`create`/`stop`/`rm`, and maps results to a `SandboxState`. |
| `sandbox.ts` | Derives the sandbox name from identity+agent, and exposes lifecycle ops (`state`/`stop`/`destroy`/`create`) over `sbx.ts`. No CLI strings here. |
| `terminal.ts` | Opens native VS Code terminals whose `shellPath` is `sbx` — `run`/`exec`. This is where the agent actually attaches. |
| `agents.ts` | Agent registry. v0.1 = `{ claude }`; the id maps directly to an `sbx` agent. |

Dependency direction: `extension → {sandbox, terminal, identity, agents}`;
`sandbox → sbx`; `terminal → sbx (path only)`. Nothing depends on `extension`.

## 5. Lifecycle & command mapping

The FRD's lifecycle maps almost 1:1 onto `sbx`. Notably there is **no `sbx start`**:
a stopped sandbox is resumed by `sbx run <name>` (or auto-started by `sbx exec`).

| FRD action | Extension command | sbx invocation |
|---|---|---|
| Create + auto-attach (FR-003) | `Create Claude Sandbox` | `sbx run --name <name> claude <workspace>` (creates if absent, attaches) |
| Attach (FR-005) | `Attach` | `sbx run <name>` (resumes if stopped) |
| Start (FR-004) | folded into Attach | `sbx run <name>` |
| Stop (FR-006) | `Stop` | `sbx stop <name>` |
| Open Shell | `Open Shell` | `sbx exec -it -w /<drive>/… <name> bash` (auto-starts, lands in workspace) |
| Discovery (FR-002) | on activation | `sbx ls --json` → match by name |
| Rebuild/Delete (FR-007) | deferred (backend ready) | `sbx rm --force <name>` |

Create-vs-attach is disambiguated by checking `sbx ls --json` first, then choosing
the create form (`… claude <path>`) or the attach form (`… <name>`).

## 6. Identity & naming

A repository is identified by a committed `.sandbox` file at its root:

```json
{ "id": "f3c1a2e0-…", "name": "code-sandbox-console" }
```

- `id` (UUID) is the stable, canonical identity (survives renames/moves/re-clones).
- `name` (folder-derived slug, persisted once) is the human label.

The `sbx` sandbox name is derived as `<name>-<agent>` (e.g.
`code-sandbox-console-claude`), sanitised to the characters `sbx` allows
(letters, digits, `.`, `+`, `-`). One repo → one sandbox per agent (FR-001).

## 7. Persistence model

Persistence is delegated entirely to `sbx` — no extension-managed volumes:

- `sbx stop` retains packages, config, command history, and agent state.
- `sbx run`/`exec` resume that state.
- `sbx rm` is the only destructive path (state is gone; host working tree untouched).

This satisfies FR-006 (stop preserves) and FR-007/Delete (rm destroys) natively.
Verified: `create → ls → exec → stop → ls` cycle works and status transitions
correctly.

## 8. Credential model

**Decision (v0.1): rely on `sbx`'s native OAuth `/login` fallback.** When no
credential is provisioned, running `claude` inside the sandbox prompts an
interactive OAuth `/login`; the OAuth flow runs on the host via the credential
proxy, so the token is never stored inside the sandbox. This is acceptable for the
first version — the extension provisions nothing.

**Confirmed behavior — auth is host-global, shared across all sandboxes.** sbx stores
the credential as a *global service secret* on the host (`sbx secret ls` →
`(global) service anthropic (oauth configured)`). The host proxy injects it into
*every* sandbox's outbound Anthropic calls, so once authenticated — whether by a
one-time OAuth `/login` or `sbx secret set -g anthropic` — all existing and new
sandboxes are authenticated **by default, with no per-sandbox login.** This satisfies
the §14 "agent available immediately" criterion out of the box. Verified live: a
pre-existing global `anthropic` OAuth secret made a freshly created sandbox
authenticated with no login step.

Important constraint (by design, not a bug): this global credential lives in sbx's own
host-side store, **not** in your local Claude Code install — **the host's `~/.claude`
config is NOT read.** Docker's docs: *"Sandboxes don't pick up user-level
configuration from your host, such as `~/.claude`."* You authenticate sbx once; you do
not copy the `~/.claude` token. Credential isolation is the point of the microVM.

**Next solution (v0.2): API key in the host OS keychain**, via
`sbx secret set -g anthropic`. The key is stored in the host keychain, global across
all sandboxes; the proxy injects it into calls to `api.anthropic.com` and the sandbox
sees only a `proxy-managed` sentinel. A future version detects a missing secret and
offers to run this (FR-030).

**Explicitly rejected: exposing `ANTHROPIC_API_KEY` as a plaintext environment
variable** into the sandbox. It is weaker than the keychain (plaintext in process
env, no OS-level access control) and defeats the proxy's credential-isolation
guarantee. The keychain secret is the only API-key path we will support.

Credential priority: **OAuth `/login` (default) → keychain secret (next) → ✗ never
env var.**

## 9. Security & isolation

Provided by `sbx`, surfaced (not reimplemented) by the extension:

- **Isolation** — each sandbox is a microVM with its own kernel and Docker daemon.
- **Network policy** (FRD §12) — host proxy enforces an allow-list; outbound hosts
  are logged/allowed/blocked.
- **Filesystem policy** (FRD §12) — *direct* mount (read-write workspace) vs
  `--clone` (private in-container clone, host repo mounted read-only). v0.1 uses
  direct; `--clone` is a one-flag addition.
- **Workspace mount path** — with direct mount on Windows, each host drive is
  mounted in the sandbox at `/<drive-letter>` (e.g. `D:\Repositories\app` →
  `/d/Repositories/app`), read-write and bidirectional. `sbx run` drops the agent
  there; `Open Shell` reaches it via `exec -w <translated-path>`
  (`sbx.hostToSandboxPath`). Verified end-to-end. Note `/home/agent/workspace` is an
  unrelated empty default dir — not the mount.

## 10. Terminal / PTY model

The extension opens a **native VS Code terminal** with `shellPath` set to the `sbx`
executable and `shellArgs` = the `run`/`exec` invocation. The native terminal owns a
real PTY (ConPTY on Windows), so ANSI, cursor control, resize, and interactive agents
work with no native dependency (no `node-pty`). This satisfies FR-010/FR-011.

The `sbx` executable is resolved at runtime: the Windows installer places it at
`%LOCALAPPDATA%\DockerSandboxes\bin\sbx.exe` and does **not** add it to `PATH`, so
`sbx.ts` checks that location first and falls back to the bare command name.

## 11. Open issues & risks

- **Workspace mount — resolved (kept as a pointer).** An earlier scare ("empty
  workspace") was a testing error: probing `/home/agent/workspace` (an unrelated empty
  dir) instead of the real mount. The host drive is mounted at `/<drive>` (see §9);
  `sbx run` and `sbx exec -w` both reach the repo read-write. No longer an open risk.
- **Runtime partially exercised.** F5 works (launch config added) and the primary flow
  is user-confirmed: Create Claude Sandbox → terminal → authenticated `claude`. Still
  to confirm individually: Attach (resume), Stop, Open Shell.
- **Single workspace folder.** v0.1 uses `workspaceFolders[0]`; multi-root is out of
  scope.

## 12. Deferred scope (post-v0.1)

Sandbox Explorer sidebar (FRD §10), additional agents and multiple terminal tabs
(FR-012, FR-021/022), Rebuild/Delete commands (FR-007), filesystem/network policy
UIs (§12), and MCP endpoints (§13). The backend already supports several of these
(`sbx rm`, `--clone`, multi-agent registry), so they are mostly UI/wiring work.

## 13. Verification status

| Item | Status |
|---|---|
| Extension typechecks (`tsc --noEmit`) + bundles (esbuild) | ✅ verified |
| `sbx` CLI surface (run/create/ls/stop/rm/exec) | ✅ verified against `sbx v0.31.3` |
| Create → ls → stop lifecycle + status transitions | ✅ verified |
| Persistence (stop retains, rm destroys) | ✅ native to sbx |
| Workspace mount (FR-040) | ✅ verified — host drive at `/<drive>`; `run` + `exec -w` reach the repo (read/write) |
| `Open Shell` lands in workspace | ✅ fixed — `exec -w /<drive>/…` (`hostToSandboxPath`) |
| Credential model — global `anthropic` secret reused across sandboxes | ✅ verified live (`sbx secret ls`); new sandbox authenticated, no login |
| Extension end-to-end via F5 | ✅ user-confirmed: Create Claude Sandbox → terminal → authenticated `claude`. (attach/stop/shell not yet each confirmed) |
