# Features — Sandbox Console for VS Code

> **Status:** Current business/functional truth for the shipped extension — every
> statement below describes the product as it is **now**. Requirement IDs (`FR-0xx`)
> are stable and cited throughout the code and commits; never renumber them.
> History and the reasoning behind past changes live in append-only iteration specs
> under [`specs/`](specs/). Technical design: [Architecture.md](Architecture.md).

## 1. Overview

Sandbox Console provides a terminal-first experience inside VS Code, allowing developers
to run AI coding agents such as Claude Code, Codex, Gemini CLI, and future agents inside
isolated persistent sandboxes.

The experience must feel identical to using a normal terminal window while providing
isolation, persistence, and security through sandbox execution.

The user should not need to understand Docker, containers, virtual machines, or sandbox
lifecycle management.

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

When a project has no sandbox, the extension stays **quiet** — no startup notification.
The entry points are passive:

```text
status bar:        + New Sandbox
Sandboxes view:    No sandboxes yet for this repo.  [ New Sandbox ]
```

(`Connect`/`Shell` palette commands route to the form too.)

User selects an agent (and optional environment) in the New Sandbox form.

Sandbox is created automatically.

Terminal opens automatically.

Agent starts automatically.

There is no implicit default sandbox — every sandbox is defined explicitly via the form
and recorded in the committed recipe (FR-009).

---

## Returning Project

When a sandbox already exists, its state is surfaced **passively** — startup never
raises notifications. The status bar shows the active sandbox with its live state,
one click from Connect:

```text
status bar:        ● Backend   (running)   /   ○ Backend   (stopped)
Sandboxes view:    per-sandbox state + Connect
```

The default action must always be resume. (**Connect** is the UI label for the attach
action; the underlying sbx operation is `sbx run <name>`, which auto-resumes a stopped
sandbox — there is no separate Start.)

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
Connect
```

(the attach action) must always be the primary action.

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

Repository state lives in a `.sandbox/` folder at the repository root, split by git
treatment (see Architecture §6):

* `.sandbox/config.yaml` — **committed**, the shared recipe (FR-009) including the
  project `name`.
* `.sandbox/identity.yaml` — **gitignored**, a short random local `id` (the extension
  also writes `.sandbox/.gitignore` so the id is never committed).

The sbx sandbox name is `<name>-<key>-<id>`. The local `id` makes clones, copies, and
git worktrees conflict-free: each working tree generates its own on first use and so
maps to its own sandboxes (enables parallel sandboxes per worktree).

Example:

```text
my-repo
 ├─ Claude Sandbox
 ├─ Codex Sandbox
 └─ Gemini Sandbox
```

---

## FR-002 Sandbox Discovery

When a workspace is opened:

The extension shall automatically discover existing sandboxes.

Possible outcomes:

* Sandbox does not exist
* Sandbox exists and running
* Sandbox exists and stopped
* Sandbox exists and failed

Discovery is **always silent**: opening a workspace never raises notifications. Its
results surface passively in the status bar item (state icon + display name; `+ New
Sandbox` when nothing is defined) and the Sandboxes view — Connect is one click away
in either place.

---

## FR-003 Sandbox Creation

Users shall be able to create sandboxes from VS Code.

Creation should require a single action once the agent is chosen.

Example:

```text
New Sandbox → pick agent → Create
```

Creation goes through the New Sandbox form — agent, optional title/group, secrets,
ports, environment — never a hand-edited YAML file.

After creation:

* Sandbox starts automatically
* Agent launches automatically
* Terminal opens automatically

---

## FR-004 Sandbox Start

Users shall be able to start a stopped sandbox.

Starting is folded into **Connect** (`sbx run` auto-resumes a stopped sandbox).

State shall be preserved.

No recreation should occur.

---

## FR-005 Sandbox Attach

Users shall be able to attach to running sandboxes (UI label: **Connect**).

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

"Rebuild" covers three distinct operations (see Architecture §11):

* **Recreate** — `rm --force` + recreate from the recipe. **Destroys** sandbox state
  (host workspace untouched). Confirmation required.
* **Rebuild image** — re-build the custom image (FR-008) and recreate the sandbox from
  it. Refreshes image-baked tooling; work on the mounted workspace is preserved.
* **Edit** — add/rotate secrets and published ports on a **running** sandbox
  (non-destructive, no recreate). Kit injection (`sbx kit add`) is a planned follow-up
  (Architecture §7).

## FR-008 Custom Environment (preinstalled tooling)

A sandbox shall optionally run on a **custom image** so dev tooling (e.g. .NET SDK) is
preinstalled, instead of the agent's default image.

* The image is referenced by the recipe (FR-009): `image:` is the tag; if `dockerfile:`
  is set, the extension builds that Dockerfile and tags it as `image:`
  (docker-compose semantics).
* The New/Edit form's *Custom: Dockerfile* choice takes an optional **file name** under
  `.sandbox/` (empty → `<key>.Dockerfile`). A missing file is generated `FROM` the
  **selected agent's base template** (the `-docker` flavor the CLI boots by default);
  an existing file is reused as-is — several sandboxes can share one committed
  Dockerfile and the image built from it (derived tag `<project>:<dockerfile stem>`).
* Custom Dockerfiles must extend an agent base
  (`FROM docker/sandbox-templates:<flavor>`) so the agent binary, `agent` user, and proxy
  env survive (Architecture §7). Build steps that need root use `USER root` … `USER agent`.
* Build pipeline (verified): `docker build` → `docker save` → `sbx template load` →
  `sbx run/create -t <image>`. **Rebuild image** re-runs this pipeline.
* Secrets shall **never** be baked into images — they are provisioned via FR-032.

## FR-009 Configuration Recipe

Per-repo sandbox configuration shall live in a committed, compose-like **`.sandbox/config.yaml`**
recipe (YAML), shared across clones/copies via git:

```yaml
version: 1
sandboxes:
  claude:                     # logical key → sandbox "<name>-claude-<id>"
    agent: claude             # sbx agent
    image: myrepo-dev:latest  # optional custom image
    dockerfile: Dockerfile    # optional; if set → build `image` from .sandbox/Dockerfile
    mount: direct             # optional: direct | clone
    secrets: [github]         # secret NAMES only (values via FR-032)
    ports: [5000, 5173]       # optional published ports
    default: true             # optional: the sandbox the status bar / palette target (FR-050)
```

The recipe declares one or more sandboxes per repo (multi-agent, e.g. `claude` + `shell`).
Identity (the local id) is kept separately and gitignored (FR-001).

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

Each tab shall operate independently. (One **agent** terminal per sandbox is reused —
a second attach would race the same session; multiple **shell** terminals are fine.)

---

# 7. Agent Requirements

## FR-020 Claude Support

Users shall be able to launch Claude Code directly.

---

## FR-021 Codex Support

Users shall be able to launch Codex directly.

---

## FR-022 Generic Agent Support

The platform shall support future agents.

Examples:

* Gemini CLI
* OpenAI Agents
* Aider
* Custom MCP Agents

The agent list is discovered live from the installed `sbx` (static fallback), so new
agents appear in the New Sandbox form without an extension update.

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
by hand (see Architecture §8).

* The recipe (FR-009) lists required secret **names** (e.g. `github`); the extension reads
  `sbx secret ls` and prompts only for the ones not already satisfied (re-checked on
  every Connect/Shell, so a cancelled prompt is recoverable).
* Values are entered in a password input and piped over stdin to
  `sbx secret set [-g | <sandbox>] <service>` (no flag — `--password-stdin` is a
  registry-login option, not used for service secrets) — never in argv or shell history,
  never written to the repo, never baked into images.
* Scope is user-chosen: **per-sandbox** (deliberate for repo-scoped tokens) or global `-g`
  (shared creds like the Anthropic key).
* `anthropic` remains satisfied by the host-global OAuth/keychain credential by default
  (no per-sandbox login).
* The form separates **global** (host-shared, read-only) credentials from **custom**
  (this-sandbox) ones. For `github`, beyond the proxy secret the extension also runs
  `gh auth login --with-token` inside the sandbox (best-effort, only if `gh` is present)
  so the `gh` CLI itself is authenticated — see Architecture §8.

---

# 9. Workspace Integration

## FR-040 Automatic Workspace Mount

Current project shall be mounted automatically. No manual configuration required.

With the direct mount on Windows, each host drive is mounted at `/<drive-letter>`:

```text
Host                          Sandbox
 └─ D:\Repositories\app   →    └─ /d/Repositories/app
```

(`/home/agent/workspace` is an unrelated empty directory, not the mount.) Workspaces on
UNC / `\\wsl$` network paths are not supported and are rejected with a clear error.

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

A dedicated VS Code sidebar shall be available, **scoped to the current repo**.

Nodes are this repo's recipe sandboxes (label = `title || key`), optionally grouped into
folders by `group`. Per-node actions are **state-gated**, enforcing the lifecycle
running → Stop → Edit/Rebuild/Delete instance → Remove from config. Two deletes:
**Delete instance** (destroys the sandbox, keeps the definition — recreatable) vs
**Remove from config** (drops it from `config.yaml`, shown only once the instance is
gone). See Architecture §12.

Example:

```text
SANDBOXES — my-repo

Services
 ├─ ● Backend     (claude)
 └─ ○ Frontend    (claude)
● Shell           (shell)
```

---

## Status Bar & Default Sandbox (FR-050)

A status bar item shows the **active** sandbox — its display name (`title || key`) with
the live state icon; the agent is in the tooltip. Clicking it (or running
`Sandbox: Switch Sandbox`):

* one defined sandbox → connects directly;
* several → a Quick Pick of all recipe sandboxes (state, agent, default marker) plus
  **New Sandbox…**; picking one connects and makes it the locally active sandbox;
* none → the New Sandbox form.

The sandbox the single-action commands (Connect / Stop / Shell / Rebuild) target
resolves as: **locally last-picked** (per working copy) → the recipe's **`default: true`**
entry (committed/shared; settable via a checkbox in the New/Edit form, single default
per recipe) → the **first** recipe entry.

---

## Status Indicators

```text
● Running
○ Stopped
+ Not created
```

The implemented state model is `absent | running | stopped` — discovery (FR-002)
surfaces any failed/error status reported by sbx as **Stopped**; a distinct ⚠ Failed
indicator is not implemented.

---

# 11. Commands

Palette commands (category **Sandbox**):

```text
Connect         — create-or-attach the active sandbox; Start/Attach folded in (sbx run resumes)
Stop
Shell
Rebuild
Switch Sandbox  — pick the active sandbox from the recipe list (FR-050)
New Sandbox     — the agent is picked in the form; no per-agent Open commands
Refresh
```

Explorer-only per-node actions (Architecture §12): `Connect`, `Stop`, `Shell`,
`Rebuild`, `Edit`, `Delete instance`, `Remove from config`.

There is no separate Start/Restart/Delete palette command.

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

(Policy **UIs** are deferred; the underlying sbx policies apply — see Architecture §9.)

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
2. Click Connect
3. Continue using Claude or Codex immediately

Expected workflow:

```text
Open Repository
        ↓
Connect to Sandbox
        ↓
Terminal Opens
        ↓
Agent Available
        ↓
Continue Working
```

The developer should feel they are working in a normal VS Code terminal while all
execution occurs inside a persistent isolated sandbox.
