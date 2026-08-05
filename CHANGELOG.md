# Changelog

All notable changes to this extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-08-05

Sandboxes are now named after what they are, the views follow the config file instead of a
snapshot of it, and a sandbox name that the Docker Sandboxes runtime refuses to release is
never handed out again.

### Added

- **Sandboxes are named after their title.** A new sandbox takes its name from the title
  you type — *Backend API (v2)* becomes `backend-api-v2` — instead of a counter on the
  agent name (`claude`, `claude-2`, …). An empty title still falls back to the agent name.
  The name is fixed at creation: renaming the title afterwards is safe, as before, and
  never touches the sandbox, its Dockerfile, or its image.
- **The views follow `.sandbox/config.yaml`.** Editing the file — by hand, from another
  window, or through a `git pull` — refreshes the Sandboxes view and the status bar right
  away. Renaming a sandbox and connecting immediately now uses the new name instead of
  quietly acting on the old one.

### Changed

- **A name the runtime will not release is remembered and skipped.** When creating a
  sandbox fails because its name is still held inside the Docker Sandboxes runtime — a
  known upstream issue with no released fix — that name is recorded for this working copy,
  and no new sandbox is given it again. Previously a name freed by a rename or a removal
  was handed straight to the next sandbox, walking back into the same failure. The record
  stays on your machine, holds names only, and is cleared by `sbx reset`.
- **A new sandbox gets its own Dockerfile by default.** Because the default Dockerfile name
  follows the sandbox name, two sandboxes on the same agent no longer share one generated
  `claude.Dockerfile` by accident. Sharing is still available — type the same file name in
  both — and is now something you choose rather than something that happens.
- The extension is no longer marked as a preview.

## [0.3.0] - 2026-07-29

Long operations — image builds, sandbox creation — used to run behind a notification that
never changed a word, sometimes for minutes. This release makes them visible, stoppable,
and impossible to start twice by accident.

### Added

- **Operation log.** A `Sandbox Console` output panel shows every command the extension
  runs, streamed line by line as it happens, with its exit code and how long it took.
  Open it from `Sandbox: Show Log`, from the Sandboxes view menu, or from the button that
  now appears on error notifications. Credential values never appear in it.
- **Live progress.** The notification for a build or a create reports what the command is
  doing right now — the current build step, and the slow, quiet stages that move an image
  into the sandbox runtime — instead of standing still.
- **Cancel.** Long operations can be stopped from their notification. An image build stops
  immediately. Cancelling a sandbox creation waits for it to finish and then removes the
  sandbox, so it can take as long as the creation itself. That wait is deliberate:
  interrupting the sandbox tool partway can leave a sandbox name permanently unusable.

### Changed

- **One operation per sandbox at a time.** Acting on a sandbox that is already busy now
  tells you what is running instead of starting a second operation beside it. Different
  sandboxes still run in parallel.
- **A busy sandbox looks busy.** Its item in the Sandboxes view shows a spinner and the
  running operation, and its actions are hidden until it finishes.
- **The New/Edit form shows that it is working.** Save disables itself and the rest of the
  form for the duration, and is handed back if the save fails.
- **A clearer error when a sandbox name is stuck.** If creation fails because the name is
  still held inside the sandbox runtime — a known Docker Sandboxes issue with no released
  fix — the message now explains what happened and how to get past it, instead of showing
  a raw daemon error.

### Fixed

- **Rebuild could run twice at once.** Starting it from both the command palette and the
  Sandboxes view, or clicking again during a long build, started two builds against the
  same sandbox, which then raced each other over the same image and instance.
- **Background checks no longer fail silently.** A failed sandbox or template listing used
  to degrade quietly to "nothing found"; it is now recorded in the operation log.

## [0.2.0] - 2026-07-28

First public release. Run AI coding agents in isolated, persistent Docker Sandboxes and
manage them from a view in the Explorer instead of the command line.

### Added

- **Sandboxes view** in the Explorer: a tree of the current repo's sandboxes with live
  status and per-item actions — Connect, Stop, Shell, Rebuild, Edit, Delete instance,
  Remove from config — with optional grouping.
- **New / Edit Sandbox form**: pick the agent, an optional title and group, credentials,
  ports, and environment without writing YAML by hand. The title is a pure display
  label, so renaming a sandbox never touches the running instance or its image.
- **Shared project setup**: sandbox definitions live in a committed
  `.sandbox/config.yaml`, so everyone who clones the repo gets the same sandboxes. A
  small local file (gitignored) keeps each working copy's instances separate, so clones,
  copies, and worktrees never collide.
- **Custom environments per sandbox**: the agent's default image, a Dockerfile in the
  repo (built and loaded as a sandbox template), or a registry image used as-is. A
  generated Dockerfile starts from the selected agent's own base image, and its filename
  is editable so several sandboxes can share one committed file.
- **Credentials on request**: missing credentials are asked for at the moment they are
  needed and handed to the sandbox over a pipe — never stored in the repo, the image, or
  a plaintext environment variable. For GitHub, the token is also used to sign in the
  `gh` CLI inside the sandbox.
- **Reusable credential cache**: enter a token once for a project and pick it from a list
  for every later sandbox or runner. Values are encrypted for the current Windows user
  and stored outside the repo (names are shown, values never are), with a
  `Sandbox: Manage Cached Secrets` command to rename or delete entries.
- **Companion shell script** generated into `.sandbox/scripts/sbx.sh`, which exposes the
  same sandbox model to terminals, scripts, and AI skills: lifecycle, rebuilds, headless
  task dispatch, throwaway clone-mode runners with guarded removal, and the cached GitHub
  token chain. It is refreshed on extension upgrades, never silently overwrites your
  edits, and is never executed by the extension itself.
- **Multiple agents and sandboxes per repo**: Claude Code, Codex, Copilot, Cursor,
  Gemini, OpenCode, Droid, Kiro, a plain shell, and anything else the local `sbx`
  install reports (the list is discovered live).
- **Status bar entry** showing the active sandbox; clicking it (or
  `Sandbox: Switch Sandbox`) opens a picker over every sandbox in the project, and a
  committed flag can mark one of them as the default.

### Changed

- **Rebuild always starts from a fresh image.** Rebuilding a sandbox re-fetches the
  freshest obtainable image for its environment: Dockerfile builds pull the base image,
  registry images are re-pulled and reloaded, and cached default agent images are
  dropped so the recreate pulls the current one. Offline, or with a local-only image,
  the rebuild warns and continues from the cached image instead of failing.
- **Every slow action now reports progress.** Creating, stopping, deleting, and
  recreating a sandbox show a notification for the whole operation, so a click is never
  answered by several seconds of silence. Interactive prompts still come after the
  progress box, never underneath it.
- **Opening a workspace is quiet and read-only.** Startup raises no notifications and no
  longer writes anything into the repo: the sandboxes are listed as *not created* until
  you actually create one. Discovery only feeds the status bar and the Sandboxes view,
  where Connect is one click away. Read-only checkouts list normally instead of falling
  back to an empty view.
- **Sandboxes are always defined explicitly.** There is no implicit default sandbox: you
  create one from the New Sandbox form, which writes it to the project's config; Connect
  then creates the instance if it does not exist yet.

### Fixed

- **Connect and Rebuild no longer fail when another sandbox exists for the same
  workspace** (for example one left behind by a re-cloned or re-initialised project).
  Creation now runs as a separate step with a progress notification, so a failure shows
  its actual error message instead of a terminal closing with exit code 1.

## 0.1.0 - 2026-06-09 — internal proof of concept (never published)

Terminal-first commands over the `sbx` CLI (create, attach, stop, shell) with startup
discovery of existing sandboxes and per-repo sandbox identity in a single local file.
Superseded by 0.2.0 and listed here only for history.

[0.4.0]: https://github.com/ainova-systems/code-sandbox-console/releases/tag/v0.4.0
[0.3.0]: https://github.com/ainova-systems/code-sandbox-console/releases/tag/v0.3.0
[0.2.0]: https://github.com/ainova-systems/code-sandbox-console/releases/tag/v0.2.0
