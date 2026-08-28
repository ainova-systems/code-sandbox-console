---
description: "Sandbox Console: what it is, its documentation model, and the sbx and UX invariants every change respects"
---

# Sandbox Console

Terminal-first VS Code extension that runs AI coding agents (Claude first) inside isolated,
persistent Docker Sandboxes (`sbx` microVMs). The extension is a thin orchestration layer over
the `sbx` CLI — it never manages containers itself. Raw-Docker container management was
deliberately abandoned for `sbx` (`docs/Architecture.md` §2, `docs/specs/completed/001 - Walking Skeleton.md`);
do not reintroduce it.

## REQUIRED

**Two canonical docs are always current.** `docs/Features.md` is the functional truth and owns
the stable `FR-0xx` ids cited throughout the code — never renumber them. `docs/Architecture.md`
is the technical truth; read it before changing backend behaviour. Documentation that drifts
from shipped code is a defect, so both move in the same change as the code.

**A substantial change carries its spec** — a new FR, a behaviour change, or an architectural
shift. Add the next `docs/specs/00N - <Iteration>.md`, then update `Features.md` and
`Architecture.md` to match. Specs sit in `docs/specs/drafts/` while `Status: planned` and move
to `docs/specs/completed/` once shipped; numbering runs continuously across both folders, and a
merged spec is immutable. A trivial fix — typo, comment, doc wording — skips the spec. The
`spec-draft` and `spec-implement` skills sequence this.

**Verify upstream `sbx` behaviour against its own documentation** —
<https://docs.docker.com/ai/sandboxes/>, whose specific `customize/` pages for templates and
kits are named in `docs/Architecture.md`. The CLI is external and authoritative: a guessed flag
becomes a runtime failure that surfaces only when a sandbox refuses to start.

## Invariants

Release guarantees, not preferences (`docs/Features.md` §3–§4):

- **Attach — labelled "Connect" in the UI — is the primary action whenever a sandbox exists, and
  resume is the default.** Never steer a user toward a duplicate sandbox.
- **Terminal-first.** Every agent interaction is a native terminal window; no chat panels and no
  custom agent UI.
- **No implicit default sandbox.** Every sandbox is defined through the New Sandbox form.
- **Startup is quiet.** Opening a workspace shows no notification and writes nothing into
  `.sandbox/` (FR-002).

## Architecture

The committed `.sandbox/config.yaml` recipe (FR-009) holds the shared project `name` and its
sandboxes; the gitignored `.sandbox/identity.yaml` holds a short random `id`. The sbx sandbox
name is `<name>-<key>-<id>`, which is what keeps clones, copies and worktrees from colliding
(`docs/Architecture.md` §6).

### The sbx facts that bite

- **There is no `sbx start`.** Resume a stopped sandbox with `sbx run <name>`, or with
  `sbx exec`, which auto-starts it.
- **Lifecycle mapping:** create and attach → `sbx run`; stop → `sbx stop`; destroy →
  `sbx rm --force`; discovery → `sbx ls --json`.
- **`sbx` is never assumed to be on PATH.** On Windows it installs to
  `%LOCALAPPDATA%\DockerSandboxes\bin\sbx.exe`, and `sbxPath()` in `src/sbx.ts` checks that
  location before PATH on every call. A PATH entry may not exist, and it never rescues a VS Code
  window that was already open when sbx was installed — that process captured its environment
  first.
- **`/home/agent/workspace` inside a sandbox is an empty decoy, not the mount.** The host drive
  is mounted by letter (`D:` → `/d`), so the workspace is `/d/<path>`.
- **Persistence is native to sbx:** `stop` keeps state, `rm` destroys it. Do not add volumes.

## Build & check

`npm run verify` — strict typecheck (`tsc --noEmit`) plus the esbuild bundle — is the single
verification command and the real gate: esbuild bundles without type-checking, so the typecheck
inside `verify` is what actually checks the code. CI runs that same command. There is no test
runner; acceptance is a manual run plus direct `sbx` probing, and "build is green" means
`npm run verify` exited 0.

Module boundaries, CLI containment and the credential model live in the `sandbox-console-src`
rule, which loads when you touch the extension source.
