# Functional Requirements Specification

# Ainoflow Sandbox Terminal for VS Code

> **Status:** Initial draft (v0.1)
> **Document:** Functional Requirements Document (FRD)

## 1. Overview

Ainoflow Sandbox Terminal provides a terminal-first experience inside VS Code, allowing developers to run AI coding agents such as Claude Code, Codex, Gemini CLI, and future agents inside isolated persistent sandboxes.

The experience must feel identical to using a normal terminal window while providing isolation, persistence, and security through sandbox execution.

The user should not need to understand Docker, containers, virtual machines, or sandbox lifecycle management.

---

# 2. Goals

## Primary Goals

* Provide a terminal experience indistinguishable from native VS Code terminals
* Execute agents inside isolated sandboxes
* Preserve agent authentication and session state
* Allow reopening and resuming previous agent sessions
* Support multiple agents per project
* Minimize friction between local development and sandboxed execution

## Non-Goals

* Container management UI
* Kubernetes management
* Infrastructure administration
* CI/CD orchestration
* Cloud deployment management

---

# 3. Core User Experience

## First-Time Project

When a project has no sandbox:

```text
Sandbox not found.

[ Create Claude Sandbox ]
[ Create Codex Sandbox ]
```

User selects an agent.

Sandbox is created automatically.

Terminal opens automatically.

Agent starts automatically.

---

## Returning Project

When a sandbox already exists:

```text
Claude Sandbox Found

Status: Running

[ Attach ]
```

or

```text
Claude Sandbox Found

Status: Stopped

[ Start and Attach ]
```

The default action must always be resume.

The system must never encourage creating duplicate sandboxes.

---

# 4. Design Principles

## Terminal First

The primary interface is a terminal.

Every agent interaction happens through terminal windows.

No chat panels are required.

No custom agent UI is required.

---

## Attach Before Create

If a sandbox exists:

```text
Attach
```

must always be the primary action.

Creating a new sandbox should be a secondary action.

---

## Persistent Sessions

A sandbox represents a long-lived development environment.

A sandbox should survive:

* VS Code restart
* Machine reboot
* Docker restart
* Sandbox stop/start cycles

---

## Project-Centric Experience

Users work with projects.

Users do not work with containers.

Users do not work with sandbox identifiers.

---

# 5. Functional Requirements

## FR-001 Project Detection

The extension shall automatically detect the current workspace.

The extension shall associate sandboxes with repositories.

Recommended identity:

```text
Repository ID
+
Agent Type
```

Example:

```text
ainoflow
 ├─ Claude Sandbox
 ├─ Codex Sandbox
 └─ Gemini Sandbox
```

### Repository identity persistence

The Repository ID shall be persisted in a `.sandbox` file at the repository root.

```jsonc
// .sandbox
{
  "id": "f3c1a2e0-...",   // stable UUID; the key sandboxes are associated with
  "name": "ainoflow"       // human-readable label shown in the Sandbox Explorer
}
```

Rules:

* On workspace open, the extension shall read `.sandbox` to discover the associated
  sandboxes (FR-002). Identity is keyed on `id`, never on the filesystem path or git remote.
* If `.sandbox` is absent, the extension shall generate it on first sandbox creation (FR-003).
* `.sandbox` is **gitignored** — it is local, per-developer and per-working-tree, not
  shared via git. A fresh clone generates a new identity; each git worktree of the repo
  gets its own `.sandbox`, so it can map to its own sandbox (enables parallel sandboxes
  per worktree).

> **v0.2 revision (see ARCHITECTURE §14):** `.sandbox` becomes a **folder**. The local
> identity is `.sandbox/identity.yaml` holding only `{ name }` (the `id` UUID is dropped —
> the sandbox name derives from `name`, not the UUID). The shared, **committed** recipe is
> `.sandbox/config.yaml` (FR-009). Only `.sandbox/identity.yaml` is gitignored;
> `config.yaml` and any `Dockerfile` are committed. Format is YAML, not JSON.

---

## FR-002 Sandbox Discovery

When a workspace is opened:

The extension shall automatically discover existing sandboxes.

Possible outcomes:

* Sandbox does not exist
* Sandbox exists and running
* Sandbox exists and stopped
* Sandbox exists and failed

---

## FR-003 Sandbox Creation

Users shall be able to create sandboxes from VS Code.

Creation should require a single action.

Example:

```text
Create Claude Sandbox
```

After creation:

* Sandbox starts automatically
* Agent launches automatically
* Terminal opens automatically

---

## FR-004 Sandbox Start

Users shall be able to start a stopped sandbox.

Example:

```text
Start Sandbox
```

State shall be preserved.

No recreation should occur.

---

## FR-005 Sandbox Attach

Users shall be able to attach to running sandboxes.

Example:

```text
Attach
```

The existing session becomes visible.

---

## FR-006 Sandbox Stop

Users shall be able to stop a sandbox.

Stopping must preserve:

* Authentication
* Installed packages
* Configuration
* History
* Agent state

---

## FR-007 Sandbox Rebuild / Recreate / Edit

The single v0.1 "Rebuild" is split into three distinct operations (see ARCHITECTURE §16):

* **Recreate** — `rm --force` + recreate from the recipe. **Destroys** sandbox state
  (host workspace untouched). Confirmation required.
* **Rebuild image** — re-build the custom image (FR-008) and recreate the sandbox from
  it. Refreshes image-baked tooling; work on the mounted workspace is preserved.
* **Edit** — add/rotate secrets or inject a kit into a **running** sandbox
  (non-destructive, no recreate).

## FR-008 Custom Environment (preinstalled tooling)

A sandbox shall optionally run on a **custom image** so dev tooling (e.g. .NET SDK) is
preinstalled, instead of the agent's default image.

* The image is referenced by the recipe (FR-009): `image:` is the tag; if `dockerfile:`
  is set, the extension builds that Dockerfile and tags it as `image:`
  (docker-compose semantics).
* Custom Dockerfiles must extend an agent base
  (`FROM docker/sandbox-templates:<flavor>`) so the agent binary, `agent` user, and proxy
  env survive (ARCHITECTURE §15). Build steps that need root use `USER root` … `USER agent`.
* Build pipeline (verified): `docker build` → `docker save` → `sbx template load` →
  `sbx run/create -t <image>`. **Rebuild image** re-runs this pipeline.
* Secrets shall **never** be baked into images — they are provisioned via FR-032.

## FR-009 Configuration Recipe

Per-repo sandbox configuration shall live in a committed, compose-like **`.sandbox/config.yaml`**
recipe (YAML), shared across clones/copies via git:

```yaml
version: 1
sandboxes:
  claude:                     # logical key → sandbox "<name>-claude"
    agent: claude             # sbx agent
    image: myrepo-dev:latest  # optional custom image
    dockerfile: Dockerfile    # optional; if set → build `image` from .sandbox/Dockerfile
    mount: direct             # optional: direct | clone
    secrets: [github]         # secret NAMES only (values via FR-032)
    ports: [5000, 5173]       # optional published ports
```

The recipe declares one or more sandboxes per repo (multi-agent, e.g. `claude` + `shell`).
Identity (the local label) is kept separately and gitignored (FR-001).

---

# 6. Terminal Requirements

## FR-010 Terminal Emulation

The terminal shall behave like a native terminal.

Supported capabilities:

* ANSI colors
* Cursor movement
* Shell prompts
* Interactive applications
* Keyboard shortcuts
* Terminal resize
* Scrolling
* Streaming output

---

## FR-011 PTY Support

The terminal implementation shall use PTY-based execution.

Interactive applications must function correctly.

Examples:

* Claude Code
* Codex
* Vim
* Nano
* Bash
* Zsh
* PowerShell
* Git

---

## FR-012 Multiple Terminal Tabs

Users shall be able to open multiple terminals.

Example:

```text
Claude Sandbox
Codex Sandbox
Gemini Sandbox
Shell Sandbox
```

Each tab shall operate independently.

---

# 7. Agent Requirements

## FR-020 Claude Support

Users shall be able to launch Claude Code directly.

Example:

```text
Open Claude
```

---

## FR-021 Codex Support

Users shall be able to launch Codex directly.

Example:

```text
Open Codex
```

---

## FR-022 Generic Agent Support

The platform shall support future agents.

Examples:

* Gemini CLI
* OpenAI Agents
* Aider
* Custom MCP Agents

---

# 8. Persistence Requirements

## FR-030 Authentication Persistence

The system shall preserve:

* Claude authentication
* Codex authentication
* GitHub authentication
* Git credentials

---

## FR-031 Development State Persistence

The system shall preserve:

* Shell history
* Installed packages
* Environment variables
* Local configuration
* Cache directories

Examples:

* npm cache
* pip cache
* cargo cache
* Claude configuration
* Codex configuration

---

## FR-032 Secret Provisioning (UX)

The extension shall provision service secrets from the UI, so users never run `sbx secret`
by hand (see ARCHITECTURE §8).

* The recipe (FR-009) lists required secret **names** (e.g. `github`); the extension reads
  `sbx secret ls` and prompts only for the ones not already satisfied.
* Values are entered in a password input and piped via
  `sbx secret set [-g | <sandbox>] <service> --password-stdin` — never shown in shell
  history, never written to the repo, never baked into images.
* Scope is user-chosen: **per-sandbox** (deliberate for repo-scoped tokens) or global `-g`
  (shared creds like the Anthropic key).
* `anthropic` remains satisfied by the host-global OAuth/keychain credential by default
  (no per-sandbox login).

---

# 9. Workspace Integration

## FR-040 Automatic Workspace Mount

Current project shall be mounted automatically.

Example:

```text
Host
 └─ Repository

Sandbox
 └─ /workspace
```

No manual configuration required.

---

## FR-041 Git Integration

Git operations inside sandbox shall operate against the mounted repository.

Examples:

* commit
* branch
* merge
* rebase
* diff

---

# 10. Sandbox Explorer

A dedicated VS Code sidebar shall be available.

Example:

```text
SANDBOXES

Ainoflow
 ├─ Claude
 ├─ Codex

ERP
 ├─ Claude

CRM
 ├─ Codex
```

---

## Status Indicators

```text
● Running
○ Stopped
⚠ Failed
```

---

# 11. Commands

## Sandbox Commands

```text
Sandbox: Create
Sandbox: Start
Sandbox: Stop
Sandbox: Restart
Sandbox: Attach
Sandbox: Rebuild
Sandbox: Delete
```

## Agent Commands

```text
Open Claude
Open Codex
Open Gemini
Open Shell
```

---

# 12. Security Requirements

## Isolation

Sandboxes shall be isolated from the host system.

---

## Filesystem Policies

Supported modes:

```text
Workspace Only
Workspace + Readonly Host
Full Access
```

---

## Network Policies

Supported modes:

```text
Full Internet
Restricted Internet
No Internet
```

---

# 13. Future MCP Support

Each sandbox may optionally expose an MCP endpoint.

Example:

```text
Claude Sandbox
 └─ MCP Server

Codex Sandbox
 └─ MCP Server
```

Potential use cases:

* Agent collaboration
* Shared tools
* Shared context
* Workflow orchestration

---

# 14. Success Criteria

A successful implementation allows a developer to:

1. Open a repository
2. Click Attach
3. Continue using Claude or Codex immediately

Expected workflow:

```text
Open Repository
        ↓
Attach Sandbox
        ↓
Terminal Opens
        ↓
Agent Available
        ↓
Continue Working
```

The developer should feel they are working in a normal VS Code terminal while all execution occurs inside a persistent isolated sandbox.
