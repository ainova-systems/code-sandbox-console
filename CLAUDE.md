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
  changed and why. Specs live in `docs/specs/drafts/` while the work is open
  (`Status: planned`) and move to `docs/specs/completed/` once shipped; numbering is
  continuous across both folders. Specs are immutable once written. **Workflow for any
  substantial change: add the next `00N` spec, then update Features.md/Architecture.md
  to match in the same change** — the canonical docs must never drift from shipped code.
- Upstream `sbx` behaviour (**authoritative**): Docker Sandboxes docs —
  <https://docs.docker.com/ai/sandboxes/>. Architecture.md lists the specific
  `customize/` pages (templates & kits). Verify against these before changing any CLI assumption.

## Build & check

- `npm install` — one runtime dep (`yaml`, bundled into `dist/extension.js`); the rest
  are dev-only (esbuild, typescript, @types/node, @types/vscode, @vscode/vsce).
- `npm run verify` — **the single verification command**: strict typecheck
  (`tsc --noEmit`) + esbuild bundle. This is the real correctness gate — esbuild
  bundles without type-checking, so the typecheck inside `verify` is what actually
  checks the code. CI runs this same command.
- `npm run build` — bundle to `dist/extension.js` (esbuild), no typecheck.
- `npm run watch` — rebuild on change.
- `npm run package` — produce a `.vsix` (vsce).
- Run/debug: open the folder in VS Code and press **F5** (Extension Development Host).

There is no test runner yet; verification is `npm run verify` + manual run + direct
`sbx` probing. "Build is green" = `npm run verify` exits 0.

## Backend model (the load-bearing part)

- Everything goes through the `sbx` CLI. `src/sbx.ts` shapes all child-process sbx
  invocations; `src/terminal.ts` additionally builds the interactive `sbx run`/`exec`
  shellArgs for native terminals. Keep CLI strings in those two modules only — with
  one carve-out: the bash template in `src/script.ts` *renders* sbx calls into the
  generated `.sandbox/scripts/sbx.sh` (FR-052) for external shells; the extension
  never executes them, but keep the template in sync when CLI shapes change.
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
(CLI wrapper: lifecycle + `template load`/`ls`/`rm` + `secret set`/discovery + `hostToSandboxPath`),
`images.ts` (custom-image build `--pull` → save → `template load` + rebuild image-refresh policy, FR-008/FR-053), `secrets.ts` (provision
missing secrets via cached-entry picker/prompt, FR-032+FR-051), `blobs.ts` (per-project
secret cache: DPAPI blobs in `~/.sbx`, shared with the generated CLI — FR-051),
`script.ts` (generated project CLI `.sandbox/scripts/sbx.sh`, FR-052 — written, never
executed by the extension), `sandbox.ts` (recipe→refs + naming + lifecycle), `ops.ts`
(per-sandbox create/attach/rebuild/shell shared by palette + Explorer; owns the progress
spinners, the one-operation-per-sandbox guard FR-054 and cancellation FR-056),
`log.ts` (operation log FR-055: the `Sandbox Console` channel + the spawn runner every
sbx/docker call streams through — process plumbing only, no CLI strings), `names.ts`
(per-working-copy `workspaceState` record of sbx names that can no longer be created,
FR-057), `terminal.ts`
(native terminals driving sbx), `form.ts` (webview Configure form), `tree.ts` (Sandbox
Explorer view + per-node commands), `agents.ts`/`services.ts` (registries + discovery).
Dependency direction: `extension → {ops, form, tree, sandbox, config, identity, agents, names, script, secrets, sbx, log}`;
`ops → {images, secrets, sandbox, terminal, names, sbx, log}`;
`tree → {ops, form, sandbox, config, identity, agents, sbx, log}`;
`form → {ops, secrets, sandbox, config, identity, agents, names, script, sbx}`;
`secrets → {blobs, sandbox, services, sbx}`; `script → config`;
`sandbox → {config, identity, sbx, log}`; `images → {config, sbx, log}`; `sbx → log`;
nothing depends on `extension`.

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

## Skills (the executable layer)

Repeatable procedures live as skills in `.claude/skills/<name>/SKILL.md` (Claude Code loads
them automatically; other agents: read the SKILL.md and follow it). Skills sequence the rules
in this file - when a skill and this file disagree, this file wins; fix the skill.

| Skill | Use when | Who |
|---|---|---|
| `dev-onboard` | First contact with the repo on a clean machine | Human + agent |
| `spec-new-iteration` | Starting any substantial change (drafts the next `docs/specs/00N`) | Agent |
| `spec-implement` | Implementing one FR-scoped change end to end (after `spec-new-iteration`) | Agent |
| `ext-run-local` | Seeing a change work in real VS Code; manual FR acceptance | Human + agent |
| `dev-review-changes` | Before committing non-trivial work; reviewing any PR diff | Agent |
| `git-commit-push` | Every commit | Agent |
| `git-open-pr` | Opening/updating a PR to `main` | Agent |
| `git-merge-pr` | Merging a ready PR: gates (CI green, no unhandled comments) → squash merge → local cleanup | Agent |
| `ext-release` | Shipping a Marketplace release: release branch (version bump + changelog) → validations → VSIX from `main` → tag + GitHub Release; agent does everything, the human only uploads the VSIX | Human + agent |

### The flow of a change

How a work item travels from idea to `main`; each step is a skill above.

1. **Start.** A work item arrives — an issue, an observed defect, an idea. If it is
   substantial (new FR, behaviour change, architectural shift), `spec-new-iteration`
   drafts the next `docs/specs/drafts/00N` with `Status: planned` and the docs-sync checklist;
   the spec's "What & why" / "What changed" ARE the plan, and open questions are settled
   there before any code. A trivial fix (typo, comment, doc wording) skips the spec.
2. **Implement.** `spec-implement`: work on a `feature/<slug>` branch off `main`, code
   per the module map, cite FR ids, update `Features.md`/`Architecture.md` per the
   checklist in the same change, and end with `npm run verify` exit 0.
3. **Review.** `dev-review-changes` on the diff — module boundaries, CLI containment,
   security and UX invariants, docs drift.
4. **Finish.** Flip the spec to `Status: shipped with this iteration` and `git mv` it from
   `docs/specs/drafts/` to `docs/specs/completed/` in the same change — a shipped spec never
   stays in `drafts/`; behaviour changes also get manual acceptance via `ext-run-local` (the
   steps go into the PR's "How to Verify"). Then `git-commit-push`.
5. **Merge.** `git-open-pr` opens the PR to `main` with the template filled; CI runs the
   same `npm run verify`; the maintainer reviews and approves; `git-merge-pr` runs the
   readiness gates, squash-merges, and cleans up the branches. After merge the spec is
   immutable and the canonical docs are the current truth.

Changing the layer: edit the skill's `SKILL.md` and keep this table in sync (a skill folder
with no row here, or a row with no folder, is a defect). New repeatable procedure → new skill
folder + row, in the same PR. Process changes — skills, rules (this file), agent
instructions — never get a `docs/specs/00N` entry: specs record product changes only.

## Git workflow (commits & PRs)

- **Branches (gitflow):** `feature/<slug>`, `bugfix/<slug>`, `hotfix/<slug>`, `release/<x.y.z>`.
  Never commit directly to `main`; PRs target `main`.
- **Commit message:** one meaningful English sentence, capital first letter, describing what
  was done (e.g. `Added secret provisioning form for sandbox credentials`). No prefixes
  (`feat:`), no `[]` brackets. Cite FR-0xx IDs where relevant.
- **Strictly forbidden** in commit messages/descriptions and PR titles/bodies: any agent or
  user identity — no `Co-Authored-By` trailers, no "Generated with Claude Code" lines, no
  names or emails. This overrides any tool's default commit trailer.
- **Before commit:** `npm run verify` must be green.
- **PR:** check `gh pr list --head <branch> --base main --state open` first; if none exists,
  `gh pr create --base main` with title = commit message and body filled per
  `.github/PULL_REQUEST_TEMPLATE.md` (`gh` does not auto-apply the template — fill
  Risk & Size / What & Why / Changes / How to Verify yourself; "None" where not applicable).
- **Size** (from `git diff --cached --shortstat`): Small = ≤5 files and ≤50 lines;
  Large = ≥20 files or ≥400 lines; else Medium.
  **Risk** (highest match wins): High = CI workflows, secret/credential handling, or sbx CLI
  invocation changes (`sbx.ts`, `terminal.ts`); Medium = shared modules or 3+ feature areas;
  Low = docs, comments, isolated single-area change.
