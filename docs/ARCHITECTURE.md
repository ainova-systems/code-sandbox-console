# Architecture — Ainoflow Sandbox Terminal

> **Status:** Draft, tracks the v0.1 walking skeleton.
> **Companion docs:** [FRD.md](FRD.md) (requirements). Requirement IDs (`FR-0xx`)
> below refer to that document.
> **Upstream reference (authoritative for `sbx` behaviour — read before changing any
> backend assumption):** Docker Sandboxes docs, <https://docs.docker.com/ai/sandboxes/>.
> Customization specifics:
> [build-an-agent](https://docs.docker.com/ai/sandboxes/customize/build-an-agent/),
> [templates](https://docs.docker.com/ai/sandboxes/customize/templates/),
> [kits](https://docs.docker.com/ai/sandboxes/customize/kits/),
> [kit-examples](https://docs.docker.com/ai/sandboxes/customize/kit-examples/).

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

A repository is identified by a **gitignored, per-working-tree** `.sandbox` file at its root:

```json
{ "id": "f3c1a2e0-…", "name": "code-sandbox-console" }
```

- `id` (UUID) is the stable, canonical identity for *this* working tree (it moves with
  the directory; a fresh clone or a new git worktree gets its own — enabling
  per-worktree parallel sandboxes, see §12).
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

**v0.2 plan (supersedes "provisions nothing"):** the extension provisions secrets *on
request* via a form that runs `sbx secret set [-g | <sandbox>] <service>
--password-stdin` — values flow through stdin (never in shell history) and are **never**
baked into images or env. The recipe (§14) lists required secret **names** only; the form
reads `sbx secret ls` and prompts solely for the missing ones. Scope is user-chosen:
per-sandbox is a valid, deliberate choice (e.g. a repo-scoped GitHub token), global `-g`
for shared creds. This satisfies FR-030 without weakening the credential-isolation model.

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
- **No persistent attach affordance.** The Attach/Create prompt fires only on activation
  (`onStartupFinished`). If dismissed, or if the sandbox is stopped mid-session, there is
  no visible control to re-attach — only the `Sandbox: Attach` command in the palette
  (which does work: it resumes a stopped sandbox via `sbx run <name>`). Fix: a Status Bar
  item reflecting state + click-to-Attach, and/or the deferred Sandbox Explorer (§10).
- **Remote Control is incompatible with the sbx credential proxy (by design).** Claude
  Code's Remote Control fails inside a sandbox with 401/403. Root cause confirmed: sbx's
  network policy is allow-all and blocks nothing (`policy log` → `blocked_hosts: []`); the
  errors come from Anthropic. The proxy forwards `api.anthropic.com` and injects its
  inference-scoped credential, while the sandbox only ever holds the `proxy-managed`
  sentinel — so the Remote Control client cannot run the interactive `/login` session or
  mint the short-lived, purpose-scoped session credentials it needs. Inference-only
  credentials cannot establish Remote Control sessions (per Claude Code docs). Treat as a
  known limitation: run Remote Control from a host (non-sandboxed) Claude Code.

## 12. Deferred scope (post-v0.1)

Sandbox Explorer sidebar (FRD §10), additional agents and multiple terminal tabs
(FR-012, FR-021/022), Rebuild/Delete commands (FR-007), filesystem/network policy
UIs (§12), and MCP endpoints (§13). The backend already supports several of these
(`sbx rm`, `--clone`, multi-agent registry), so they are mostly UI/wiring work.

**Parallel sandboxes on the same repo (discussion, undecided).** Today naming pins one
sandbox per (repo, agent), and direct mount binds the single working tree — so two
agents on the same tree in parallel would race/corrupt. Two isolation paths enable it:
*(a) git worktrees* — `git worktree add` a per-task dir on its own branch, mount each
into its own sandbox. Per the workflows docs the in-sandbox agent **cannot use git** in a worktree (its `.git` pointer resolves outside the mounted dir) — commit from the host, or use `--clone` for in-sandbox git. Because `.sandbox` is
gitignored and per-working-tree, **each worktree already gets its own identity and thus
its own sandbox for free** — "parallel" reduces to "open each worktree as a normal
single-sandbox project", and the only new work is worktree create/cleanup. *(b)
`sbx --clone`* — sandbox-managed private clone (host repo read-only), work retrieved via
the `sandbox-<name>` git remote; stronger isolation, but an extra fetch to integrate.
Worktrees fit our model best; `--clone` is the harder-isolation alternative. Cost in
both: N microVMs = N×RAM, and managing multiple instances needs the Explorer/picker UI.

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
| Custom-image pipeline (build → save → `template load` → `create -t`) | ✅ verified live (spike): built `FROM docker/sandbox-templates:claude-code`, baked a marker, ran from the custom template — `agent` user + `claude` v2.1.79 + marker all present; FLAVOR auto-inherited |
| v0.2 extension (config recipe, `.sandbox/` identity, image build, secret provisioning, Configure webview, Sandbox Explorer tree) | ✅ `tsc --noEmit` clean + esbuild bundles + `vsce` manifest validates; ⏳ runtime flows (webview, tree actions, live secret set / image build through the UI) pending F5 manual validation |

## 14. Configuration recipe & identity (v0.2 design)

Identity and configuration are split **by git treatment**, because they need opposite
handling: the **recipe** is shared (committed, travels with the repo/copy); the
**identity** is local (gitignored, per-working-tree). A single file cannot be
half-committed, so state moves from the v0.1 single `.sandbox` file into a `.sandbox/`
**folder** (mirrors `.devcontainer/`):

```text
.sandbox/
  config.yaml      # committed   — the shared recipe (compose-like)
  identity.yaml    # gitignored  — local label only
  Dockerfile       # committed   — optional custom image, referenced by config
```

`.gitignore`: only `.sandbox/identity.yaml` is ignored; `config.yaml` and any `Dockerfile`
are committed.

**Identity (`identity.yaml`)** — just a human label:

```yaml
name: code-sandbox-console
```

The v0.1 `id` UUID is **dropped**: the sbx sandbox name derives from `name`
(`<name>-<key>`), never from a UUID, so the UUID was dead weight (it wasn't in the name,
so it never disambiguated anything). `name` is persisted once (folder-derived) so it
survives a folder rename; separate repo copies in different folders get different names
and therefore independent sandboxes (this is exactly why `tomis-next-v2/v3/v4` are
separate — different folders → different `name` → different sandbox).

**Recipe (`config.yaml`)** — compose-like, committed, shared:

```yaml
version: 1
sandboxes:
  claude:                     # logical key → sandbox name "<identity.name>-claude"
    agent: claude             # required: sbx agent (claude/shell/codex/opencode/…)
    image: myrepo-dev:latest  # optional: image tag to run with (-t)
    dockerfile: Dockerfile    # optional: path under .sandbox/; if set → build `image` from it
    mount: direct             # optional: direct | clone (FS policy; default direct)
    secrets: [github]         # optional: service-secret NAMES to provision (values never here)
    ports: [5000, 5173]       # optional: ports to publish
  shell:
    agent: shell
    image: myrepo-dev:latest  # reuse the same built image for a sibling shell sandbox
```

Compose semantics (the model the user asked for): `image` is the tag; **if `dockerfile`
is set, the extension builds and tags it as `image`**, else `image` is used as-is, else
(neither) the agent's default image. `secrets` holds **names only** — values are
provisioned via `sbx secret set` (§8), never committed. One repo copy can declare
multiple sandboxes (e.g. `claude` + `shell`) that share the workspace and (optionally) the
same custom image.

## 15. Custom images: templates & kits (verified)

`sbx` has **no native Dockerfile build**; custom environments come from two official,
complementary mechanisms (see the `customize/` docs linked at the top of this file).

**Templates — baked image (the `image` + `dockerfile` path).** Verified end-to-end on
v0.31.3:

```text
docker build -t <image> -f .sandbox/Dockerfile <context>   # FROM an agent base image
docker save <image> -o <tar>                               # host docker store ≠ sbx store
sbx template load <tar>                                     # into the sbx runtime image store
sbx create -t <image> <agent> <workspace>                  # custom rootfs, agent preserved
```

Confirmed by the spike: the built image keeps the `agent` user and the `claude` binary,
inherits `FLAVOR=claude-code` automatically, and a marker baked at build time is present
at runtime. **The sbx runtime image store is separate from host docker** — a host-built
image is NOT visible to `-t` until `template load`ed (a direct `create -t` of an unloaded
host image fails with "pull failed"). Templates persist in the store; only `sbx reset`
clears them. **Base-image contract** (build-an-agent docs): non-root `agent` user at UID
1000, passwordless sudo, `/home/agent/`, HTTP-proxy env forwarding — so a custom
Dockerfile must `FROM docker/sandbox-templates:<flavor>` and wrap install steps in
`USER root` … `USER agent`. **Rebuild** = re-run build → reload → recreate the sandbox
(the host workspace is on the mount, so only image-baked tooling is refreshed, not work).
**Never bake secrets** into a template — the docs warn `template save` captures
manually-added secrets; use `sbx secret set`.

**Kits — declarative extension (the follow-up `setup` path).** A `spec.yaml`
(`kind: mixin` to extend claude, or `kind: agent` to define one) supplies env vars,
credential→source maps, network rules, static files, agent memory, and commands. Command
lifecycle (this settles "does it reinstall each start?"):

- `commands.install` — **runs once at creation; installed packages persist** across
  stop/start. ← use this to add tools (e.g. dotnet) *without* maintaining an image.
- `commands.startup` — runs on **every** start; must be idempotent (daemons/services).
- `commands.initFiles` — written each start, with `${WORKDIR}` substitution.

`--kit` applies only at create; `sbx kit add <sandbox> <ref>` injects into a running
sandbox (re-runs `install`, re-copies files) — the basis for "edit sandbox / append
secrets live". **v0.2 ships the template path first** (it matches the user's
`image`+`dockerfile` model and is verified); kits are the declarative follow-up.

**Instance-first New/Edit (the user edits a sandbox, not a file).** The Explorer drives a
webview: **New Sandbox** (`ainoflowSandbox.newSandbox`, the `+` in the view title) creates
one; **Edit** on a node opens *that* sandbox prefilled. Fields: **Title** (display name;
for New it also derives the sandbox key/name), **Agent**, **Group** (organises the tree
into folders), **Credentials** (checkboxes — names only; values prompted on apply), and
**Advanced** (Environment: Default / Custom Dockerfile / Custom image; published ports as
add/remove rows; `direct | clone` mount). Agent/secret lists come from the installed sbx
(static fallback), so the form tracks the local version.

**Save = persist + apply (this removes the config-vs-instance confusion).** The definition
is written to `.sandbox/config.yaml` (invisible plumbing, still committable) AND applied to
the instance: secrets (`secret set`, FR-032) and ports (`sbx ports`) apply **live**;
image/mount changes prompt a **Rebuild** (recreate; workspace on the mount preserved). A
just-generated Dockerfile is **not** auto-built (it carries only the default shell base) —
the user edits it, then Rebuild/Attach builds it. A custom Dockerfile is linted for a
`FROM`. Per-sandbox image + Title/Group let one repo run several differently-configured,
organised sandboxes.

## 16. Rebuild semantics (supersedes the single FR-007 "Rebuild")

The v0.1 FRD overloaded "Rebuild" to mean "destroy state". v0.2 splits it into three
distinct, separately-surfaced operations:

| Operation | What it does | State |
|---|---|---|
| **Recreate** | `sbx rm --force` + recreate from the recipe | destroys sandbox state (host workspace untouched) |
| **Rebuild image** | re-run `docker build` → `template load` → recreate from the new image | refreshes image-baked tooling; workspace is on the mount, so work is safe |
| **Edit** | add/rotate secrets (`secret set <sandbox>`) or inject a kit (`kit add`) into a **running** sandbox | non-destructive, no recreate |

`mount` (§14) selects the FS workflow (see §9): `direct` (instant edits, in-sandbox git,
no parallelism) vs `clone` (private clone, retrieve via `git fetch sandbox-<name>`,
parallel-agent friendly, set only at create).

**Rebuild image is one action ("easy way").** A single command/button runs the whole
pipeline — `docker build` → `docker save` → `sbx template load` → `sbx rm --force` →
recreate from the new image → re-attach — behind a progress indicator, so the user never
runs it by hand. The host workspace is on the mount, so in-progress work survives the
recreate; only image-baked tooling is refreshed. (When the recipe has no custom image,
"Rebuild" degrades to a plain Recreate.)
