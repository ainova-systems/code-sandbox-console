# 002 — Managed Sandbox UI (v0.2)

> **Iteration spec — immutable history.** Describes what changed in this iteration and
> why. The current truth lives in [`../../Architecture.md`](../../Architecture.md) and
> [`../../Features.md`](../../Features.md); where this spec disagrees with them, they win.
>
> **Period:** 2026-06-09 ·
> **Commits:** `f996c19` (POC → managed UI), `c1ffec8` (rebrand, pre-release)

## What & why

From single-Claude POC to a managed, multi-agent sandbox UI: a committed per-repo
recipe, a Sandbox Explorer, a New/Edit form, custom images, and secret provisioning.
Rebranded from the *Ainoflow Sandbox Terminal* POC to **Sandbox Console**
(`sandboxConsole.*` command namespace, publisher id `ainova-systems`).

## Key decisions

- **Identity/config split by git treatment** — the v0.1 single `.sandbox` file became a
  `.sandbox/` folder: committed `config.yaml` (compose-like recipe + project `name`)
  vs gitignored `identity.yaml` (short random `id`). Sandbox name:
  `<name>-<key>-<id>` — the local id keeps clones/copies/worktrees conflict-free.
- **Compose semantics for environments** — `image` is the tag; `dockerfile` set →
  build & tag as `image`; neither → agent default image.
- **Custom images via templates** (verified live): `docker build` → `docker save` →
  `sbx template load` → `create -t`. The sbx runtime image store is separate from the
  host docker store. Base-image contract honoured (`FROM docker/sandbox-templates:…`,
  `USER root … USER agent`). Kits (`sbx kit add`) deliberately deferred.
- **Instance-first New/Edit webview** — the user edits a *sandbox*, not a YAML file;
  Save = persist to recipe AND apply to the instance (secrets/ports live; image/mount
  via confirmed Rebuild). A generated Dockerfile is not auto-built — the user edits it
  first.
- **Rebuild split into three operations** — Recreate (destroys sandbox state),
  Rebuild image (refreshes tooling, workspace safe), Edit (live, non-destructive).
- **Secret provisioning (FR-032)** — values prompted in the UI and piped over stdin to
  `sbx secret set [-g | <sandbox>] <service>`; never argv/env/repo/image. For `github`,
  additionally a best-effort `gh auth login --with-token` inside the sandbox.
- **Explorer is repo-scoped** with state-gated node actions (running → Stop → Edit /
  Rebuild / Delete instance → Remove from config) and optional `group` folders.
- **Status bar item** with live state and click-to-connect.

## Verification snapshot (as of this iteration)

- Custom-image pipeline verified live (spike): built `FROM
  docker/sandbox-templates:claude-code`, marker present at runtime, agent user and
  `claude` binary intact, FLAVOR auto-inherited.
- Global `anthropic` secret reuse verified live: a fresh sandbox was authenticated with
  no login step.
- `tsc --noEmit` clean, esbuild bundles, `vsce` manifest validates; runtime UI flows
  (webview, tree actions, live secret set / image build) pending F5 manual validation.
- Confirmed limitation: Claude Code Remote Control cannot run inside a sandbox (the
  credential proxy injects an inference-scoped credential; not a network-policy block).
