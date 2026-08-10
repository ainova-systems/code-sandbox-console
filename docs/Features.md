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

Discovery is **always silent and read-only**: opening a workspace never raises
notifications and **never writes into `.sandbox/`**. Its results surface passively in
the status bar item (state icon + display name; `+ New Sandbox` when nothing is defined)
and the Sandboxes view — Connect is one click away in either place. Silent about
*sandboxes*, not about the host: when the prerequisites for running one are missing, both
surfaces report that instead (FR-059) — still passively, still writing nothing. The local
`identity.yaml`, the `.gitignore`, and the generated `sbx.sh` are created only when the
user creates their first sandbox (New Sandbox save, or Connect/Shell on a recipe entry),
not by merely opening a project — so a repo whose `config.yaml` is committed by the team
stays clean for anyone who only wants to read it (FR-001 generates the id on first use).

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

A create is refused up front when the workspace cannot serve the sandbox's mount mode —
network/WSL paths (FR-040) and a shallow repository under `mount: clone` (FR-058).

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
  Every rebuild starts from the freshest obtainable image (FR-053); the build streams
  into the progress box and can be cancelled from it (FR-055/FR-056).
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
  `sbx run/create -t <image>`. **Rebuild image** re-runs this pipeline with a forced
  base-image pull (FR-053).
* This is the **only** mode that needs host Docker — `sbx` itself does not (FR-059). The
  form states the requirement in the *Custom: Dockerfile* block, distinguishing *not
  installed* from *installed but the engine is not running*. The *Custom: image* mode is
  pulled by sbx and needs no host Docker.
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

**The UI follows the recipe.** `.sandbox/config.yaml` is a file users are told to edit by
hand, and it also changes under a git pull or in another VS Code window. The extension
watches it (and `identity.yaml`): a change refreshes the Sandboxes view and the status bar
and invalidates the sandbox refs resolved from it, so an edited key takes effect
immediately instead of Connect going out under the previous sandbox name. Watching keeps
discovery event-driven and read-only (FR-002) — the watcher observes, it never writes.

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
  never written to the repo, never baked into images, and never in the operation log
  (FR-055 records that the call happened and its exit code, nothing else).
* Scope is user-chosen: **per-sandbox** (deliberate for repo-scoped tokens) or global `-g`
  (shared creds like the Anthropic key).
* `anthropic` remains satisfied by the host-global OAuth/keychain credential by default
  (no per-sandbox login).
* The form separates **global** (host-shared, read-only) credentials from **custom**
  (this-sandbox) ones. For `github`, beyond the proxy secret the extension also runs
  `gh auth login --with-token` inside the sandbox (best-effort, only if `gh` is present)
  so the `gh` CLI itself is authenticated — see Architecture §8.

---

## FR-051 Per-Project Secret Cache

The extension shall cache secret values per project, so a fine-grained (repo-scoped)
token is entered **once** and reused for every new sandbox and runner of that project —
without making it global to all projects (see Architecture §8).

* Cached values live in `~/.sbx/<entry>.<service>.dpapi` blobs, encrypted for the
  current OS user (Windows DPAPI; other platforms currently degrade to no-cache).
  The same files are read by the generated project CLI (FR-052) — one store for UI
  and shell automation, plus a `GITHUB_SANDBOX_PAT`-style env fallback for CI.
* Provisioning (FR-032) becomes **pick-or-enter**: a Quick Pick over cached entry
  *names* for the service (current project first; values are never displayed) plus
  *Enter new value…*. A new value can be cached as the project entry, under another
  name (e.g. `shared`), or used once. With an empty cache the picker is skipped.
* `Sandbox: Manage Cached Secrets` lists, renames, and deletes entries (names only).
* FR-032 invariants are unchanged: values move only over stdin/stdout pipes — never
  argv, env vars, the repo, or an image.

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

## FR-058 Clone Mount Preflight

A sandbox shall never be created into a workspace its mount mode cannot serve.

* **`mount: clone` requires an unshallowed repository.** sbx copies the repo into the
  sandbox with `git clone --reference <read-only host mount>`, and git refuses a shallow
  source (`--depth` clone or fetch). The create itself still succeeds, so the failure is
  invisible from the extension: it happens inside the sandbox at start-up and leaves the
  agent in an **empty workspace**.
* Creating such a sandbox is therefore **refused before the first sbx call** — on Connect,
  Shell and Rebuild alike — in a **modal dialog** that names the cause, the fix
  (`git fetch --unshallow`, and what running it does to the working copy) and the
  alternative (`mount: direct`, which clones nothing). Modal because it ends the action the
  user just asked for, and the explanation does not fit a notification's one line.
* The extension does not run the fix: fetching the missing history changes what the user's
  repository contains, so it is theirs to run (the same rule that keeps discovery
  non-mutating, FR-002). **Open Terminal** opens a host terminal in the repository with the
  command typed in and *not* executed — the Enter stays with the user.
* The check fails open — no git on the host, or a workspace outside any repository, does
  not block a create. sbx rejects a non-repository workspace itself, before creating
  anything; shallowness is the one precondition it does not check.
* `mount: direct` is unaffected — nothing is cloned. An existing sandbox already created
  this way is not repaired automatically: unshallow, then **Rebuild**.
* The generated project CLI (FR-052) refuses the same case in its create path.

---

## FR-059 Prerequisite Readiness

A host that cannot run sandboxes shall **say so**, naming the missing prerequisite —
never fall silent and never claim the repo has no sandboxes.

* **`sbx` is the only product-wide prerequisite.** Docker Sandboxes runs its own daemon;
  per Docker's documentation *"Docker Desktop is not required to use `sbx`"*. Host Docker
  is required by **one feature** — the custom Dockerfile build (FR-008), and the image
  refresh that precedes a rebuild (FR-053) — so it is never reported as a product
  requirement.
* **Readiness comes from the installation's own report**, `sbx diagnose`, which names which
  precondition failed (CLI binary, daemon, version match, storage, permissions, socket,
  authentication) and carries the CLI's remedy text. Three outcomes are distinguished:
  **not found**, **not signed in**, and **not healthy** (reported in the CLI's own words,
  so a check added by a future version is not flattened into "unknown error"). Only a
  failed check blocks; a warning does not.
* **The status bar states it** — `⚠ Sandbox not available`, with the missing piece and its
  remedy in the tooltip. It is not hidden: hiding made a missing `sbx` and a missing
  *extension* look identical.
* **The Sandboxes view states it** — a single readiness node replaces the tree, instead of
  the "No sandboxes yet for this repo" welcome, which is false whenever the committed
  recipe (FR-009) defines sandboxes and points at New Sandbox, the one action that cannot
  work. The same applies when sandbox state cannot be read at all: entries are not rendered
  as *not created*, a state nobody verified.
* **New Sandbox is refused in a modal** naming the prerequisite, where the extension looked
  for it, and the follow-up (`sbx login`), with a link to
  <https://docs.docker.com/ai/sandboxes/>. Modal because it ends the action the user just
  asked for (as FR-058); the form does not open, so nothing is written to `.sandbox/` for a
  sandbox that could not be created. No per-OS install command is executed or suggested —
  Docker's page covers the platforms.
* **`Sandbox: Check Prerequisites`** re-runs the report on demand: it is what the warning
  indicator and the readiness node open, and it makes an install or a `sbx login` take
  effect without reloading the window (executable paths are re-resolved on every miss for
  the same reason).
* **The custom-image Docker requirement is stated where it is chosen** — in the New/Edit
  form's *Custom: Dockerfile* block, not minutes later at Create. *Installed* and *engine
  not running* are told apart (a client-only `docker --version` succeeds while the engine
  is stopped). It is advisory: the build itself stays the gate, since Docker may be started
  in between.
* Readiness is **not** discovery: nothing here writes into `.sandbox/` or raises a
  notification when a workspace is opened (FR-002 is unchanged).

---

# 10. Sandbox Explorer

A dedicated VS Code sidebar shall be available, **scoped to the current repo**.

Nodes are this repo's recipe sandboxes (label = `title || key`), optionally grouped into
folders by `group`. Per-node actions are **state-gated**, enforcing the lifecycle
running → Stop → Edit/Rebuild/Delete instance → Remove from config. Two deletes:
**Delete instance** (destroys the sandbox, keeps the definition — recreatable) vs
**Remove from config** (drops it from `config.yaml`, shown only once the instance is
gone). See Architecture §12.

Every slow lifecycle action (Create, Stop, Delete instance, Rebuild/Recreate) shows a
progress notification while it runs — so clicking an action is never a silent gap. The
box reports the running command's latest output line (FR-055), the long ones can be
cancelled from it (FR-056), and only one operation per sandbox can be in flight at a
time (FR-054). Terminal-based Connect/Shell are their own feedback (the terminal opens
at once). See Architecture §12.

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

When the host prerequisites are missing the item shows `⚠ Sandbox not available` instead,
and clicking it re-runs the readiness report rather than offering a sandbox (FR-059).

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
⚠ Sandbox not available   (host prerequisite missing — FR-059)
```

The implemented state model is `absent | running | stopped` — discovery (FR-002)
surfaces any failed/error status reported by sbx as **Stopped**; a distinct ⚠ Failed
indicator is not implemented. The ⚠ above is about the **host**, not a sandbox: it
replaces the whole indicator when no sandbox state can be established at all.

---

# 11. Commands

Palette commands (category **Sandbox**):

```text
Connect               — create-or-attach the active sandbox; Start/Attach folded in (sbx run resumes)
Stop
Shell
Rebuild
Switch Sandbox        — pick the active sandbox from the recipe list (FR-050)
New Sandbox           — the agent is picked in the form; no per-agent Open commands
Manage Cached Secrets — list/rename/delete per-project cached secret entries (FR-051)
Show Log              — reveal the operation log (FR-055)
Check Prerequisites   — re-run the host readiness report (FR-059)
Refresh
```

Explorer-only per-node actions (Architecture §12): `Connect`, `Stop`, `Shell`,
`Rebuild`, `Edit`, `Delete instance`, `Remove from config`.

There is no separate Start/Restart/Delete palette command.

---

## FR-052 Generated Project CLI

The extension shall generate a committed bash script, `.sandbox/scripts/sbx.sh`, that
exposes the same sandbox model to shells and AI skills (CLI automation), so they call
subcommands instead of re-encoding naming/lifecycle/secret rules as prose
(see Architecture §13).

* Subcommands: `name`, `status`, `connect`, `stop`, `rm`, `rebuild`, `exec`, `task`
  (headless `claude -p`, foreground/background/cost-reporting), `runner-create` /
  `runner-rm` / `runners` (ephemeral clone-mode runners off the `default: true` entry,
  named `<name>-<key>-<id>-p<slug>`, guarded removal), `secret-github` (the FR-051
  chain), `version`.
* The script derives everything at run time from the recipe and identity files — it
  contains no secrets and no project-specific values, and is regenerated only on
  extension upgrades (version + content hash in the header; manual edits are never
  overwritten silently). It is **seeded when the first sandbox is created** (form save),
  not by opening a project: activation only refreshes an already-present script, so a
  passive open never adds it (FR-002).
* The extension **never executes** the generated script — generation is one-way
  (a committed script is repo-controlled input).
* Preconditions mirror the UI's: the create path refuses `mount: clone` on a shallow
  repository with the same message and the same fail-open rule (FR-058).

## FR-053 Fresh Image Rebuild

Rebuild shall always start from the freshest obtainable image, per environment kind
(see Architecture §7/§11); `sbx` itself caches images until `sbx reset` and offers no
pull/update command, so the extension owns the refresh:

* **Custom Dockerfile** — the build runs `docker build --pull`, re-fetching the agent
  base image. A failed pull fails the build.
* **Pulled custom image** (`image` without `dockerfile`) — `docker pull` →
  `docker save` → `sbx template load` replaces the stored template. Best-effort: when
  the pull fails (offline, or a local-only image), the rebuild warns and continues from
  the cached template; the template is never removed.
* **Default agent image** — the matching `docker/sandbox-templates` entries are removed
  from the sbx store before recreation, so the create re-pulls the current image.

Existing sandboxes are persistent microVMs and are never affected by a refresh; a fresh
image applies only to sandboxes created or rebuilt afterwards. The generated project CLI
(FR-052) mirrors the same semantics in its `rebuild` subcommand.

---

## FR-054 One Operation Per Sandbox

At most one lifecycle operation (Connect, Shell, Stop, Rebuild, Delete) shall be in
flight per sandbox at any time, and the UI that starts one shall show that it is running.

* A second action on a busy sandbox is **declined, not queued**: the extension names the
  operation already running and offers **Show Log** (FR-055). Attaching the second click
  to the first operation would look like it worked and then produce one outcome for two
  requests.
* Different operations are mutually exclusive too — a Stop landing in the middle of a
  Rebuild's recreate is the same race as a second Rebuild. Distinct sandboxes are
  independent and may run in parallel.
* **Remove from config** destroys the instance before dropping the recipe entry; a
  *declined* destroy keeps the entry, exactly as a failed one does, so a live microVM is
  never orphaned.
* **A busy sandbox looks busy.** Its Explorer node shows a spinner and the running
  operation, and its actions are hidden for the duration — the guard would decline them
  anyway, and an action you can click but not use is a lie about the state. Once cancel is
  pressed the node says *cancelling*, since the work can outlive the click (FR-056).
* The New/Edit form's **Save** disables itself and the rest of the form for the duration
  of the save, showing the running phase (*Creating…* / *Applying…*), and is handed back
  if the save fails with the panel still open.

See Architecture §12.

---

## FR-055 Operation Log

Every `sbx` and `docker` process the extension runs shall be visible in a **Sandbox
Console** output channel while it runs, reachable via `Sandbox: Show Log`, the Sandboxes
view's overflow menu, and a **Show Log** action on every error notification.

* Each invocation is bracketed by a `$ <exe> <args…>` header and a
  `→ exit <code> (<duration>)` footer; the child's output is streamed through verbatim,
  so a multi-minute `docker build` is readable as it happens rather than only after it
  ends. Every line carries an `[n]` invocation tag: operations on *different* sandboxes
  run in parallel (FR-054 serialises one sandbox, not the machine) and their output
  interleaves.
* The most recent output line is also shown as the **progress notification's message**, so
  the spinner reports what is happening (`#8 [4/9] RUN npm install`) instead of standing
  still. Stages that move data while printing nothing (`docker save`, `sbx template load`)
  announce themselves, so the box never sits on a stale line through a long silent step.
* Discovery and probe calls (`sbx ls --json`, `template ls`, `--help`) run on focus
  change and tree render and are logged **only when they fail** — which is a gain, since
  several of those callers otherwise degrade silently.
* Secret values never reach the channel (FR-032).

---

## FR-056 Cancellable Operations

Long operations shall be cancellable from their progress notification.

* Cancellable: the image build/refresh (`docker build --pull`, `docker pull`,
  `sbx template load/rm`) and `sbx create` — the ones that pull images and take minutes.
  `sbx stop` and `sbx rm` are **not** cancellable: interrupting them is strictly worse
  than waiting the few seconds they take.
* Cancelling **abandons the entire operation** — a cancelled build never falls through to
  the recreate that follows it.
* **Only `docker` children are killed.** An abandoned `docker build` leaves cache layers:
  BuildKit finishes what it already started server-side, so a later rebuild is faster,
  never corrupt, and there is nothing to undo.
* **`sbx` children are never killed; a cancelled create is undone instead.** Cancelling
  waits for `sbx create` to finish and then removes the sandbox (`sbx rm --force`),
  returning to `absent` — the state the create started from. The end state is what the
  user asked for, but a cancel can take as long as the create it undoes (a `--clone`
  create keeps cloning to the end), so both the notification and the Explorer node say
  *cancelling* for the whole wait. A rollback that cannot complete says so and names the
  sandbox to remove by hand.
* The report names the state left behind, because the middle of a Rebuild is not
  undoable: cancelled during the build the sandbox is untouched; cancelled after the
  removal, the previous instance is gone and Connect recreates it.

---

## FR-057 Truthful Sandbox Names

Sandbox names shall say what the sandbox is, and a name that cannot be created shall
never be derived again.

* **New-sandbox keys derive from the title.** At **creation only**, the key is seeded from
  the entered title, sanitised to the key charset (`Backend API (v2)` → `backend-api-v2`),
  falling back to the agent id when the title is empty or sanitises away (e.g. a fully
  non-ASCII title). The uniqueness suffix (`-2`, `-3`, …) stays for genuine collisions.
* **The key is then frozen forever.** The form locks it in edit mode, so renaming a title
  never touches the sandbox name, the generated Dockerfile, or the image tag: the rule is
  that the key must not *track* the title, and seeding it once does not.
* Consequence, accepted deliberately: the default Dockerfile name follows the key
  (`<key>.Dockerfile`), so two sandboxes on the same agent no longer *default* to one
  shared Dockerfile and one shared image. Sharing stays available — typing the same file
  name in both — and is now explicit rather than accidental.
* **Names that cannot be created are remembered.** When `sbx create` fails because the
  name is still claimed by leaked sbx runtime state (a known upstream defect with no
  released fix — Architecture §14), the name is recorded **per working copy** and key
  derivation skips any candidate that would produce it. Previously a key freed by a rename
  or a removal was handed straight to the next new sandbox, which walked the user back
  into the same permanently failing name.
* The record is local, never committed, stores names only (it never removes sandboxes),
  and `sbx reset` makes it irrelevant.

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
