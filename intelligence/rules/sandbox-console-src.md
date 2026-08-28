---
paths:
  - "src/**"
  - "package.json"
description: "Module map, sbx CLI containment and the credential model for the extension source"
---

# Extension source

## REQUIRED

**Pick the module from the map below and keep the dependency direction.** The map is the
project's layering contract; a module that starts reaching sideways is how the palette and the
Explorer drift apart.

**A new command lands in three places at once**: `contributes.commands` (plus its menu and
`when` clauses) in `package.json`, registration in `src/extension.ts`, and the shared flow in
`src/ops.ts` whenever both the palette and the Explorer need it.

**Cite `FR-0xx` in code comments where the code carries the requirement.** That citation is what
keeps `docs/Features.md` traceable from the source — the header comment in `src/log.ts` is the
shape to copy.

## Invariants

**Every child-process `sbx` invocation lives in `src/sbx.ts`;** the interactive `sbx run` /
`sbx exec` shellArgs live in `src/terminal.ts`. One carve-out: the bash template in
`src/script.ts` *renders* sbx calls into the generated `.sandbox/scripts/sbx.sh` (FR-052) for
external shells. The extension never executes them, but the template must be updated in the same
change whenever a CLI shape moves, or the generated CLI silently stops matching the extension.

**Nothing imports from `src/extension.ts`.**

**Secret values travel only over stdin pipes** — never argv, environment variables, image layers
or logs (`src/sbx.ts:593`, `src/blobs.ts:126`). The credential priority is fixed: OAuth `/login`
as the default fallback, then an API key in the OS keychain via `sbx secret set [-g | <sandbox>] <service>`,
and never a plaintext `ANTHROPIC_API_KEY`. The value is piped with no flag — `--password-stdin`
is registry-only. The host's own `~/.claude` login is deliberately not reused; that isolation is
the whole point of the microVM (`docs/Architecture.md` §8).

**The argv allowlists in `src/sbx.ts` cover every new invocation** (`src/sbx.ts:65`). Sandbox
names, agent ids, image tags and secret services all pass them before reaching a child process.

**Dockerfile and build-context paths stay inside the repository**, and the webview keeps its
`Content-Security-Policy` with no remote content (`src/form.ts:750`).

**`sbx.hostToSandboxPath()` is the only host→sandbox path conversion,** and it fails fast on UNC
and WSL paths before any mutating sbx call (`src/ops.ts:594`). `exec`-based shells pass the
translated path with `-w`.

## Architecture — module map

| Module | Owns |
|---|---|
| `extension.ts` | commands and startup discovery UX |
| `config.ts` | `.sandbox/config.yaml` recipe parse/write, including the project `name` (FR-009) |
| `identity.ts` | `.sandbox/identity.yaml` `{id}` — the local random suffix |
| `sbx.ts` | CLI wrapper: lifecycle, `template load`/`ls`/`rm`, `secret set` and discovery, `hostToSandboxPath` |
| `images.ts` | custom-image build `--pull` → save → `template load`, and the rebuild image-refresh policy (FR-008/FR-053) |
| `kits.ts` | lifecycle hooks (FR-060): the generated kit `.sandbox/kits/<key>/spec.yaml` passed as `sbx create --kit`, the `startup.sh` runner it bootstraps, the kit schema and the `SANDBOX_*` variables — rewritten before every start |
| `secrets.ts` | provisioning missing secrets through the cached-entry picker/prompt (FR-032, FR-051) |
| `blobs.ts` | per-project secret cache: DPAPI blobs in `~/.sbx`, shared with the generated CLI (FR-051) |
| `script.ts` | the generated project CLI `.sandbox/scripts/sbx.sh` (FR-052) — written, never executed |
| `sandbox.ts` | recipe→refs, naming, lifecycle |
| `ops.ts` | per-sandbox create/attach/rebuild/shell shared by palette and Explorer; progress spinners, the one-operation-per-sandbox guard (FR-054) and cancellation (FR-056) |
| `git.ts` | read-only host git probes — `isShallowRepository` for the clone-mount preflight (FR-058); never mutates a repo |
| `prereq.ts` | host readiness (FR-059): classifies `sbx diagnose` into missing/signed-out/unhealthy, owns the shared modal refusal and status-bar tooltip, and answers the *separate* host-Docker question for custom-image mode — sbx itself needs no Docker |
| `log.ts` | operation log (FR-055): the `Sandbox Console` channel and the spawn runner every sbx/docker call streams through — process plumbing only, no CLI strings |
| `names.ts` | per-working-copy `workspaceState` record of sbx names that can no longer be created (FR-057) |
| `terminal.ts` | native terminals driving sbx, plus `openHostCommandTerminal` — the one host terminal, which types the FR-058 fix without running it |
| `form.ts` | the webview Configure form |
| `tree.ts` | Sandbox Explorer view and its per-node commands |
| `agents.ts` / `services.ts` | registries and discovery |

Dependency direction:

```
extension → {ops, form, tree, prereq, sandbox, config, identity, agents, names, script, secrets, sbx, log}
ops       → {images, kits, secrets, sandbox, terminal, names, git, sbx, log}
tree      → {ops, form, prereq, sandbox, config, identity, agents, sbx, log}
form      → {ops, prereq, secrets, sandbox, config, identity, agents, names, script, sbx}
secrets   → {blobs, sandbox, services, sbx}
sandbox   → {config, identity, sbx, log}
images    → {config, sbx, log}
kits      → {config, sbx}
prereq    → {images, sbx}
script    → config      git → log      sbx → log
```

Nothing depends on `extension`.
