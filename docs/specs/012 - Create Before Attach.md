# 012 — Create Before Attach

> **Iteration spec — immutable history.** Describes what changed in this iteration and
> why. The current truth lives in [`../Architecture.md`](../Architecture.md) and
> [`../Features.md`](../Features.md); where this spec disagrees with them, they win.
>
> **Period:** 2026-07-28 · **Base:** `main` after spec 011
>
> **Status: shipped with this iteration.** Architecture §5 carries the current truth;
> no FR text changed (FR-003/FR-005 behaviour is unchanged — only the CLI shape behind
> Connect).

## What & why

Connecting to a not-yet-created sandbox used the one-shot create-form of `sbx run`
(`sbx run --name <name> [flags] <agent> <workspace>`), which creates the sandbox and
attaches the agent in a single interactive terminal. Reproduced live on sbx v0.31.3:
that form matches an existing sandbox by **agent + workspace** and **ignores `--name`**.
When any other sandbox for the same agent and workspace exists — typically an orphan
left by a regenerated `.sandbox` identity (re-created `.sandbox/`, re-cloned repo at the
same path) — it refuses with `sandbox '<other>' already exists and can't be given new
workspaces` and exits 1. In a closing terminal that error text is lost, so both Connect
and Rebuild failed with nothing but a "terminated with exit code: 1" popup.

`sbx create` with identical arguments honours `--name` and succeeds; the by-name attach
form `sbx run <name>` is immune to the quirk. The extension already used exactly that
create-then-attach sequence whenever the recipe declared secrets — the one-shot form
survived only in the no-secrets branch.

## What changed

**Connect and Rebuild always create non-attaching, then attach by name.** The absent
path of `createOrAttach` and the recreate tail of `rebuildRef` (src/ops.ts) now run
`sbx create --name …` behind the existing progress notification and open the terminal
with `sbx run <name>`. The one-shot branch — and `openAgentCreate` in src/terminal.ts,
its only implementation — is deleted.

Side benefits, beyond dodging the quirk:

- **Errors surface.** `sbx create` runs as a child process, so a failure becomes a real
  error message (its stderr), not an exit code in a dying terminal.
- **One code path.** Secrets and no-secrets recipes now create identically; per-sandbox
  secrets still apply between create and attach (FR-032), as before.

The generated project CLI (FR-052) already used `sbx create` in `create_instance` and
needed no change. Architecture §5's command-mapping row for FR-003 now documents the
two-step shape and warns against the one-shot form.

## Decisions

- **Work around, don't wait out.** The quirk lives in sbx v0.31.3's `run` argument
  resolution; even if upstream fixes it, `create` + `run <name>` is the shape with
  strictly better error reporting, so it stays.
- **No orphan cleanup.** The extension does not delete or adopt other sandboxes that
  point at the same workspace — they may belong to another working copy of the repo, and
  destroying state is never an implicit side effect of Connect.
