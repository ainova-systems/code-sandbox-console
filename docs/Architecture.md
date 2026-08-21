# Architecture — Sandbox Console

> **Status:** Current technical truth for the shipped code — every statement below
> describes the extension as it is **now**. History and the reasoning behind past
> changes live in append-only iteration specs under [`specs/`](specs/).
> **Companion doc:** [Features.md](Features.md) — the business/functional truth;
> requirement IDs (`FR-0xx`) below refer to it.
> **Upstream reference (authoritative for `sbx` behaviour — read before changing any
> backend assumption):** Docker Sandboxes docs, <https://docs.docker.com/ai/sandboxes/>.
> Customization specifics:
> [build-an-agent](https://docs.docker.com/ai/sandboxes/customize/build-an-agent/),
> [templates](https://docs.docker.com/ai/sandboxes/customize/templates/),
> [kits](https://docs.docker.com/ai/sandboxes/customize/kits/),
> [kit-examples](https://docs.docker.com/ai/sandboxes/customize/kit-examples/).

## 1. Purpose & scope

This document describes how the extension is built. The product goal (see Features.md):
run AI coding agents (Claude Code first) inside isolated, persistent sandboxes, from a
terminal that feels native to VS Code — with the user never having to think about
containers or sandbox lifecycle.

## 2. Core architectural decision

The extension is a **thin orchestration layer over Docker Sandboxes (`sbx`)** — it
does not manage containers itself.

This was a deliberate pivot. The first prototype drove raw Docker
(`docker run`/`docker exec`) with a hand-rolled auth volume and base image. That was
the wrong altitude: it gave only container-level isolation (shared host kernel) and
forced us to reimplement persistence, network/filesystem policies, agent launching,
and credential handling — all of which `sbx` already provides natively, and more
strongly (microVM isolation). The raw-Docker backend was removed (see
[specs/001](specs/completed/001%20-%20Walking%20Skeleton.md)).

`sbx` (verified `v0.31.3`) gives us, out of the box:

- **microVM isolation** — separate kernel, a Docker daemon *inside* each sandbox.
- **native persistence** — installed packages, config, and state survive stop/start.
- **credential proxy** — secrets stay on the host; the sandbox sees a sentinel.
- **network allow-list** and **filesystem modes** (direct vs `--clone` read-only).
- **first-class agents** — `claude`, `codex`, `gemini`, `copilot`, `cursor`, `shell`, …

## 3. System context

```text
VS Code window
  └─ Sandbox Console (extension, this repo)
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
| `extension.ts` | Activation, palette commands, status bar item, silent startup discovery feeding it (Features §3, "Attach before Create"). Orchestrates the flows below. The status item reports host readiness rather than hiding when nothing can run (FR-059), and `Check Prerequisites` re-runs the report on demand. |
| `config.ts` | Parses/writes the committed `.sandbox/config.yaml` recipe, incl. the project `name` (FR-009, §6). |
| `identity.ts` | Reads/writes the **gitignored** `.sandbox/identity.yaml` — a short random `{id}` per working copy (FR-001, §6). |
| `sbx.ts` | CLI wrapper for every child-process `sbx` invocation: resolves the executable, `version`/`diagnose -o json`/`ls --json`/`create`/`stop`/`rm`, `template load`/`ls`/`rm`, `secret set` (value piped over stdin), `ports`, live agent/secret discovery, `hostToSandboxPath`, the argv allowlist asserts (§9), and FR-061 log collection (`collectLogs`: host `daemon.log` tail plus a running-only `exec` of known in-sandbox log files, with `ls` re-checked immediately before that exec). Invocations run through `log.ts` (FR-055); the argument vectors stay here. The executable is resolved on **every** call and never memoised (FR-059): where the CLI lives is precisely what changes under a running extension, and any remembered answer — hit or miss — survives an install, a move or an uninstall and forces a window reload. One `existsSync` in front of a `spawn` buys nothing worth that. |
| `sandbox.ts` | Maps the recipe to concrete `SandboxRef`s: derives the sandbox name `<name>-<key>-<id>` (§6) and exposes lifecycle ops (`state`/`stop`/`destroy`/`create`) over `sbx.ts`. |
| `images.ts` | Custom-image pipeline: `docker build --pull` → `docker save` → `sbx template load` (FR-008, §7), the rebuild image-refresh policy (FR-053), with dockerfile/context paths contained inside the repo (§9). Owns the host-Docker probe `dockerState()` — `docker --version` for *installed*, then `docker info` for *engine reachable*, since the client-only `--version` succeeds while the engine is stopped (FR-059) — and the one sentence both the build failure and the form's notice use. Executable resolved per call, like `sbx.ts`. |
| `kits.ts` | Lifecycle hooks (FR-060, §7): renders the generated kit `.sandbox/kits/<key>/spec.yaml` **and** the runner `startup.sh` it bootstraps (both gitignored artefacts, rewritten before every start — spec 018), derives the `SANDBOX_*` variables that make a hook mount-agnostic, and turns a rejected kit into the user-facing refusal. Knows the kit schema and the runner's semantics; the `--kit` argv itself lives in `sbx.ts`. |
| `secrets.ts` | Provisions missing service secrets — cached-entry picker / prompt → `sbx secret set` over stdin (FR-032 + FR-051, §8) — and the `Manage Cached Secrets` command. Skips and warns on agent/secret pairs that cannot authenticate together (Cursor API key on Cursor). |
| `blobs.ts` | The per-project secret cache store (FR-051, §8): `~/.sbx/<entry>.<service>.dpapi` blobs, encrypted/decrypted via a PowerShell child process (DPAPI; value over stdin/stdout pipes only). Shared on disk with the generated CLI. |
| `script.ts` | Renders and maintains the generated project CLI `.sandbox/scripts/sbx.sh` (FR-052, §13): version+hash header, silent refresh of unmodified copies, never overwrites manual edits silently. |
| `ops.ts` | Per-sandbox create/attach/stop/rebuild/destroy/shell/open-logs, shared by the palette and the Explorer so the two never drift. Owns the progress spinners, the single-flight guard (FR-054), cancellation at stage boundaries (FR-056) — §12 — and the mount preflight (FR-058, §5) whose modal refusal it shows itself, raising the shared `HandledError` so no surface reports it twice. Open Logs (FR-061) is deliberately **not** exclusive: it is a diagnostic read and must not start a stopped sandbox; the snapshot file is owner-only (`0600`) when the OS honours modes. |
| `git.ts` | Read-only host git probes (FR-058): `isShallowRepository` (`git rev-parse --is-shallow-repository`, resolved with `-C` so a workspace inside a repo works). Own module for the same reason `sbx.ts` is one — one place per external CLI's argv. Never mutates a repository. |
| `prereq.ts` | Host readiness (FR-059, §5): classifies `sbx diagnose` into *missing / signed-out / unhealthy*, formats the status-bar tooltip, and owns the modal refusal shared by the status bar, the Sandboxes view and the New Sandbox command — three surfaces that cannot import one another. Also answers the **separate** host-Docker question for the custom-image mode. Probes are never cached: readiness is exactly what changes under the extension. |
| `log.ts` | The operation log (FR-055): the `Sandbox Console` output channel plus the `spawn`-based runner every `sbx`/`docker` call goes through — streams child output to the channel and to the progress notification, and kills the child on cancel. Process plumbing only: it knows no CLI strings. |
| `names.ts` | The per-working-copy record of sbx names that can no longer be created (FR-057, §14): `workspaceState`-backed, written when a create fails with the leaked-state error, read by key derivation. Local by construction — it never reaches the committed recipe. |
| `terminal.ts` | Native VS Code terminals whose `shellPath` is `sbx` — assembles the interactive `run`/`exec` shellArgs and pools agent terminals per sandbox (§10, §12). This is where the agent actually attaches. Also opens the one **host** terminal the extension needs (`openHostCommandTerminal`): the FR-058 hand-off, which types `git fetch --unshallow` and leaves the Enter to the user. |
| `form.ts` | The New/Edit webview (§7, §12): persists to the recipe AND applies to the instance. States the host-Docker requirement inside the *Custom: Dockerfile* block, so it is known when the mode is chosen rather than at Create (FR-059). Hides agent/secret pairs that cannot authenticate together (FR-032, Cursor API key on Cursor) without dropping the other secret ticks when the agent changes. |
| `tree.ts` | Sandbox Explorer view + per-node commands (§12), including **Open Logs** (FR-061). Renders a readiness node instead of an empty tree when the host cannot run sandboxes or their state cannot be read (FR-059). |
| `agents.ts` / `services.ts` | Static agent/secret-service registries (labels + fallback) backing the live discovery in `sbx.ts`. `services.ts` also owns the agent/secret conflict table (FR-032). |

Dependency direction (verified against imports):
`extension → {ops, form, tree, prereq, sandbox, config, identity, agents, names, script, secrets, sbx, log}`;
`tree → {ops, form, prereq, sandbox, config, identity, agents, sbx, log}`;
`form → {ops, prereq, secrets, sandbox, config, identity, agents, names, script, sbx, services}`;
`ops → {images, kits, secrets, sandbox, terminal, names, git, sbx, log}`;
`terminal → {sandbox, agents, sbx}`; `secrets → {blobs, sandbox, services, sbx}`;
`kits → {config, sbx}`;
`sandbox → {config, identity, sbx, log}`; `images → {config, sbx, log}`;
`prereq → {images, sbx}`; `sbx → log`; `git → log`; `script → config`;
`identity → config`.
Nothing depends on `extension`; `config`, `agents`, `services`, `blobs`, `names`, and
`log` are leaves.

`sbx.ts` shapes all child-process `sbx` invocations; `terminal.ts` additionally builds
the interactive `run`/`exec` argument vectors used as terminal `shellArgs` — CLI strings
the **extension executes** live in those two modules only. The one carve-out is the
bash template in `script.ts`, which *renders* sbx calls into the generated
`.sandbox/scripts/sbx.sh` (§13) for external shells — never executed by the extension;
it must be kept in sync with `sbx.ts`/`ops.ts` when CLI shapes change.

## 5. Lifecycle & command mapping

The lifecycle maps almost 1:1 onto `sbx`. Notably there is **no `sbx start`**:
a stopped sandbox is resumed by `sbx run <name>` (or auto-started by `sbx exec`).

| Action | Extension command | sbx invocation |
|---|---|---|
| Create + auto-attach (FR-003) | `Connect` (creates if absent; sandboxes are defined via `New Sandbox`) | `sbx create --name <name> [--clone] [-t <image>] [--kit <dir>] <agent> <workspace>`, then `sbx run <name>`. Never the one-shot run create-form: `sbx run <agent> <workspace> --name <name>` matches an existing sandbox by agent+workspace and ignores `--name` (v0.31.3), so any other sandbox on the same workspace makes it fail (spec 012) |
| Attach (FR-005) | `Connect` | `sbx run <name>` (resumes if stopped) |
| Start (FR-004) | folded into Connect | `sbx run <name>` |
| Stop (FR-006) | `Stop` | `sbx stop <name>` |
| Open Shell | `Shell` | `sbx exec -it -w /<drive>/… <name> bash` (auto-starts, lands in workspace) |
| Open Logs (FR-061) | `Open Logs` | host `daemon.log` (no CLI); `sbx ls --json` then `sbx exec … bash -lc <known log files>` only if still running |
| Discovery (FR-002) | on activation | `sbx ls --json` → match by name |
| Rebuild/Delete (FR-007) | `Rebuild` (palette + Explorer) / `Delete instance` (Explorer, §12) | `sbx rm --force <name>` (+ image rebuild, §11) |

The UI labels the attach action **Connect** (the underlying sbx operation is still an
attach via `sbx run`). Create-vs-attach is disambiguated by checking `sbx ls --json`
first, then choosing the create form (`… <agent> <path>`) or the attach form (`… <name>`).

**Preflight: the host, then the workspace.** Before any of this, the machine has to be able
to run a sandbox at all. `prereq.ts` asks the installation itself — `sbx diagnose -o json`,
whose checks (CLI binary, daemon, version match, storage, permissions, socket,
authentication) name the broken precondition and carry the CLI's own remedy text — and
classifies the outcome as *missing*, *signed-out* or *unhealthy* (FR-059). It costs the same
as the `sbx version` probe it replaced (~480 ms, all process start-up), so it sits on the
passive path: the status bar and the Sandboxes view report it instead of falling silent, and
`New Sandbox` refuses in a modal before the form opens. An sbx too old to know `diagnose`
falls back to `version` and counts as ready — this check explains a broken install, it does
not add a version requirement. Host **Docker** is deliberately not part of it: sbx needs
none (§3), only the custom-image build does (§7).

**Preflight before the first sbx call.** Every create path (Connect, Shell, Rebuild)
first checks that the workspace can serve the sandbox's mount mode: `hostToSandboxPath`
rejects UNC/`\\wsl$` paths (FR-040), and `mount: clone` additionally requires a
non-shallow repository (FR-058, §9). Rebuild runs both **before** its removal stage, so a
refusal leaves the existing sandbox intact rather than deleting it and then declining to
recreate it. The shallow refusal is a modal dialog raised in `ops.ts` (one place for all
three surfaces) offering **Open Terminal** — `git fetch --unshallow` typed into a host
terminal, never executed — and then throws `ops.HandledError`, which every surface's
error reporter skips so the dialog is not followed by a redundant toast. The hook kit
(FR-060, §7) is generated and `sbx kit validate`d in the same band, and for the same
reason: `--kit` only takes effect at creation, so a kit rejected later would leave a
sandbox that cannot get its hooks without being recreated.

There is **no implicit default sandbox**, and startup is **always quiet and read-only** —
opening a workspace never raises notifications and **never writes into `.sandbox/`**
(spec 009). Discovery feeds the status bar (state icon + display name; `+ New Sandbox`
with no recipe) and the Sandboxes view; both read with `readConfig`/`readIdentity` only.
`Connect`/`Shell` route to the New Sandbox form when nothing is defined. The local
identity, its `.gitignore`, and the generated `sbx.sh` are written only when the user
creates their first sandbox, not on open (§6, §13). A malformed `config.yaml` is surfaced
as an error pointing at the file — never treated as "no sandboxes", never overwritten.

## 6. Configuration recipe & identity

Identity and configuration are split **by git treatment**, because they need opposite
handling: the **recipe** is shared (committed, travels with the repo/copy); the
**identity** is local (gitignored, per-working-tree). `.sandbox/` is a folder (mirrors
`.devcontainer/`):

```text
.sandbox/
  config.yaml      # committed   — shared recipe (compose-like), incl. the project name
  identity.yaml    # gitignored  — local random id only
  .gitignore       # committed   — contains `identity.yaml` (self-contained ignore)
  Dockerfile       # committed   — optional custom image, referenced by config
```

The extension writes `.sandbox/.gitignore` (containing `identity.yaml`) so the local id is
never committed even without a root .gitignore entry; `config.yaml`, `.gitignore`, and any
`Dockerfile` are committed.

**Identity (`identity.yaml`)** — just a short random id, auto-generated per working copy:

```yaml
id: a3f9k
```

The **project name lives in `config.yaml`** (shared/committed); the sbx sandbox name is
`<name>-<key>-<id>`. The local random `id` guarantees that two clones/copies/worktrees of
the same repo on one host get distinct, conflict-free sandbox names. The id is gitignored
and generated on **first create, not first open** — discovery reads it with `readIdentity`
and renders the recipe as all-absent when it is missing (nothing can exist without an id),
so `ensureIdentity` (which also seeds `.sandbox/.gitignore`) runs only when the user
actually creates/connects a sandbox (spec 009). Each copy thus gets its own automatically,
without an untouched checkout ever acquiring one.

**Recipe (`config.yaml`)** — compose-like, committed, shared:

```yaml
version: 1
name: my-repo                 # shared project label → sandbox name "<name>-<key>-<id>"
sandboxes:
  claude:                     # logical key (the <key> in the sandbox name)
    agent: claude             # required: sbx agent (claude/shell/codex/opencode/…)
    title: Backend            # optional: Explorer label (group: optional folder)
    default: true             # optional: status bar / palette target (FR-050; one per recipe)
    image: myrepo-dev:latest  # optional: image tag to run with (-t)
    dockerfile: Dockerfile    # optional: path under .sandbox/; if set → build `image` from it
    mount: clone              # optional: direct | clone (FS policy; default direct)
    setup:                    # optional: FR-060 hooks — once, at creation (sh; no workspace
      - docker pull redis:7   #   yet under mount: clone — see §7)
    startup:                  # optional: every start, before the agent attaches (bash -lc)
      - npm ci                #   under mount: direct this writes into the HOST checkout
      - bash $SANDBOX_SOURCE/.sandbox/sync.sh
    services:                 # optional: every start, in the background
      - docker compose -f deployment/docker-compose.yml up -d
    secrets: [github]         # optional: service-secret NAMES to provision (values never here)
    ports: [5000, 5173]       # optional: ports to publish
  shell:
    agent: shell
    image: myrepo-dev:latest  # reuse the same built image for a sibling shell sandbox
```

Compose semantics: `image` is the tag; **if `dockerfile` is set, the extension builds and
tags it as `image`**, else `image` is used as-is, else (neither) the agent's default
image. `secrets` holds **names only** — values are provisioned via `sbx secret set` (§8),
never committed. One repo copy can declare multiple sandboxes (e.g. `claude` + `shell`)
that share the workspace and (optionally) the same custom image. An empty `sandboxes:`
map is valid and treated like an absent recipe. The three hook lists (FR-060, §7) hold
shell commands that run **inside** the sandbox, never on the host — they are the recipe's
only executable content, and their blast radius is the microVM.

Name parts (project name, key) are sanitised to the characters sbx allows (letters,
digits, `.`, `+`, `-`), must start with a letter/digit, and fall back to `sandbox` when
nothing usable remains (e.g. a fully non-ASCII folder name) — so any folder name yields a
valid sandbox name.

**Key derivation (FR-057).** A new sandbox's `key` is seeded from the title entered in the
form (`Backend API (v2)` → `backend-api-v2`, capped at 40 chars), falling back to the agent
id when nothing usable remains, and then **frozen** — the form locks it in edit mode, so a
later rename never moves a sandbox name, Dockerfile, or image tag. The candidate is skipped
if the key is already in the recipe or if its sbx name is recorded unusable (`names.ts`,
§14); the suffix (`-2`, `-3`, …) resolves genuine collisions. Because the default Dockerfile
name follows the key, two sandboxes on one agent no longer share `claude.Dockerfile` by
accident — sharing is expressed by typing the same file name in both.

**The recipe is watched, not snapshotted (FR-009).** `config.yaml` is committed and edited
by hand, by a git pull, or by another window, while the tree and the status bar resolve
their refs at render time. `extension.ts` therefore holds a `FileSystemWatcher` over
`.sandbox/*.yaml` that (debounced) refreshes the status bar and fires
`sandboxConsole.refresh`, dropping the tree's cached refs. Watching keeps discovery
event-driven and silent (FR-002; a timer would reintroduce background `sbx ls` traffic for
a file that changes rarely), and the watcher only observes — it never writes.

## 7. Custom images: templates & kits

`sbx` has **no native Dockerfile build**; custom environments come from two official,
complementary mechanisms (see the `customize/` docs linked at the top of this file).

**Templates — baked image (the `image` + `dockerfile` path).** Verified end-to-end:

```text
docker build -t <image> -f .sandbox/<dockerfile> <context>   # FROM an agent base image
docker save <image> -o <tar>                               # host docker store ≠ sbx store
sbx template load <tar>                                     # into the sbx runtime image store
sbx create -t <image> <agent> <workspace>                  # custom rootfs, agent preserved
```

**This path — and only this path — needs host Docker** (FR-059). `sbx` runs its own daemon
(§3) and Docker's own prerequisites state that Docker Desktop is not required for it, so the
requirement is stated where the mode is chosen (the form's *Custom: Dockerfile* block) and
nowhere product-wide. `images.dockerState()` separates *not installed* from *engine not
running*, because `docker --version` is answered by the client alone and a build needs the
daemon. The *Custom: image* mode does not need it either: sbx pulls that image itself.

**The sbx runtime image store is separate from host docker** — a host-built image is NOT
visible to `-t` until `template load`ed. Templates persist in the store; only `sbx reset`
clears them. **Base-image contract** (build-an-agent docs): non-root `agent` user at UID
1000, passwordless sudo, `/home/agent/`, HTTP-proxy env forwarding — so a custom
Dockerfile must `FROM docker/sandbox-templates:<flavor>` and wrap install steps in
`USER root` … `USER agent`. **Rebuild** = re-run build → reload → recreate the sandbox,
always from a fresh image (FR-053; the host workspace is on the mount, so only
image-baked tooling is refreshed, not work). The refresh is per environment kind:
Dockerfile builds run `docker build --pull`; a pulled custom image is re-fetched via
`docker pull` → save → `template load` (best-effort — a local-only image stays cached and
is never removed); a default agent image has its `docker/sandbox-templates` store entries
removed so the create re-pulls (registry images by definition; removal runs after the old
instance is destroyed, since a template referenced by a live instance could refuse it).
`sbx` v0.31.3 offers no pull/update command — its cache is cleared only by `sbx reset` —
so the extension owns this refresh.
**Never bake secrets** into a template — the docs warn `template save` captures
manually-added secrets; use `sbx secret set`.

**Kits — the lifecycle-hook carrier (FR-060, `kits.ts`).** A kit is a directory with a
`spec.yaml` (`kind: mixin`) that sbx applies to a sandbox. The extension generates one per
sandbox that declares hooks, into the gitignored `.sandbox/kits/<key>/`, and passes it as
`sbx create --kit <dir>`:

```yaml
schemaVersion: "1"          # required by v0.31.3; its absence is a manifest error
kind: mixin
name: <the sbx sandbox name>   # also the dispatcher entry name — see "re-applying" below
commands:
  install:                     # once, at creation. `command` is a STRING, run with `sh`
    - command: npm ci
      user: "1000"             # the agent user; "0" would be root
  startup:                     # every container start. `command` is an ARGV ARRAY
    - command: ["bash", "-lc", "bash $SANDBOX_SOURCE/.sandbox/sync.sh"]
      user: "1000"
    - command: ["bash", "-lc", "docker compose up -d"]
      user: "1000"
      background: true         # `services:` in the recipe — the restart policy sbx lacks
environment:
  variables: { SANDBOX_WORKSPACE: …, SANDBOX_SOURCE: …, SANDBOX_NAME: …, SANDBOX_KEY: … }
```

The string/array asymmetry is the CLI's, not a choice. Verified end-to-end on v0.31.3
(spec 017): install output streams through `sbx create`'s stdout (so it lands in the
progress box and the operation log for free) and a **failing install fails the create**,
leaving no sandbox behind; startup commands run before `sbx run` attaches the agent, and a
**failing startup does not fail the start** — the dispatcher stops, the sandbox comes up
anyway, and the only trace is `/var/log/sbx-kit-startup.log` (`fail <script> exit=<n>`),
which `ops.ts` reads back and reports. `environment.variables` reach install commands,
startup commands and the agent's own shell.

**The kit is frozen at creation — so it carries a bootstrap, not the commands** (spec 018).
`--kit` against an existing sandbox is refused (*"can only be used when creating a new
sandbox"*), and `sbx kit add` does not substitute for it: verified on v0.31.3 by creating a
sandbox whose startup command printed `VERSION-A`, re-adding the same-named kit carrying
`VERSION-B`, and restarting — `B` ran once, then `A` ran again, and
`/etc/durable-startup.d/002-startup-<kit>/000-cmd.sh` still held `A`.

What is frozen is therefore only the command *text*, and the single startup entry the kit
carries is:

```bash
if [ -f "$SANDBOX_SOURCE"/.sandbox/kits/<key>/startup.sh ]; then
  bash "$SANDBOX_SOURCE"/.sandbox/kits/<key>/startup.sh
else
  echo "Sandbox Console: … is missing …" >&2; exit 1      # loud, never a silent no-op
fi
```

`kits.ts` writes that **runner script** next to the kit from the recipe's `startup` +
`services`, and rewrites it on **every** start path (Connect, Shell, Rebuild — and the
generated CLI's connect). Under `mount: clone` it is read from `/run/sandbox/source`, the
read-only host tree, which is the only copy guaranteed current. So the rule the user gets is
one sentence: *edit, restart, applied*. `setup` stays baked in as `commands.install` —
re-running the install phase is what a Rebuild is, and the form says so.

The runner reproduces the dispatcher semantics users were told about: commands in order, a
failure stops the rest and is recorded with its exit code, services detached (and a service
that is gone a second later is recorded as `fail … exited immediately`, never as *started*).
It writes `/tmp/sandbox-console-hooks.log`, **truncated at the top of every run**, which is
what lets `ops.reportStartupHooks` read it without dating anything; sbx's own dispatcher log
stays as the fallback that catches a bootstrap failure.

Two consequences of the bootstrap being frozen, both handled rather than documented away:

- **Removing hooks must remove them.** An emptied recipe still faces a bootstrap that runs
  the runner, so `ensureKit` rewrites an existing runner as a no-op instead of leaving
  yesterday's commands on disk (deleting it would make every start fail *missing*).
- **A sandbox created with no hooks at all has no bootstrap**, and one cannot be attached
  afterwards. The bootstrap is therefore emitted whenever a sandbox gets a kit — including a
  setup-only recipe, whose runner is a no-op today — and for the remaining case (hooks added
  to a sandbox created without any) `ops.reportStartupHooks` notices that the runner's log
  never appeared and offers a one-time **Rebuild**, instead of leaving the user waiting for
  hooks that cannot run.

**Third-party kits are not wired up yet.** `--kit` also accepts ZIP, git and OCI references
and they stack, which is the natural follow-up for reusable team kits (MCP servers, CA
certificates); it needs its own preflight, since `kit.allowedSources` defaults to
`docker.io/` only. Local directories are allowed by default (`kit.allowLocalKits`).

**Instance-first New/Edit (the user edits a sandbox, not a file).** The Explorer drives a
webview: **New Sandbox** (`sandboxConsole.newSandbox`, the `+` in the view title) creates
one; **Edit** on a node opens *that* sandbox prefilled. Fields: **Title** (display label; it
seeds the key once at creation and never tracks it afterwards, so a rename never touches
names/images — FR-057, §6),
**Agent**, **Group** (organises the tree
into folders), **Credentials** (checkboxes — names only; values prompted on apply),
**Advanced** (Environment: Default / Custom Dockerfile / Custom image; published ports as
add/remove rows; `direct | clone` mount) and **Hooks** (three monospace text areas, one
command per line, each captioned with when it runs and what it can reach — FR-060). The Dockerfile choice takes an optional **file
name** under `.sandbox/` (empty → `<key>.Dockerfile`): a missing file is generated `FROM`
the selected agent's base template (`agentTemplate()` — the `-docker` flavor the CLI
boots by default; claude → `claude-code-docker`); an existing file is reused untouched,
so several sandboxes can share one committed Dockerfile. The derived tag is
`<project>:<dockerfile stem>` (e.g. `claude.Dockerfile` → `tomis-next:claude`) — the
image is a product of the Dockerfile, so sharing the file shares the image and a
Rebuild refreshes it for every sandbox using it. The name is held to the same
no-separators/no-leading-dot rule as recipe keys (§9) — it must never steer the write
target outside `.sandbox/`. Agent/secret lists come from the installed sbx (static
fallback), so the form tracks the local version.

**Save = persist + apply.** The definition is written to `.sandbox/config.yaml` AND
applied to the instance: secrets (`secret set`, FR-032) and ports (`sbx ports`) apply
**live**; a changed `startup`/`services` list applies on the **next start** and the form says
so; image, mount and a changed **`setup`** list prompt a **Rebuild** (recreate; workspace on
the mount preserved), since those three are bound when the sandbox is created. The prompt
names which of them changed and, for `setup`, why the install phase is unlike the other two
hook lists. Declining the rebuild still confirms the save: the recipe on disk changed either
way. A just-generated Dockerfile is **not** auto-built (it carries only the agent
base, no tooling yet) — the user edits it, then Rebuild/Connect builds it. An edit
round-trip preserves fields the form does not expose (e.g. `context`), keeps the
committed secret requirements regardless of what is satisfied on this machine, and a
failed create retries against the same recipe entry (no duplicate keys). A malformed
`config.yaml` blocks Save with an "Open config" action — the file is never replaced.

## 8. Credential model

**Fixed priority: OAuth `/login` (default fallback) → API key in the OS keychain via
`sbx secret set -g anthropic` → never a plaintext `ANTHROPIC_API_KEY` env var.**

- **Auth is host-global, shared across all sandboxes.** sbx stores the credential as a
  *global service secret* on the host (`sbx secret ls` → `(global) service anthropic`).
  The host proxy injects it into *every* sandbox's outbound Anthropic calls, so once
  authenticated — whether by a one-time OAuth `/login` or `sbx secret set -g anthropic` —
  all existing and new sandboxes are authenticated with no per-sandbox login.
- **The host's `~/.claude` config is NOT read** (by design, per Docker's docs: sandboxes
  don't pick up user-level host configuration). You authenticate sbx once; credential
  isolation is the point of the microVM.
- **Plaintext env vars are rejected**: weaker than the keychain (plaintext in process
  env, no OS-level access control) and they defeat the proxy's credential-isolation
  guarantee.

**Secret provisioning (FR-032).** The extension provisions secrets *on request*: the
recipe lists required secret **names** only; the form reads `sbx secret ls` and prompts
solely for the missing ones (also re-checked on every Connect/Shell, so a cancelled
prompt is recoverable). Values are piped over the child process's stdin to
`sbx secret set [-g | <sandbox>] <service>` — never in argv, shell history, or env, and
**never** baked into images. (No flag is involved: `--password-stdin` is a registry-login
option, not part of the service-secret form.) Scope is user-chosen: per-sandbox is a
valid, deliberate choice (e.g. a repo-scoped GitHub token), global `-g` for shared creds.

**Per-project secret cache (FR-051).** Between sbx's two scopes — global (`-g`, every
project on the machine) and per-instance (re-entered for every new sandbox/runner) —
sits the extension's own cache: `~/.sbx/<entry>.<service>.dpapi` blobs (`blobs.ts`),
encrypted with Windows DPAPI for the current OS user (other platforms degrade to
no-cache). It is deliberately **not** VS Code `SecretStorage`: the same files are read
by the generated project CLI (§13), so the UI and shell automation share one store.
Selection is always explicit — provisioning offers a picker over cached entry **names**
(current project's entry first, values never displayed) plus *Enter new value…*; a
manually entered value can be cached under the project's name, another name, or used
once. `Sandbox: Manage Cached Secrets` lists/renames/deletes entries. Values move only
through process stdin/stdout pipes (extension ↔ PowerShell ↔ sbx) — never argv, the
repo, or the extension's own environment; the sbx-side handling is unchanged FR-032.
**One documented carve-out:** the generated project CLI (§13) resolves its GitHub PAT as
*project blob → shared blob → `GITHUB_SANDBOX_PAT` environment variable*, the last being
an explicit last-resort fallback for CI/automation where no DPAPI blob can exist
(`script.ts` `github_pat()`; it still pipes the resolved value to `sbx` over stdin). The
extension never reads, writes, or sets that variable.

**Two credential layers for `github`.** Provisioning `github` does two things:
(1) `sbx secret set` stores it host-side so the proxy authenticates the wire (git HTTPS /
API) without the token entering the sandbox; (2) a best-effort
`gh auth login --with-token` (token piped over `sbx exec -i`, never in argv) so the `gh`
CLI itself is authenticated inside — note this second layer deliberately puts the token
in gh's own config **inside** the sandbox. Runs only if `gh` is present and the instance
exists; silent on failure. The form separates **Global credentials** (host-global,
read-only) from **Custom credentials** (this sandbox).

**Cursor API key vs Cursor sign-in (FR-032).** Docker documents both `sbx secret set cursor`
and interactive OAuth; when both resolve, the stored secret takes precedence. The API-key
path is broken inside the sandbox ([docker/sbx-releases#112](https://github.com/docker/sbx-releases/issues/112)):
`cursor-agent` still prompts to log in and the loop never completes, while the same sandbox
signs in when no Cursor secret is set. The form therefore does not offer a `cursor` secret
when the agent is `cursor`, Save drops it from that recipe, and Connect/Shell/Rebuild never prompt
for it. GitHub and other secrets stay available. A global Cursor key already in the
keychain is warned about, not unset — it may belong to another sandbox — before Connect,
Shell, or Rebuild attaches the agent.

## 9. Security & isolation

Provided by `sbx`, surfaced (not reimplemented) by the extension:

- **Isolation** — each sandbox is a microVM with its own kernel and Docker daemon.
- **Network policy** (Features §12) — host proxy enforces an allow-list; outbound hosts
  are logged/allowed/blocked.
- **Filesystem policy** (Features §12) — *direct* mount (read-write workspace) vs
  `--clone` (private in-container clone, host repo mounted read-only at
  `/run/sandbox/source`). That read-only mount is the host **working tree**, git-ignored
  files included, which is what lets a startup hook (FR-060, §7) copy `.env.local` or
  generated data into the clone — the clone itself carries only git history. It is the
  hook's `$SANDBOX_SOURCE`, and it is read-only, so a hook cannot damage the host tree. The clone is made by sbx at every start with
  `git clone --reference <source> <source> <mirrored host path>` plus a `git daemon`
  serving it back as the host remote `sandbox-<name>`; `--reference` is why the mode
  needs a **non-shallow** repository, checked before the create (FR-058, §5, §14).
- **Workspace mount path** — with direct mount on Windows, each host drive is mounted in
  the sandbox at `/<drive-letter>` (e.g. `D:\Repositories\app` → `/d/Repositories/app`),
  read-write and bidirectional. `sbx run` drops the agent there; `Shell` reaches it via
  `exec -w <translated-path>` (`sbx.hostToSandboxPath`). UNC/`\\wsl$` paths have no
  drive-letter mount and are rejected with an actionable error before any sbx mutation.
  Note `/home/agent/workspace` is an unrelated empty default dir — not the mount.

Hardening added by the extension itself (a committed `.sandbox/config.yaml` is
repo-controlled input, i.e. potentially malicious):

- **Argv allowlists** (`sbx.ts`): sandbox names, agent ids, image tags, and secret
  service ids must match conservative patterns and must never start with `-` — closing
  option-injection through config values. All CLI calls use `execFile`/`spawn` (no
  shell); the one `bash -lc` slot validates its command name the same way. Violations
  throw descriptive errors; nothing is sanitised silently at the argv boundary.
- **Path containment** (`images.ts`): `dockerfile` (resolved under `.sandbox/`) and
  `context` (resolved under the repo root) must stay inside the repo — absolute paths
  and `..` escapes are rejected, so a malicious recipe cannot point `docker build` at
  arbitrary host paths.
- **Webview hygiene** (`form.ts`): strict CSP with a per-load nonce, `INIT` JSON escaped,
  user strings HTML-escaped.
- **Workspace trust**: the extension declares `untrustedWorkspaces.supported: false` —
  it executes CLI commands derived from workspace files, so VS Code disables it in
  Restricted Mode.

## 10. Terminal / PTY model

The extension opens a **native VS Code terminal** with `shellPath` set to the `sbx`
executable and `shellArgs` = the `run`/`exec` invocation. The native terminal owns a
real PTY (ConPTY on Windows), so ANSI, cursor control, resize, and interactive agents
work with no native dependency (no `node-pty`). This satisfies FR-010/FR-011.

The `sbx` executable is resolved at runtime, on every call (§4): the Windows installer places
it at `%LOCALAPPDATA%\DockerSandboxes\bin\sbx.exe`, so `sbx.ts` checks that location first and
falls back to the bare command name. Whether a `PATH` entry for that directory also exists
varies by install and is **not** relied upon — and it would not help the case that matters
anyway, a window already open when sbx was installed, whose environment block predates it.

**Agent terminals are pooled per sandbox and reused** — a second `sbx run <name>` is not
a separate instance, it's another attach session into the same microVM (shared
filesystem), which would race. Reuse survives Extension Host reloads: on a pool miss the
extension adopts the revived terminal (same-session terminals are told apart by launch
args — `run` vs `exec`; revived ones by exact tab title), and terminals being disposed
are never adopted. Terminals are disposed before stop/destroy/rebuild so killing the
sandbox leaves no "exit 137"/"exit 1" popup. Shells are intentionally not pooled —
multiple shells are fine.

## 11. Rebuild semantics

"Rebuild" covers three distinct, separately-surfaced operations:

| Operation | What it does | State |
|---|---|---|
| **Recreate** | `sbx rm --force` + recreate from the recipe | destroys sandbox state (host workspace untouched) |
| **Rebuild image** | re-run `docker build --pull` → `template load` → remove the instance → refresh the default/pulled image (FR-053) → recreate from the fresh image | refreshes image-baked tooling; workspace is on the mount, so work is safe |
| **Edit** | add/rotate secrets (`secret set <sandbox>`) and published ports (`sbx ports`) on a **running** sandbox | non-destructive, no recreate |

`mount` (§6) selects the FS workflow (see §9): `direct` (instant edits, in-sandbox git,
no parallelism) vs `clone` (private clone, retrieve via `git fetch sandbox-<name>`,
parallel-agent friendly, set only at create).

**Rebuild image is one action.** A single command/button runs the whole pipeline —
`docker build` → `docker save` → `sbx template load` → `sbx rm --force` → recreate from
the new image → re-attach — behind a progress indicator. The host workspace is on the
mount, so in-progress work survives the recreate; only image-baked tooling is refreshed.
(When the recipe has no custom image, "Rebuild" degrades to a plain Recreate.)

**Cancellation is per stage, and the stage decides the story (FR-056).** The pipeline's
long stages — the image build/refresh and `sbx create` — are cancellable; the
terminal-disposal + `sbx rm` stage in the middle is not, because interrupting it is worse
than waiting out the few seconds it takes. Cancelling any stage abandons the *whole*
rebuild (the cancellation propagates instead of falling through to the next stage), and
the message names what was left behind — untouched before the removal, "the previous
instance is gone, Connect recreates it" after it.

**Kill only what is safe to kill.** Killing a CLI does not stop its backend, and the two
backends leave incomparable residues.

- **`docker` children are killed.** BuildKit finishes what it already started
  server-side; the layers land in the cache, so a later rebuild is faster, never corrupt.
  Nothing to undo.
- **`sbx` children are never killed** (`sbx.run` sets `killOnCancel: false` for every
  invocation). Verified live: killing `sbx create` during its *Configuring Docker* step
  left a network inside the sbx runtime that nothing can remove — the sandbox record was
  gone (`sbx rm` → "not found"), yet every later create under that name failed with
  `failed to create network: already exists`. The runtime's docker daemon is not the
  host's, so the network is unreachable from outside, and the only tool that clears it is
  `sbx reset`, which destroys every sandbox on the machine. **A permanently poisoned
  sandbox name is far worse than a slow cancel.**

So cancelling an sbx operation means *let it finish, then undo it*:
`ops.rollbackCreate` removes the completed sandbox with `sbx rm --force` — a clean
removal, because sbx itself finished and knows every resource it made — returning to
`absent`. The progress box switches to "Cancelling…" the moment the button is pressed, so
the wait is not mistaken for an ignored click. A rollback that cannot complete reports the
sandbox name for manual removal rather than claiming success.

## 12. Explorer actions & lifecycle

**State-gated node actions.** The Explorer surfaces only the actions valid for a node's
state, enforcing a clear lifecycle — running → Stop → stopped → (Edit / Rebuild / Delete
instance) → absent → Remove from config:

| State | Inline actions |
|---|---|
| running | Stop · Connect · *(Shell, Open Logs in the context menu)* |
| stopped | Connect · Edit · Delete instance · *(Rebuild, Open Logs in the context menu)* |
| absent (defined, no instance) | Connect (creates the instance) · Edit · Remove from config |
| busy (transient — an operation is in flight, FR-054) | none |

Two distinct deletes: **Delete instance** (`sbx rm`, keeps the recipe — recreatable;
shown when stopped; runs **before** the recipe entry is touched) vs **Remove from
config** (destroys any live instance first, then drops the entry from `config.yaml`,
deleting the file if it was the last, and removes the sandbox's generated hook kit).
There is deliberately **no per-node hook action** (FR-060, spec 018): a start already applies
the current hooks, so Stop → Connect is the whole story and a second surface would only be a
way to get the two out of step. A malformed `config.yaml` renders as a single error node that
opens the file — never as an empty "No sandboxes yet" tree.

**Every slow lifecycle action surfaces a progress notification.** Create, Stop, Delete
instance, and Recreate each run their `sbx` call (and the preceding terminal disposal,
which can take up to ~4s) behind a notification spinner, so clicking any action gives
instant "something is happening" feedback rather than a silent gap. All lifecycle ops
route through `ops.ts`, which owns the spinners (`withProgress`), so palette, Explorer,
and form callers behave identically. The one carve-out: interactive secret entry (FR-032)
is kept **outside** the spinner — a progress box must never compete with a modal input —
so the order is always *build/create behind a spinner → prompt for secrets → attach a
terminal*. Terminal-based attach/resume (`sbx run`) and shells (`sbx exec`) need no
separate spinner: the terminal opens immediately and is its own progress surface.

**The spinner reports, and can be stopped.** `withProgress` hands its task an
`OpContext` (`log.ts`): `onLine` pushes the running child's latest output line into the
notification message (FR-055), and `token` — set only for the cancellable operations —
kills the child on cancel (FR-056, §11). The same stream feeds the `Sandbox Console`
channel, which is where the full output lives; every error notification and the busy
warning offer **Show Log** to open it. Discovery/probe calls are logged only when they
fail, and the secret path (`secret set`, `gh auth login`) logs its header and exit code
but never its output (FR-032).

**One operation per sandbox (FR-054).** `ops.ts` holds an in-flight registry keyed by sbx
name; every lifecycle entry point runs through it, and a second action on a busy sandbox
is declined with the name of what is running rather than queued behind it. Because the
guard sits below the callers, the palette, the Explorer, and the form cannot drift apart
— which is how a doubled Rebuild used to start two pipelines against one sandbox name.
Distinct sandboxes stay independent. Two consequences worth knowing: "Remove from config"
treats a *declined* destroy exactly like a failed one and keeps the recipe entry (never
orphan a live microVM), and the New/Edit form disables its **Save** for the duration of a
save, restoring it only if the save fails with the panel still open.

A busy node renders as `sandbox.busy` (spinner icon, the operation as its description),
which matches none of the menus' `when` clauses, so its actions disappear until the
operation ends; `ops.onDidChangeBusy` re-renders the tree on the click rather than on the
next focus change. The state-gated table above therefore has a fourth, transient row.
Pressing Cancel relabels the node to *cancelling* as well as the notification: an sbx
child runs to completion after the click (§11), so a node still reading *connect…* through
a minutes-long `--clone` create reads as a hang and contradicts the box beside it.

**Title & Group (organising).** A spec may carry `title` (Explorer/status-bar label —
display-only: it is read **once**, to seed a new sandbox's key, and never tracks it
afterwards, so renaming a title is always safe for the sbx name, file names, and image
tags) and `group` (folders the tree). New-sandbox keys derive from the title, falling back
to the agent id (FR-057, §6). Groups are organisational today and the natural hook for
per-group governance (`sbx --profile`) later.

**Status bar & the active sandbox (FR-050).** The status bar item shows the *active*
sandbox by display name (`title || key`) with its state icon; the agent is in the
tooltip. The active sandbox — also the target of the single-action palette commands —
resolves as: locally last-picked key (`workspaceState`, per working copy) → the recipe's
`default: true` entry (committed; the New/Edit form keeps it unique) → the first entry.
Clicking the item (or `Sandbox: Switch Sandbox`) connects directly when one sandbox is
defined, opens a Quick Pick (all recipe sandboxes + "New Sandbox…") when several are,
and routes to the New Sandbox form when none is; picking updates the last-picked key.

## 13. Generated project CLI

`.sandbox/scripts/sbx.sh` (FR-052) exports the extension's model — naming, identity
bootstrap, lifecycle, the §7 rebuild pipeline, clone-mode runners, the §8 secret chain —
as a **committed bash script** for shells and AI skills, so CLI automation stops
re-encoding these rules as prose and calls subcommands instead
(`name`/`status`/`connect`/`stop`/`rm`/`rebuild`/`exec`/`task`/`runner-create`/
`runner-rm`/`runners`/`secret-github`/`version`).

- **Generation is strictly one-way: the extension writes the script and never executes
  it.** A committed file is repo-controlled input — running it from the extension would
  hand arbitrary code execution to any cloned repo (§9). The UI keeps its typed
  `sbx.ts`/`ops.ts` paths; parity is the template's job (`script.ts` mirrors those
  modules' CLI shapes).
- **Recipe-independent content.** The script derives everything at run time from
  `config.yaml`/`identity.yaml` (including the missing-identity bootstrap), so its text
  depends only on the extension version — recipe edits never require regeneration, and
  git noise is limited to upgrades. It contains no secrets and no project values.
- **Update policy.** Header = `generated by Sandbox Console v<X>` + a sha256 of the rest
  of the file. After every **form save** (`createIfMissing` default): missing → write;
  identical → no-op; unmodified-but-older → silent refresh; **hash mismatch (manual
  edits) → never clobbered silently** (explicit Overwrite prompt). On **activation** the
  same logic runs with `createIfMissing: false` — an existing script is still refreshed on
  upgrade, but a missing one is **not** created merely by opening a project (spec 009;
  FR-002 read-only discovery). A sibling `.gitattributes` pins LF.
- **Same preconditions as the UI.** The create path refuses `mount: clone` on a shallow
  repository, with the same message and the same fail-open behaviour as `ops.ts`
  (FR-058) — parity here is what keeps a script-driven create from producing the empty
  workspace the UI now prevents.
- **Same hooks as the UI.** `write_kit` renders the same gitignored
  `.sandbox/kits/<key>/spec.yaml` **and `startup.sh`**, runs the same `sbx kit validate`
  preflight, and passes `--kit` on create (FR-060, §7) — on `runner-create` too, under the
  runner's own name and kit directory, since a runner is a separate clone-mode sandbox and
  the kit name is what sbx keys its dispatcher entry by. `connect` on an existing sandbox
  rewrites the runner before `sbx run`, mirroring the extension, so "edit, restart, applied"
  holds from a shell as well (spec 018). Reading commands back out of the recipe **decodes**
  YAML scalars the way a parser does — single-quoted `''`, double-quoted backslash escapes,
  and a trailing ` #comment` dropped from a **plain** scalar but kept inside a quoted one, so
  `echo "it's: #ok"` survives while `npm ci   # note to self` does not smuggle the note into
  the command. Stripping the outer quotes alone would hand sbx a different command than the
  extension does. The bash reader handles the **block** sequence form the extension writes,
  not the inline `[a, b]` form or block/folded scalars.
- **Runners.** `runner-create <slug>` instantiates the recipe's `default: true` entry as
  an **ephemeral** clone-mode instance `<name>-<key>-<id>-p<slug>` (agent/image/secret
  names/caps from the recipe; defaults `-m 8g --cpus 4`) — never written back into the
  recipe; discovery is by name contract (`runners`). `runner-rm` refuses to destroy a
  runner until its work is pushed or `git fetch sandbox-<runner>` succeeds (`--force`
  overrides). `task` dispatches headless `claude -p` (foreground, `--json` with cost
  reporting, or `--bg` with a `/tmp` log-file convention).
- **Bash deliberately** (Git Bash on Windows): secret values only flow through bash
  pipes — piping from PowerShell corrupts stored secrets with a BOM. `sbx` is resolved
  like `sbxPath()` (PATH, then `%LOCALAPPDATA%\DockerSandboxes\bin\sbx.exe`); the
  Git-Bash `/d/...` working directory doubles as the in-sandbox mount path (§3).

## 14. Known limitations & open questions

- **Single workspace folder** — multi-root workspaces operate on `workspaceFolders[0]`.
- **No ⚠ Failed state** — discovery surfaces any failed/error sbx status as **Stopped**
  (Features §10 note).
- **Readiness classification leans on `sbx diagnose`'s check names** (FR-059): the
  *signed-out* branch is the failed check whose name matches `/auth/i`, the binary branch
  `/binary|cli/i`. The report is versioned (`"version": "1.0"`) but the names are not a
  documented contract, so a rename degrades the outcome to *unhealthy* — which still shows
  the CLI's own message and hint, and still blocks. Fails safe, not silent.
- **Remote Control is incompatible with the sbx credential proxy (by design).** The
  proxy injects an inference-scoped credential; the sandbox only holds a sentinel, so
  Claude Code's Remote Control cannot mint the session credentials it needs (401/403,
  confirmed not a network-policy block). Run Remote Control from a host (non-sandboxed)
  Claude Code.
- **A Cursor API key cannot authenticate a Cursor sandbox.** Same family as Remote
  Control: the proxy prefers the stored `cursor` secret, `cursor-agent` rejects the
  injected sentinel, and the OAuth UI loops on `Press any key to log in…` (upstream
  [#112](https://github.com/docker/sbx-releases/issues/112)). The working path is
  interactive sign-in with **no** Cursor secret set. The form and provisioning refuse
  that combination (FR-032); a global key already in the keychain is only warned about.
- **Parallel sandboxes on the same repo (undecided).** Direct mount binds the single
  working tree, so two agents on one tree would race. Two paths: *(a) git worktrees* —
  each worktree gets its own identity → its own sandbox for free (note: the in-sandbox
  agent cannot use git in a worktree, its `.git` pointer resolves outside the mount —
  commit from the host); *(b) `sbx --clone`* — sandbox-managed private clone, work
  retrieved via the `sandbox-<name>` git remote. Worktrees fit the model best. Cost in
  both: N microVMs = N×RAM, and a picker UI.
- **An interrupted sbx cleanup leaks the sandbox name — upstream, unfixed.** If sbx's
  cleanup stops after it deletes its runtime entry but before the container/network/volume
  are gone, the name stays claimed inside the runtime: `sbx rm` answers *"not found"*
  while every later `create` under it fails with
  `sandboxd error: status 500: failed to create network: … already exists`. The runtime's
  docker daemon is not the host's, so the leaked network is unreachable from outside, and
  `sbx diagnose` passes without noticing. Open upstream:
  [#129](https://github.com/docker/sbx-releases/issues/129),
  [#181](https://github.com/docker/sbx-releases/issues/181),
  [#353](https://github.com/docker/sbx-releases/issues/353) — no released fix as of
  v0.31.3; the only documented recovery is `sbx reset` (destroys every sandbox on the
  machine), the alternative being bbolt surgery on three internal DBs (#129).
  **This is why cancel never kills an sbx child** (§11): interrupting sbx mid-cleanup is
  exactly the trigger. It is reachable without this extension too — a `sbx stop` that
  outruns the CLI's own 120s timeout does it. `sbx.ts` recognises the error, raises it as
  a typed `NameClaimedError` explaining the way out rather than a raw 500, and `ops.ts`
  records the dead name in `names.ts` so key derivation can never hand it out again
  (FR-057). Remembering the observed failure is the only option available: sbx cannot be
  asked whether a name is claimed — `sbx ls` does not list it and `sbx rm` reports
  "not found". The record is local (`workspaceState`), stores names only, and becomes
  irrelevant after a `sbx reset`.
- **A clone-mode create can still fail silently for reasons the host cannot see.** The
  in-sandbox clone runs on every start, guarded by `[ ! -d "$TARGET/.git" ]`, and the
  script pre-creates `$TARGET` before cloning into it. Anything that makes that one
  `git clone --reference` fail therefore leaves an **empty workspace directory** the agent
  is then dropped into, with the error only in sbx's start-up output (the agent terminal),
  since `sbx create` itself exited 0. It never self-heals: as soon as the agent writes into
  that directory, later starts fail on
  `fatal: destination path … already exists and is not an empty directory` and the original
  cause is lost. Shallow sources are the reachable case and are refused up front (FR-058);
  the general case would need a post-create probe (`sbx exec … test -d <dest>/.git`), which
  costs a started sandbox per create and reports only after the fact — deliberately not
  built. Recovery for an already-wedged sandbox is **Rebuild** once the cause is removed.
- **`sbx kit` is EXPERIMENTAL and its schema has already moved** (FR-060, §7). The
  installed v0.31.3 accepts `commands.install` / `commands.startup`, while
  docs.docker.com documents a newer `setup.install` / `setup.startup` / `setup.files`
  shape that v0.31.3 rejects outright. The generator targets the installed CLI and every
  create validates the kit first (`sbx kit validate`), so a release that renames the
  schema produces one legible refusal instead of a failure inside `create` — but a kit
  schema is a moving target, and this is the assumption most likely to need revisiting.
- **A failing startup hook cannot be prevented, only reported.** sbx keeps the sandbox
  running; the runner stops at the failure and records it, and the extension reads
  `/tmp/sandbox-console-hooks.log` back and warns (FR-060). The runner truncates that file
  at the top of every run, so anything in it belongs to the current start. A hook still
  running after 90s degrades to **no report** rather than a wrong one, and a bootstrap that
  never reached the runner (a missing `startup.sh`) is caught by the fallback read of sbx's
  own dispatcher log, credited to this start only when its timestamp says so. `setup`
  failures need none of this — they fail the create itself.
- **Hooks apply on restart, which means an unstarted sandbox is not up to date.** The runner
  is rewritten on every start path, so a recipe edited while a sandbox is running takes
  effect at its next start and not before — deliberate (§7), and the reason there is no
  "apply now" action to get the two out of step.
- **A create-time hook can only use a globally-scoped credential.** `sbx secret set` scopes
  either globally or to an existing sandbox, and hooks run inside the create, so the
  per-sandbox scope cannot exist yet (FR-060 × FR-032). The extension offers the global
  scope up front when a sandbox declares both; a user who insists on per-sandbox scope for
  a credential a `setup` hook needs will keep failing the create, since the failure removes
  the sandbox the prompt would attach to. Moving that step to `startup` fixes it — the
  sandbox survives, the secret is provisioned, the next start succeeds.
- **Deferred scope**: filesystem/network policy UIs (Features §12), MCP endpoints
  (Features §13), third-party/reusable kits (`--kit` by OCI/git/ZIP reference, §7).
