# Changelog

All notable changes to this extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-06-09 (pre-release)

From proof of concept to a managed Sandbox UI, plus the rebrand to **Sandbox Console**.

### Added

- **Sandbox Explorer** view: a tree of the repo's sandboxes with live status and
  per-node actions (Connect, Stop, Shell, Rebuild, Edit, Delete instance, Remove
  from config), with optional groups.
- **New / Edit Sandbox** webview form — agent, optional title and group, secrets,
  ports, and environment; no YAML by hand.
- Committed `.sandbox/config.yaml` recipe holding the shared project `name` and
  sandbox definitions (FR-009).
- Custom environments per sandbox: the agent's default image, a custom Dockerfile
  (built via `docker build` → `sbx template load`, FR-008), or a registry image
  pulled as-is.
- Credential provisioning on request via `sbx secret set` with the value piped
  over stdin (FR-032) — never in the repo, image, or a plaintext env var; for
  `github` it also runs `gh auth login --with-token` inside the sandbox.
- Multi-agent, multi-sandbox support per repo (Claude Code, Codex, Gemini,
  OpenCode, plain shell) with a service registry for credentials.
- Status bar shows the active sandbox by its display name; clicking it (or
  `Sandbox: Switch Sandbox`) opens a picker over all recipe sandboxes, with an
  optional committed `default: true` recipe flag (FR-050).
- MIT license.

### Changed

- Rebranded from the *Ainoflow Sandbox Terminal* POC to **Sandbox Console**
  (publisher `Ainova Systems`); commands now live under `sandboxConsole.*`.
- `.sandbox/identity.yaml` simplified to a short random `{id}`; the sbx sandbox
  name is `<name>-<key>-<id>`, keeping clones/copies/worktrees conflict-free.

### Removed

- The `Create Claude Sandbox` command and the implicit single-Claude default:
  sandboxes are now always defined explicitly (New Sandbox form → committed
  recipe); Connect creates the primary sandbox when it does not exist yet.

## [0.1.0] - 2026-06-09

Initial proof of concept (internal, not published to the Marketplace).

### Added

- Terminal-first commands over the `sbx` CLI: Create Claude Sandbox, Attach,
  Stop, Open Shell — no container management by hand.
- `sbx` CLI wrapper: binary resolution off-PATH (Windows), lifecycle via
  `sbx run` / `sbx stop` / `sbx rm`, discovery via `sbx ls --json`, and host →
  sandbox workspace path translation.
- Startup discovery of existing sandboxes with Attach as the default action.
- Per-repo sandbox identity in a single gitignored file (the `.sandbox/` folder
  layout arrived in 0.2.0).
