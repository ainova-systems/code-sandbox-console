# 003 — Open-Source Readiness

> **Iteration spec — immutable history.** Describes what changed in this iteration and
> why. The current truth lives in [`../Architecture.md`](../Architecture.md) and
> [`../Features.md`](../Features.md); where this spec disagrees with them, they win.
>
> **Period:** 2026-06-09 … 2026-06-10 · **Base:** `c1ffec8` (working tree)

## What & why

Full pre-publication audit (multi-agent: correctness, security, OSS hygiene,
docs-vs-code consistency, git history, UX) followed by a fix pass and an adversarial
regression review of the fixes. Goal: publish the repository as open source in a state
a stranger can build, trust, and contribute to.

## Product change

- **Removed the implicit single-Claude default** — the `Create Claude Sandbox` command
  and `defaultSpec()` are gone. Every sandbox is defined explicitly via the New Sandbox
  form; `Connect` creates the primary sandbox when absent; `primaryRef()` returns
  `undefined` when nothing is defined. Rationale: v0.2 is multi-agent and form-driven;
  the implicit-Claude path was the source of a startup-nag blocker (popup before even
  checking the `sbx` CLI exists) and steered users toward duplicates.

## Key fixes (selection)

- **Startup UX:** nothing user-visible happens when `sbx` is missing; the no-recipe
  offer fires at most once per workspace; `sbx not found` errors carry an
  "Install instructions" action.
- **Security hardening:** argv allowlists for all config-derived CLI values (names,
  agents, image tags, secret services — option-injection closed); `docker build`
  dockerfile/context contained inside the repo; the one `bash -lc` slot validates its
  command name; workspace-trust declared unsupported (`untrustedWorkspaces`).
- **Form correctness:** malformed `config.yaml` blocks Save (never overwritten) and is
  reported with an "Open config" action everywhere (palette commands included); edit
  round-trips preserve unexposed fields (`context`, dockerfile/image pairs) and
  committed secret requirements; failed creates retry against the same recipe entry
  (no duplicate `<key>-2` entries); input survives tab switches.
- **Naming robustness:** name parts are sanitised to a guaranteed-valid sbx name
  (leading-alnum, `sandbox` fallback) so non-ASCII / dot-leading folder names work;
  validation runs *before* the recipe is persisted.
- **Terminal pooling:** reuse survives Extension Host reloads via adoption (launch-args
  for live terminals, exact tab title for revived ones); dying terminals are never
  adopted; closed terminals are evicted from the pools.
- **Lifecycle ordering:** Remove-from-config destroys the live instance first; shells
  re-check declared secrets and publish ports; UNC/`\\wsl$` workspaces are rejected
  before any sbx mutation.

## Packaging & repo hygiene

- Added: `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `THIRD_PARTY_NOTICES.txt`
  (bundled `yaml`, ISC), `.gitattributes`, GitHub Actions CI (tsc + build + package),
  PR template.
- `package.json`: `capabilities` (untrusted/virtual workspaces unsupported), seven
  `item.*` commands hidden from the palette, `esbuild ^0.25` (audit clean),
  `@types/vscode ~1.90` pinned to match `engines.vscode`.
- Docs restructured AI-first: `FRD.md` → `Features.md` (business truth),
  `ARCHITECTURE.md` → `Architecture.md` (technical truth, current-state only),
  history extracted into `docs/specs/00N - <Iteration>.md` (this convention).

## Verification snapshot (as of this iteration)

- Gates green: `tsc --noEmit`, `npm run build`, `vsce package` (8-file .vsix),
  `npm audit` 0 vulnerabilities.
- 3 review waves: 72 audit findings → fixed; 46 regression findings on the fixes →
  fixed (all unique blocker/major, most minor).
- Pending (user decisions): Marketplace icon, publisher creation (`ainova-systems`),
  git history identity (corporate email, pre-rebrand name visible), README screenshot,
  F5 runtime re-validation of the v0.2 flows.

## Known leftovers (accepted, minor)

- Carried (globally-satisfied) secret requirements are not rendered in the Edit form.
- `templateExists()` maps digest-only refs to `:latest`; IPv6-literal registry refs are
  rejected by the image-tag allowlist.
- `publishPort` failures are best-effort/silent by design.
- Opening the tree in a repo with a committed recipe writes `.sandbox/identity.yaml`
  (by design — identity is needed to derive names).
