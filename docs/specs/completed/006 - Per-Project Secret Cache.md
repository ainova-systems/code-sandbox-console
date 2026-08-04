# 006 — Per-Project Secret Cache (FR-051)

> **Iteration spec — immutable history.** Describes what changed in this iteration and
> why. The current truth lives in [`../../Architecture.md`](../../Architecture.md) and
> [`../../Features.md`](../../Features.md); where this spec disagrees with them, they win.
>
> **Period:** 2026-06-10 · **Base:** `main` after spec 005
>
> **Status: shipped with this iteration** (`blobs.ts` store, picker UX in
> `secrets.ts`, the `Manage Cached Secrets` command). The shell-side consumer is the
> generated per-project CLI of spec 007, which fixed the storage decision below.
> Features.md (FR-051) and Architecture.md §8 carry the current truth.

## What & why

sbx secrets have exactly two scopes, and neither fits the common case:

- **Global** (`sbx secret set -g <service>`, OS keychain) is visible to every sandbox
  of every project on the machine — too broad for fine-grained PATs that are minted
  per repository/project.
- **Per-instance** (`sbx secret set <sandbox> <service>`) means re-entering the same
  value for every new sandbox: temporary sandboxes, runners, clones, rebuilds.

Scoping by renaming is impossible: the sbx proxy matches secrets by **service id**
(`github`), so a custom-named global secret never binds to GitHub traffic. The missing
middle is a **per-project cache** of secret values that the extension (and, critically,
shells/automation *outside* VS Code) can draw from when provisioning instances.

That last constraint shapes the design: a VS Code-private store cannot be the only
home for the value, because scripts that spawn runners from a plain shell must be able
to read the same cache.

## What changed

- **Per-project secret cache.** Values cached under `<project>/<service>`, where the
  project is `name:` from `.sandbox/config.yaml` — no new recipe fields. The cache is
  machine-local and OS-protected at rest; nothing about it enters the repo.
- **Pick-or-enter UX.** When a sandbox needs a secret, a QuickPick offers the existing
  cached entries for that service (current project's entry first, then other named
  entries) plus *Enter new value…*. A new value can be saved under a name (default:
  the project) or used once without saving. Values are never displayed — pickers and
  management lists show names only. With an empty cache the picker is skipped and the
  flow is today's input box plus the save option.
- **Management command.** List / delete / rename cached entries (names only).
- **Provisioning unchanged downstream.** The chosen value is piped over stdin to
  `sbx secret set <sandbox> <service>` (and `gh auth login --with-token` inside the
  sandbox for `github`), exactly as today. FR-032 invariants hold: the value never
  appears in argv, env vars, the repo, or an image.
- **Shell path.** The same cache is consumable from scripts outside VS Code — first
  consumer: the generated project CLI `.sandbox/scripts/sbx.sh` (spec 007),
  whose `secret-github`/`runner-create` subcommands resolve project blob → shared
  blob → env var. The env-var fallback (`GITHUB_SANDBOX_PAT`) stays reserved for
  CI/cloud environments that inject secrets from a platform store.

## Decisions

- **Storage: per-OS encrypted blobs under `~/.sbx/`**, not VS Code `SecretStorage`.
  The cache's second consumer is a plain bash script, and `SecretStorage` is
  unreachable from a shell. Blob naming `<entry>.<service>.dpapi` (Windows: DPAPI via
  a PowerShell call — decryptable only by the same OS user on the same machine);
  macOS (`security`/Keychain) and Linux (libsecret) get equivalent backends when those
  platforms are exercised. The extension reads/writes the same blobs, so the UI picker
  and the shell resolve **one** store. No standalone helper script — the resolve chain
  is inlined in each consumer (extension code and the generated CLI).
- Selection is always explicit — pick an entry or enter a value; the extension never
  silently reuses a cached secret without the user seeing which entry was chosen.
- The global level is not duplicated: `sbx secret set -g` remains the way to share a
  secret across all projects; the cache covers the per-project middle only.
- Cache entries are user-named, so one service can hold several values (e.g. two
  GitHub PATs with different scopes) and a project can borrow another entry by name.
