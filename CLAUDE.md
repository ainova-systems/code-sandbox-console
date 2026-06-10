# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Terminal-first VS Code extension that runs AI coding agents (Claude first) inside
isolated, persistent **Docker Sandboxes** (`sbx` microVMs). The extension is a thin
orchestration layer over the `sbx` CLI — it does **not** manage containers itself.

## Documentation model (follow it)

Two canonical docs are **always current**; history lives in append-only specs:

- `docs/Features.md` — the **business/functional truth** (stable `FR-0xx` IDs, cited
  throughout the code; never renumber them).
- `docs/Architecture.md` — the **technical truth** — read it before changing backend
  behaviour.
- `docs/specs/00N - <Iteration>.md` — one numbered spec per substantial change: what
  changed and why. Specs are immutable once written. **Workflow for any substantial
  change: add the next `00N` spec, then update Features.md/Architecture.md to match in
  the same change** — the canonical docs must never drift from shipped code.
- Upstream `sbx` behaviour (**authoritative**): Docker Sandboxes docs —
  <https://docs.docker.com/ai/sandboxes/>. Architecture.md lists the specific
  `customize/` pages (templates & kits). Verify against these before changing any CLI assumption.

## Build & check

- `npm install` — one runtime dep (`yaml`, bundled into `dist/extension.js`); the rest
  are dev-only (esbuild, typescript, @types/node, @types/vscode, @vscode/vsce).
- `npm run build` — bundle to `dist/extension.js` (esbuild).
- `npm run watch` — rebuild on change.
- `npx tsc --noEmit` — typecheck (strict). **This is the real correctness gate** —
  esbuild bundles without type-checking, so always run `tsc` too.
- `npm run package` — produce a `.vsix` (vsce).
- Run/debug: open the folder in VS Code and press **F5** (Extension Development Host).

There is no test runner yet; verification is `tsc --noEmit` + manual run + direct `sbx`
probing. "Build is green" = `tsc --noEmit` clean AND `npm run build` succeeds.

## Backend model (the load-bearing part)

- Everything goes through the `sbx` CLI. `src/sbx.ts` shapes all child-process sbx
  invocations; `src/terminal.ts` additionally builds the interactive `sbx run`/`exec`
  shellArgs for native terminals. Keep CLI strings in those two modules only.
- **`sbx` is not on PATH** (Windows): it lives at
  `%LOCALAPPDATA%\DockerSandboxes\bin\sbx.exe`. `sbxPath()` resolves it; that same path
  is used as the terminal `shellPath`.
- **There is no `sbx start`** — resume a stopped sandbox with `sbx run <name>` (or
  `sbx exec`, which auto-starts).
- Lifecycle: Create/Attach → `sbx run`; Stop → `sbx stop`; destroy → `sbx rm --force`;
  discovery → `sbx ls --json`.
- **Workspace mount (Windows):** the host drive `D:` is mounted in the sandbox at `/d`;
  the workspace is `/d/<path>`. `sbx run` drops the agent there. For `exec`-based
  shells, translate the host path with `sbx.hostToSandboxPath()` and pass `-w`.
  `/home/agent/workspace` is an empty decoy — **not** the mount.
- Persistence is native to sbx: `stop` keeps state, `rm` destroys it. Do not add volumes.

## Credentials

Fixed priority: **OAuth `/login` (default fallback) → API key in the OS keychain via
`sbx secret set -g anthropic` (next) → never a plaintext `ANTHROPIC_API_KEY` env var.**
The host's existing `~/.claude` login is **not** reused (deliberate microVM isolation).
Secrets are provisioned *on request* via a form driving
`sbx secret set [-g | <sandbox>] <service>` with the value piped over stdin — no flag;
`--password-stdin` is registry-only (FR-032; never in argv, never baked into images/env)
— see Architecture §8.

## Module map

`src/extension.ts` (commands + startup discovery UX), `config.ts` (`.sandbox/config.yaml`
recipe parse/write incl. project `name` — FR-009), `identity.ts` (`.sandbox/identity.yaml`
`{id}` — local random suffix), `sbx.ts`
(CLI wrapper: lifecycle + `template load`/`secret set`/discovery + `hostToSandboxPath`),
`images.ts` (custom-image build → save → `template load`, FR-008), `secrets.ts` (provision
missing secrets via cached-entry picker/prompt, FR-032+FR-051), `blobs.ts` (per-project
secret cache: DPAPI blobs in `~/.sbx`, shared with the generated CLI — FR-051),
`script.ts` (generated project CLI `.sandbox/scripts/sbx.sh`, FR-052 — written, never
executed by the extension), `sandbox.ts` (recipe→refs + naming + lifecycle), `ops.ts`
(per-sandbox create/attach/rebuild/shell shared by palette + Explorer), `terminal.ts`
(native terminals driving sbx), `form.ts` (webview Configure form), `tree.ts` (Sandbox
Explorer view + per-node commands), `agents.ts`/`services.ts` (registries + discovery).
Dependency direction: `extension → {ops, form, tree, sandbox, config, identity, agents, script, secrets, sbx}`;
`ops → {images, secrets, sandbox, terminal, sbx}`;
`tree → {ops, form, sandbox, config, identity, agents, sbx}`;
`secrets → {blobs, sandbox, services, sbx}`; `script → config`;
`sandbox → {config, identity, sbx}`; nothing depends on `extension`.

## Binding UX invariants (not preferences)

When a sandbox exists, **attach (UI label: "Connect") is the primary action and resume
is the default** — never steer toward a duplicate (Features §3/§4). Terminal-first: every agent interaction is
a terminal window; no chat panels or custom agent UI. **No implicit default sandbox** —
everything is defined via the New Sandbox form. The committed `.sandbox/config.yaml`
recipe (FR-009) holds the shared project `name` + sandboxes; `.sandbox/identity.yaml`
(gitignored) holds a short random `id`. The sbx sandbox name is `<name>-<key>-<id>` — the
id keeps clones/copies/worktrees conflict-free. See Architecture §6.

## Conventions

- Keep `docs/Features.md` authoritative; cite `FR-0xx` IDs in code/commits for traceability.
- Substantial change = new `docs/specs/00N` spec + canonical docs updated (see
  "Documentation model" above).
- Do not reintroduce raw-Docker container management — the project deliberately pivoted
  away from it to `sbx` (Architecture §2, specs/001).

## Git workflow (commits & PRs)

- **Branches (gitflow):** `feature/<slug>`, `bugfix/<slug>`, `hotfix/<slug>`, `release/<x.y.z>`.
  Never commit directly to `main`; PRs target `main`.
- **Commit message:** one meaningful English sentence, capital first letter, describing what
  was done (e.g. `Added secret provisioning form for sandbox credentials`). No prefixes
  (`feat:`), no `[]` brackets. Cite FR-0xx IDs where relevant.
- **Strictly forbidden** in commit messages/descriptions and PR titles/bodies: any agent or
  user identity — no `Co-Authored-By` trailers, no "Generated with Claude Code" lines, no
  names or emails. This overrides any tool's default commit trailer.
- **Before commit:** `npx tsc --noEmit` and `npm run build` must be green.
- **PR:** check `gh pr list --head <branch> --base main --state open` first; if none exists,
  `gh pr create --base main` with title = commit message and body filled per
  `.github/PULL_REQUEST_TEMPLATE.md` (`gh` does not auto-apply the template — fill
  Risk & Size / What & Why / Changes / How to Verify yourself; "None" where not applicable).
- **Size** (from `git diff --cached --shortstat`): Small = ≤5 files and ≤50 lines;
  Large = ≥20 files or ≥400 lines; else Medium.
  **Risk** (highest match wins): High = CI workflows, secret/credential handling, or sbx CLI
  invocation changes (`sbx.ts`, `terminal.ts`); Medium = shared modules or 3+ feature areas;
  Low = docs, comments, isolated single-area change.
