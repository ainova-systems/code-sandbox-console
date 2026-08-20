# 017 — Lifecycle Hooks

> **Iteration spec — immutable history.** Describes what changed in this iteration and
> why. The current truth lives in [`../../Architecture.md`](../../Architecture.md) and
> [`../../Features.md`](../../Features.md); where this spec disagrees with them, they win.
>
> **Period:** 2026-08-17 · **Base:** `main` after spec 016
>
> **Status: shipped with this iteration.** FR-060 (lifecycle hooks) — `setup` / `startup` /
> `services` in the recipe, carried into the sandbox as a generated `sbx` kit; Features
> FR-060/FR-009/FR-052 and Architecture §4–§7, §9, §12–§14 carry the current truth.

## What & why

A sandbox is only useful once the workspace is **ready**, and the product covers only the
two extremes of getting it there. The custom image (FR-008/FR-053) bakes tooling that does
not depend on the repository; `sbx run` drops the agent into the workspace. Everything in
between — installing the project's dependencies, putting back the files git does not carry,
starting a service the project needs — is left to the user to type into a terminal after
every single start, or is not done at all.

`mount: clone` (FR-058, Architecture §9) makes the gap sharp rather than merely annoying.
The agent works on a private in-container clone, so everything the host has and git does
not — `.env.local`, generated agent configuration, data directories, `node_modules` — is
simply **absent**, on every create and after every Rebuild. The clone is not a copy of the
user's working tree; it is a clone of its git history.

Two real cases drove this, both from repositories that already use this extension:

- **A sync that must run before the agent does.** `tomis-next` regenerates its agent
  configuration in the tree from an `Intelligence/` umbrella (a `sync.sh` that self-locates
  the repo root and exits non-zero when its schema is stale). Under `mount: clone` it has to
  run on **every** start and finish **before** the agent attaches — otherwise Claude reads
  configuration that is missing or a version behind, and nothing says so.
- **A service that must be up on every start.** The `operator` sandbox hosts the Operator
  engine's compose stack. It stayed **commented out** in that repo's `.sandbox/config.yaml`
  because `sbx` has no restart policy, and the only substitute — the sandbox's own inner
  Docker daemon with a `restart:` policy — required a human to connect and run
  `docker build` + `docker compose up -d` by hand first.

FR-060 introduces recipe-declared lifecycle hooks so both are a property of the sandbox
definition, not of the user's memory.

**The mechanism is `sbx`'s own kits, not `sbx exec` from the extension.** Kits are the
upstream mechanism for exactly these two phases (Architecture §7 listed them as a planned
follow-up). Four verified properties decide it:

- **Ordering is guaranteed by sbx.** Startup commands run as part of container start, so
  they complete before `sbx run` attaches the agent. An `sbx exec` driven from `ops.ts`
  would race the agent terminal, which is precisely what the sync case cannot tolerate.
- **The hook belongs to the sandbox, not to the button.** A start from any surface — the
  Explorer, the generated CLI (FR-052), a bare `sbx run` in someone's terminal — replays
  the startup commands. Extension-run hooks would exist only where the extension runs.
- **`background: true` supplies the restart policy sbx itself lacks**, which is the whole
  of the operator case.
- **The install phase is already visible.** Its output streams through `sbx create`'s
  stdout, which this extension already pipes into the progress notification and the
  operation log (FR-055).

**Verified against the installed `sbx v0.31.3`** (probes run for this spec; the CLI's kit
schema is *not* the one on docs.docker.com — see Decisions):

| Question | Answer |
|---|---|
| Does `install` see the workspace under `mount: clone`? | **No.** It runs before the clone exists — the workspace directory is not there yet. `/run/sandbox/source` (the read-only host tree) **is** already mounted. |
| Does `startup` run on every start? | Yes, with the clone in place. |
| Is the kit frozen at create? | Yes. Editing the kit directory afterwards changes nothing until the kit is re-applied. |
| Does a failing `install` fail the create? | **Yes** — `sbx create` exits 1 with the kit name, the command, its exit code and a `docker run` repro hint, and leaves no sandbox behind. |
| Does a failing `startup` fail the start? | **No.** Create/start exits 0, the sandbox runs, and the dispatcher **stops without running the remaining hooks**. The only trace is `/var/log/sbx-kit-startup.log`: `fail <script> exit=<n>`. |
| Does re-applying the same kit duplicate its startup commands? | **No.** `sbx kit add <sandbox> <dir>` runs them once and replaces the same-named dispatcher entry. |
| Are git-ignored host files reachable from a clone-mode sandbox? | Yes — `/run/sandbox/source` is the host working tree, read-only, ignored files included. |

## What changed

- **Three hook lists in the recipe (FR-060).** `config.ts` parses and writes `setup`,
  `startup` and `services` — lists of shell command strings — on a sandbox spec, next to
  `dockerfile`/`mount`. `setup` runs once at creation, `startup` on every start, `services`
  on every start in the background. Absent lists mean the sandbox behaves exactly as before.
- **A generated kit, not a file to maintain (`kits.ts`).** The extension renders the spec's
  hooks into `.sandbox/kits/<key>/spec.yaml` in the v0.31.3 schema (`commands.install`,
  `commands.startup`, `startup` + `background: true`) and passes the directory to
  `sbx create --kit`. The kit is a build artefact: gitignored via `.sandbox/.gitignore`,
  regenerated from the recipe, never hand-edited. Only `config.yaml` and whatever scripts
  the user chooses to write are committed.
- **Hooks are mount-mode agnostic.** The kit sets `SANDBOX_WORKSPACE`, `SANDBOX_SOURCE`,
  `SANDBOX_NAME` and `SANDBOX_KEY` through `environment.variables`, so one command line
  works under both mount modes: `SANDBOX_SOURCE` is the read-only host tree
  (`/run/sandbox/source`) under `clone` and the workspace itself under `direct`.
- **Validated before anything is created.** `sbx kit validate` runs in the same preflight
  band as the UNC check (FR-040) and the shallow-repository refusal (FR-058), so a malformed
  hook — or a kit schema that a future `sbx` renames — is refused with the CLI's own message
  before the first mutation, instead of failing inside `create`.
- **A failed startup hook is reported, not swallowed.** After a start, `ops.ts` reads the
  sandbox's `/var/log/sbx-kit-startup.log`, writes the last dispatcher run into the
  `Sandbox Console` channel (FR-055) and, on a `fail … exit=<n>` line, shows a warning
  naming the sandbox with **Show Log** / **Open Shell**. This is the only signal that exists:
  the start itself succeeds and the remaining hooks are skipped.
- **Changed hooks are applied without a Rebuild.** Because a same-named kit replaces its
  dispatcher entry, `sbx kit add` re-applies edited hooks to an existing sandbox. The form's
  Save offers it the way image/mount changes offer a Rebuild, and the Explorer exposes it
  per node; recreating the sandbox is never required just to change a command.
- **The repo carries a working demo of its own feature.** `.sandbox/config.yaml` (committed
  for the first time here, per FR-009's own model) gains a `hooks-demo` clone-mode sandbox
  whose commands exist to be read: `setup` records that the workspace does not exist yet,
  `startup` copies a file the clone cannot contain out of the read-only host mount and
  stamps both HEADs, `services` writes a heartbeat. The acceptance table that reads this
  evidence lives in the `ext-run-local` skill, so accepting FR-060 is a procedure rather
  than a memory. Deliberately one command per line: block scalars would parse in the
  extension and not in the generated CLI, which would make the demo prove less than it
  claims.
- **The generated project CLI keeps parity (FR-052).** `.sandbox/scripts/sbx.sh` renders the
  same kit and passes `--kit` on create, so a sandbox created from an external shell gets
  the same hooks as one created from the Explorer.

## Decisions

- **Commands in the recipe, scripts by choice.** A hook is a list of shell command strings;
  a project that wants more writes a script and points a hook at it
  (`bash $SANDBOX_SOURCE/.sandbox/sync.sh`). One concept, no path-resolution magic, and the
  short cases stay a single line in `config.yaml`.
- **Point hooks at `$SANDBOX_SOURCE`, not at the clone.** The kit is frozen at create, but a
  command that *invokes a committed script* re-reads that script on every start, so editing
  the script needs no re-apply at all. Under `clone` the host tree is also the only copy that
  is current — the clone is a snapshot of git history, and a script edited on the host after
  the create is not in it.
- **Repo-dependent work belongs in `startup`, not `setup`.** Verified: under `mount: clone`
  the workspace does not exist during the install phase. `setup` is for work that needs only
  the network and `$SANDBOX_SOURCE` (building an image, fetching a toolchain); anything that
  touches the workspace must be idempotent and live in `startup`.
- **`services` is a separate list, not a flag.** It maps to `background: true`, and the
  distinction the user cares about — "this must finish before the agent starts" versus "this
  must be running while the agent works" — is exactly the distinction between the two lists.
- **No new mount mode and no host-side sync.** The extension does not copy git-ignored files
  into the clone itself; it gives the sandbox a place to do it, from the read-only mount sbx
  already provides. Nothing new is written to the user's working tree.
- **Third-party kits (`kits: [<ref>]`) are deferred.** `--kit` also accepts ZIP, git and OCI
  references and they stack, so reusable team kits are a small follow-up — but they bring
  their own preflight (`kit.allowedSources` defaults to `docker.io/` only), and this
  iteration stays on the project's own hooks.
- **Accepted end to end before shipping, not only typechecked.** A clone-mode sandbox was
  created with a generated kit against the real CLI: `setup` reported the workspace absent
  and `$SANDBOX_SOURCE` present, `startup` copied git-ignored build output from the
  read-only host mount into the clone, and the backgrounded service was alive after the
  start. Both generators (`kits.ts` and the bash `write_kit`) were run through
  `sbx kit validate`, including commands carrying quotes, `#` and `:`.
- **The upstream schema is experimental and already skewed.** `sbx kit` is marked
  EXPERIMENTAL, and the installed v0.31.3 accepts `commands.install` / `commands.startup`
  while docs.docker.com documents `setup.install` / `setup.startup` / `setup.files`. The
  generator targets the installed CLI and the preflight validates against it, so a version
  that renames the schema produces a refusal that names the problem rather than a broken
  create. Recorded in Architecture §14.
