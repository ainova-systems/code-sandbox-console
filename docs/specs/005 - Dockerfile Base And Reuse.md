# 005 — Dockerfile Base & Reuse (FR-008)

> **Iteration spec — immutable history.** Describes what changed in this iteration and
> why. The current truth lives in [`../Architecture.md`](../Architecture.md) and
> [`../Features.md`](../Features.md); where this spec disagrees with them, they win.
>
> **Period:** 2026-06-10 · **Base:** `main` after spec 004

## What & why

Local `.vsix` testing surfaced two FR-008 gaps:

- A sandbox created with the **Claude agent** and *Custom: Dockerfile* got a file seeded
  `FROM docker/sandbox-templates:shell` — the generic shell base instead of the agent's
  own. The base must match the selected agent.
- The generated Dockerfile was always named `<key>.Dockerfile`, so two sandboxes could
  not share one environment definition: there was no way to point a second (e.g.
  temporary) sandbox at an already-committed Dockerfile.

## What changed

- **Agent-matched base.** `agentTemplate()` (agents.ts registry) maps the agent id to
  its `docker/sandbox-templates` flavor (claude → `claude-code`, cursor →
  `cursor-agent`, others 1:1; unknown kits → `shell`) and picks the **`-docker`
  variant** — the same baseline the sbx CLI boots by default for built-in agents
  (upstream templates doc). Generated Dockerfiles now `FROM` that tag, with the full
  flavor list referenced in comments.
- **Dockerfile name field.** The *Custom: Dockerfile* choice in the New/Edit form gained
  a file-name input (under `.sandbox/`; empty → `<key>.Dockerfile`). A missing file is
  seeded; an existing one is **reused untouched**, so several sandboxes can share one
  committed Dockerfile — and, via the derived tag, the image built from it.
- The typed name is validated like recipe keys (no path separators, no leading dot) —
  an untrusted value must never steer the write target outside `.sandbox/`.

## Decisions

- Seed the `-docker` flavor (not the slim one): it mirrors what the CLI runs for the
  default agent image, so switching a sandbox from *Default agent image* to *Custom:
  Dockerfile* starts from the same environment.
- An unchanged dockerfile name on an edit round-trip is accepted as-is (including
  hand-authored subfolder paths in `config.yaml`) — validation applies only to new or
  changed names, so existing recipes keep working.
- Derived image tags are `<project>:<dockerfile stem>` (e.g. `claude.Dockerfile` →
  `myproj:claude`), not `<project>-<key>:latest`: the image is a product of the
  Dockerfile, so sandboxes sharing the file share the image and one Rebuild refreshes
  the environment for all of them. Hand-set `image:` values in the recipe survive edit
  round-trips untouched.
