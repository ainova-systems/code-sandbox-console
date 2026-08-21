# 019 — Cursor Auth And Sandbox Logs

> **Iteration spec — immutable history.** Describes what changed in this iteration and
> why. The current truth lives in [`../../Architecture.md`](../../Architecture.md) and
> [`../../Features.md`](../../Features.md); where this spec disagrees with them, they win.
>
> **Period:** 2026-08-21 · **Base:** `main` after spec 018
>
> **Status: shipped with this iteration.** Cursor sandboxes no longer offer a Cursor API
> key (FR-032); **Open Logs** extracts host + in-sandbox logs to a temp file (FR-061).
> Features FR-032/FR-061/§11 and Architecture §4, §5, §8, §12, §14 carry the current truth.

## What & why

Two Cursor-sandbox problems showed up in the same session and share a diagnosis surface.

**A Cursor API key on a Cursor sandbox does not authenticate.** Docker's own docs offer
two Cursor auth methods — `sbx secret set cursor` (API key) or interactive OAuth — and
when both resolve, the stored secret takes precedence. In practice the API-key path is
broken inside the sandbox: `cursor-agent` still opens the browser login, the redirect
returns to `Press any key to log in…`, and repeating the loop never completes. The same
sandbox signs in on the first attempt when no Cursor secret is set. This is upstream
([docker/sbx-releases#112](https://github.com/docker/sbx-releases/issues/112)): a valid
`CURSOR_API_KEY` is rejected inside the sandbox even though the same key works on the
host and via `curl` from the VM. The form currently lists `cursor` as a custom
credential for every agent, so picking Cursor + Cursor API key is the obvious, wrong,
choice. GitHub and other secrets on a Cursor sandbox are fine.

**When the agent later exits, the VM auto-stops and the error is gone.** sbx stops a
sandbox after the last session disconnects (`auto-stop grace period expired` in
`daemon.log`). The terminal that held the exit text is disposed with it. `Sandbox: Show
Log` (FR-055) is the host operation log — `sbx`/`docker` the *extension* ran — not the
agent's own output or the daemon's per-sandbox lines. There is no `sbx logs`. The
actionable traces that survive a stop live on the host (`sandboxd/daemon.log`, keyed by
`runtime`/`vm_id`) and, while the VM is still up, in a handful of in-sandbox files
(`/tmp/sandbox-console-hooks.log`, `/var/log/sbx-kit-startup.log`, …).

## What changed

- **Cursor sandboxes cannot select a Cursor API key (FR-032).** The New/Edit form hides
  the `cursor` checkbox when the agent is `cursor`, explains that sign-in happens in the
  terminal, and Save drops `cursor` from that sandbox's recipe even if an older entry
  still listed it. Provisioning (Connect/Shell) never asks for it on a Cursor sandbox.
  A global or already-set `cursor` secret still injected by sbx is warned about, not
  unset — unsetting a host-global credential is the user's call. Other agents still
  see the Cursor checkbox; other secrets on a Cursor sandbox are unchanged.
- **Open Logs (FR-061).** A per-sandbox **Open Logs** action (Explorer context menu on
  running and stopped instances, palette command for the active sandbox) writes a
  snapshot to a temp file and opens it. The snapshot is the host `daemon.log` tail
  mentioning that sandbox (health/list noise dropped) plus, **only if the sandbox is
  already running**, the known in-sandbox log files via `sbx exec`. A stopped sandbox
  is never started just to read logs. Distinct from FR-055's operation channel.

## Decisions

- **Hide, don't document around it.** The API-key path is what Docker documents; it is
  also what fails. The form must not offer a combination that produces the login loop.
- **Do not unset a global Cursor secret.** It may be there for a non-Cursor sandbox on
  the same machine. Warn, and leave the keychain alone.
- **Do not start a stopped sandbox to collect logs.** `sbx exec` auto-starts, which
  would replay hooks (FR-060) as a side effect of a diagnostic click. Host `daemon.log`
  is what remains after auto-stop, which is the case that needs this action.
- **Temp file, not the operation channel.** The extract can be large and is meant to be
  re-read; a `*.txt` in the OS temp directory opened in the editor is the artefact.
  FR-055 stays the live stream of *this extension's* CLI calls.
