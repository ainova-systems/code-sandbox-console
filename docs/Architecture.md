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
[specs/001](specs/001%20-%20Walking%20Skeleton.md)).

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
| `extension.ts` | Activation, palette commands, status bar item, startup discovery UX (Features §3, "Attach before Create"). Orchestrates the flows below. |
| `config.ts` | Parses/writes the committed `.sandbox/config.yaml` recipe, incl. the project `name` (FR-009, §6). |
| `identity.ts` | Reads/writes the **gitignored** `.sandbox/identity.yaml` — a short random `{id}` per working copy (FR-001, §6). |
| `sbx.ts` | CLI wrapper for every child-process `sbx` invocation: resolves the executable, `version`/`ls --json`/`create`/`stop`/`rm`, `template load`, `secret set` (value piped over stdin), `ports`, live agent/secret discovery, `hostToSandboxPath`, and the argv allowlist asserts (§9). |
| `sandbox.ts` | Maps the recipe to concrete `SandboxRef`s: derives the sandbox name `<name>-<key>-<id>` (§6) and exposes lifecycle ops (`state`/`stop`/`destroy`/`create`) over `sbx.ts`. |
| `images.ts` | Custom-image pipeline: `docker build` → `docker save` → `sbx template load` (FR-008, §7), with dockerfile/context paths contained inside the repo (§9). |
| `secrets.ts` | Provisions missing service secrets — cached-entry picker / prompt → `sbx secret set` over stdin (FR-032 + FR-051, §8) — and the `Manage Cached Secrets` command. |
| `blobs.ts` | The per-project secret cache store (FR-051, §8): `~/.sbx/<entry>.<service>.dpapi` blobs, encrypted/decrypted via a PowerShell child process (DPAPI; value over stdin/stdout pipes only). Shared on disk with the generated CLI. |
| `script.ts` | Renders and maintains the generated project CLI `.sandbox/scripts/sbx.sh` (FR-052, §13): version+hash header, silent refresh of unmodified copies, never overwrites manual edits silently. |
| `ops.ts` | Per-sandbox create/attach/stop/rebuild/destroy/shell, shared by the palette and the Explorer so the two never drift. |
| `terminal.ts` | Native VS Code terminals whose `shellPath` is `sbx` — assembles the interactive `run`/`exec` shellArgs and pools agent terminals per sandbox (§10, §12). This is where the agent actually attaches. |
| `form.ts` | The New/Edit webview (§7, §12): persists to the recipe AND applies to the instance. |
| `tree.ts` | Sandbox Explorer view + per-node commands (§12). |
| `agents.ts` / `services.ts` | Static agent/secret-service registries (labels + fallback) backing the live discovery in `sbx.ts`. |

Dependency direction (verified against imports):
`extension → {ops, form, tree, sandbox, config, identity, agents, script, secrets, sbx}`;
`tree → {ops, form, sandbox, config, identity, agents, sbx}`;
`form → {ops, secrets, sandbox, config, identity, agents, script, sbx}`;
`ops → {images, secrets, sandbox, terminal, sbx}`;
`terminal → {sandbox, agents, sbx}`; `secrets → {blobs, sandbox, services, sbx}`;
`sandbox → {config, identity, sbx}`; `images → {config, sbx}`; `script → config`;
`identity → config`.
Nothing depends on `extension`; `config`, `agents`, `services`, and `blobs` are leaves.

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
| Create + auto-attach (FR-003) | `Connect` (creates if absent; sandboxes are defined via `New Sandbox`) | `sbx run --name <name> [--clone] [-t <image>] <agent> <workspace>` |
| Attach (FR-005) | `Connect` | `sbx run <name>` (resumes if stopped) |
| Start (FR-004) | folded into Connect | `sbx run <name>` |
| Stop (FR-006) | `Stop` | `sbx stop <name>` |
| Open Shell | `Shell` | `sbx exec -it -w /<drive>/… <name> bash` (auto-starts, lands in workspace) |
| Discovery (FR-002) | on activation | `sbx ls --json` → match by name |
| Rebuild/Delete (FR-007) | `Rebuild` (palette + Explorer) / `Delete instance` (Explorer, §12) | `sbx rm --force <name>` (+ image rebuild, §11) |

The UI labels the attach action **Connect** (the underlying sbx operation is still an
attach via `sbx run`). Create-vs-attach is disambiguated by checking `sbx ls --json`
first, then choosing the create form (`… <agent> <path>`) or the attach form (`… <name>`).

There is **no implicit default sandbox**: with no `.sandbox/config.yaml`, the UI offers
the **New Sandbox** form (once per workspace on startup); `Connect`/`Shell` route there
too. A malformed `config.yaml` is surfaced as an error pointing at the file — it is never
treated as "no sandboxes" and never silently overwritten.

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
and generated on first use, so each copy gets its own automatically.

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
    mount: direct             # optional: direct | clone (FS policy; default direct)
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
map is valid and treated like an absent recipe.

Name parts (project name, key) are sanitised to the characters sbx allows (letters,
digits, `.`, `+`, `-`), must start with a letter/digit, and fall back to `sandbox` when
nothing usable remains (e.g. a fully non-ASCII folder name) — so any folder name yields a
valid sandbox name.

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

**The sbx runtime image store is separate from host docker** — a host-built image is NOT
visible to `-t` until `template load`ed. Templates persist in the store; only `sbx reset`
clears them. **Base-image contract** (build-an-agent docs): non-root `agent` user at UID
1000, passwordless sudo, `/home/agent/`, HTTP-proxy env forwarding — so a custom
Dockerfile must `FROM docker/sandbox-templates:<flavor>` and wrap install steps in
`USER root` … `USER agent`. **Rebuild** = re-run build → reload → recreate the sandbox
(the host workspace is on the mount, so only image-baked tooling is refreshed, not work).
**Never bake secrets** into a template — the docs warn `template save` captures
manually-added secrets; use `sbx secret set`.

**Kits — declarative extension (planned follow-up, not implemented).** A `spec.yaml`
(`kind: mixin`/`kind: agent`) supplies env vars, credential→source maps, network rules,
static files, and commands (`install` runs once at creation and persists; `startup` runs
on every start and must be idempotent). The shipped extension uses the template path
only; kit injection (`sbx kit add`) is the natural follow-up for live environment edits.

**Instance-first New/Edit (the user edits a sandbox, not a file).** The Explorer drives a
webview: **New Sandbox** (`sandboxConsole.newSandbox`, the `+` in the view title) creates
one; **Edit** on a node opens *that* sandbox prefilled. Fields: **Title** (display label
only — the key derives from the agent id, so a rename never touches names/images),
**Agent**, **Group** (organises the tree
into folders), **Credentials** (checkboxes — names only; values prompted on apply), and
**Advanced** (Environment: Default / Custom Dockerfile / Custom image; published ports as
add/remove rows; `direct | clone` mount). The Dockerfile choice takes an optional **file
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
**live**; image/mount changes prompt a **Rebuild** (recreate; workspace on the mount
preserved). A just-generated Dockerfile is **not** auto-built (it carries only the agent
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
through process stdin/stdout pipes (extension ↔ PowerShell ↔ sbx) — never argv, env
vars, or the repo; the sbx-side handling is unchanged FR-032.

**Two credential layers for `github`.** Provisioning `github` does two things:
(1) `sbx secret set` stores it host-side so the proxy authenticates the wire (git HTTPS /
API) without the token entering the sandbox; (2) a best-effort
`gh auth login --with-token` (token piped over `sbx exec -i`, never in argv) so the `gh`
CLI itself is authenticated inside — note this second layer deliberately puts the token
in gh's own config **inside** the sandbox. Runs only if `gh` is present and the instance
exists; silent on failure. The form separates **Global credentials** (host-global,
read-only) from **Custom credentials** (this sandbox).

## 9. Security & isolation

Provided by `sbx`, surfaced (not reimplemented) by the extension:

- **Isolation** — each sandbox is a microVM with its own kernel and Docker daemon.
- **Network policy** (Features §12) — host proxy enforces an allow-list; outbound hosts
  are logged/allowed/blocked.
- **Filesystem policy** (Features §12) — *direct* mount (read-write workspace) vs
  `--clone` (private in-container clone, host repo mounted read-only).
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

The `sbx` executable is resolved at runtime: the Windows installer places it at
`%LOCALAPPDATA%\DockerSandboxes\bin\sbx.exe` and does **not** add it to `PATH`, so
`sbx.ts` checks that location first and falls back to the bare command name.

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
| **Rebuild image** | re-run `docker build` → `template load` → recreate from the new image | refreshes image-baked tooling; workspace is on the mount, so work is safe |
| **Edit** | add/rotate secrets (`secret set <sandbox>`) and published ports (`sbx ports`) on a **running** sandbox | non-destructive, no recreate |

`mount` (§6) selects the FS workflow (see §9): `direct` (instant edits, in-sandbox git,
no parallelism) vs `clone` (private clone, retrieve via `git fetch sandbox-<name>`,
parallel-agent friendly, set only at create).

**Rebuild image is one action.** A single command/button runs the whole pipeline —
`docker build` → `docker save` → `sbx template load` → `sbx rm --force` → recreate from
the new image → re-attach — behind a progress indicator. The host workspace is on the
mount, so in-progress work survives the recreate; only image-baked tooling is refreshed.
(When the recipe has no custom image, "Rebuild" degrades to a plain Recreate.)

## 12. Explorer actions & lifecycle

**State-gated node actions.** The Explorer surfaces only the actions valid for a node's
state, enforcing a clear lifecycle — running → Stop → stopped → (Edit / Rebuild / Delete
instance) → absent → Remove from config:

| State | Inline actions |
|---|---|
| running | Stop · Connect · *(Shell in the context menu)* |
| stopped | Connect · Edit · Delete instance · *(Rebuild in the context menu)* |
| absent (defined, no instance) | Connect (creates the instance) · Edit · Remove from config |

Two distinct deletes: **Delete instance** (`sbx rm`, keeps the recipe — recreatable;
shown when stopped; runs **before** the recipe entry is touched) vs **Remove from
config** (destroys any live instance first, then drops the entry from `config.yaml`,
deleting the file if it was the last). A malformed `config.yaml` renders as a single
error node that opens the file — never as an empty "No sandboxes yet" tree.

**Title & Group (organising).** A spec may carry `title` (Explorer/status-bar label —
display-only, **never** part of the key, sbx name, file names, or image tags, so it is
safe to rename at any time) and `group` (folders the tree). New-sandbox keys derive from
the agent id (`claude`, `claude-2`, …). Groups are organisational today and the natural
hook for per-group governance (`sbx --profile`) later.

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
  of the file. On activation and after every form save: missing → write; identical →
  no-op; unmodified-but-older → silent refresh; **hash mismatch (manual edits) → never
  clobbered silently** (explicit Overwrite prompt). A sibling `.gitattributes` pins LF.
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
- **Remote Control is incompatible with the sbx credential proxy (by design).** The
  proxy injects an inference-scoped credential; the sandbox only holds a sentinel, so
  Claude Code's Remote Control cannot mint the session credentials it needs (401/403,
  confirmed not a network-policy block). Run Remote Control from a host (non-sandboxed)
  Claude Code.
- **Parallel sandboxes on the same repo (undecided).** Direct mount binds the single
  working tree, so two agents on one tree would race. Two paths: *(a) git worktrees* —
  each worktree gets its own identity → its own sandbox for free (note: the in-sandbox
  agent cannot use git in a worktree, its `.git` pointer resolves outside the mount —
  commit from the host); *(b) `sbx --clone`* — sandbox-managed private clone, work
  retrieved via the `sandbox-<name>` git remote. Worktrees fit the model best. Cost in
  both: N microVMs = N×RAM, and a picker UI.
- **Deferred scope**: filesystem/network policy UIs (Features §12), MCP endpoints
  (Features §13), kit injection (§7).
