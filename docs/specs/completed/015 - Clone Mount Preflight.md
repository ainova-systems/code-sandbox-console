# 015 — Clone Mount Preflight

> **Iteration spec — immutable history.** Describes what changed in this iteration and
> why. The current truth lives in [`../../Architecture.md`](../../Architecture.md) and
> [`../../Features.md`](../../Features.md); where this spec disagrees with them, they win.
>
> **Period:** 2026-08-07 · **Base:** `main` after spec 014
>
> **Status: shipped with this iteration.** A clone-mount sandbox on a shallow repository
> is refused before creation, with the fix named in the message; Features FR-058 and
> Architecture §4/§5/§9/§13/§14 carry the current truth.

## What & why

A sandbox with `mount: clone` (FR-009, Architecture §9) on a **shallow** host repository
is created successfully, starts, opens a terminal — and hands the agent an **empty
workspace**. Nothing in the extension says a word.

The mechanics, confirmed against sbx v0.31.3 by reproducing it on a probe sandbox: the
in-sandbox clone is performed by a script sbx runs on every start, whose relevant part is

```sh
if [ ! -d "$TARGET/.git" ]; then
  mkdir -p "$TARGET"; chown agent:agent "$TARGET"
  su -m -s /bin/sh agent -c 'git -c safe.directory="$SRC" clone --reference "$SRC" "$SRC" "$TARGET"'
fi
# … then: git daemon --base-path="$PARENT" "$TARGET"
```

`--reference` makes the clone borrow objects from the read-only host mount
(`/run/sandbox/source`) instead of copying them — and git refuses that when the reference
is shallow, because "shallow" is a property of the repository (`.git/shallow`), not of the
object store, and it cannot travel through `objects/info/alternates`:

```
fatal: reference repository '/run/sandbox/source' is shallow
```

The script has already created `$TARGET`, so the failed clone leaves an **empty directory**
that the agent is then dropped into. Three consequences, all of them silent from the user's
side:

1. The failure text goes to sbx's own stderr on start, i.e. into the agent terminal, where
   it scrolls past under the agent's banner. The extension neither sees nor reports it —
   `sbx create` itself exited 0.
2. The state does not self-heal. Once the agent session writes anything into that empty
   directory (Claude Code creating `.claude/` is enough), every later start fails the
   *other* way — `fatal: destination path … already exists and is not an empty directory` —
   and the original cause is gone from view.
3. `mount: direct` is unaffected: nothing is cloned, so a shallow repository is fine.

FR-040 already establishes the pattern this iteration follows: a workspace the mount cannot
support (UNC / `\\wsl$`) is rejected **before any sbx mutation**, with an actionable error.
A shallow repository under `mount: clone` is the same class of precondition — cheap to
check on the host, impossible to recover from afterwards without a recreate.

sbx guards the neighbouring precondition itself, which is what scopes this iteration: a
workspace that is not in a repository at all is refused up front, before anything is
created — verified on v0.31.3 —

```
ERROR: --clone requires a Git repository, but C:\…\nogit is not in a Git repository
```

so "no repository" needs nothing from the extension. Shallowness is the one precondition
sbx does not check. Note the wording: *not in a Git repository* — a workspace **inside** a
repository is accepted, so the extension's probe must resolve the containing repository the
same way (run git with `cwd` = the workspace and let it walk up), not test the folder for a
`.git` entry.

## What changed

- **New FR-058 (Clone Mount Preflight).** Creating a `mount: clone` sandbox on a shallow
  repository is refused before the first sbx call, with an error that names the cause, the
  fix (`git fetch --unshallow`, and what running it does to the working copy) and the
  alternative (`mount: direct`).
- **`src/git.ts` — a new module for read-only host git probes.** One export,
  `isShallowRepository(dir)`, running `git -C <dir> rev-parse --is-shallow-repository`
  through the `log.ts` spawn runner (quiet; the log keeps it when it fails, FR-055).
  `-C` rather than a spawn cwd so the probe resolves the *containing* repository, matching
  sbx's own "not **in** a Git repository" semantics. Dependency direction: `ops → git → log`;
  nothing else depends on it. Git gets its own module for the same reason sbx has one —
  argv for an external CLI lives in exactly one place.
- **The guard sits beside the existing UNC fail-fast in `ops.ts`.** `assertMountUsable`
  runs on every path that can *create* a sandbox (`createOrAttach`, `rebuildRef`,
  `shellRef`), gated on `ref.spec.mount === "clone"`; attaching to an existing sandbox does
  not run it. It shows its own modal and raises `ops.HandledError`; `extension.ts`,
  `tree.ts` and `form.ts` skip that sentinel in their error reporters (form's local
  `HandledError` now extends it, so one check covers both), so the dialog is not chased by
  a duplicate toast. `terminal.ts` gained `openHostCommandTerminal` for the hand-off.
- **Rebuild checks the workspace before it destroys anything.** Its workspace resolution,
  the UNC translation and the new preflight moved from just-before-recreate to the top of
  the operation — previously a workspace problem surfaced *after* `docker build` and
  `sbx rm`, i.e. after the old instance was already gone. A refusal now leaves the sandbox
  untouched.
- **The generated project CLI got the same guard (FR-052 parity).** `script.ts` renders the
  check into `.sandbox/scripts/sbx.sh`'s `create_instance`, so a script-driven create
  refuses the same case with the same fix instead of producing the same empty workspace.

## Decisions

- **Preflight only, no post-create verification.** A shallow reference is the one cause the
  extension can detect on the host, for free, before it mutates anything. A general "did the
  clone actually materialise" probe would mean an `sbx exec` into a freshly started sandbox
  on every clone-mode create, and would report the failure only after the sandbox exists.
  Deferred; recorded in Architecture §14 with the failure it would catch.
- **Refuse, don't fix — and say what the fix does.** The refusal is a **modal** dialog: it
  ends the action the user just asked for, and the explanation (truncated history; sbx's
  clone borrows objects from it; git refuses a shallow source) does not survive a
  notification's one-line clamp. It names `git fetch --unshallow` and what running it
  means — it downloads the missing history into this repository, which is why it is the
  user's call. **Open Terminal** opens a host terminal in the repository with the command
  *typed but not executed*; the extension never runs git itself, the same reason discovery
  never writes (spec 009), applied to git state. Showing the dialog inside `ops.ts` (and
  raising the shared `HandledError` the surfaces skip) keeps the palette, the Explorer and
  the form from each rendering their own version of it.
- **Fail open when the probe cannot run.** If `git` is absent from the host, or the folder
  is not in a repository, the create proceeds. A false refusal would be worse than the
  failure it prevents, and nothing is lost: sbx refuses a non-repository workspace itself,
  before creating anything (`--clone requires a Git repository, but <path> is not in a Git
  repository`). The extension's probe therefore covers exactly one case sbx does not —
  shallow — and when it cannot run, the outcome is today's behaviour, not a worse one.
- **Nothing is done for sandboxes already wedged this way.** An existing clone-mount sandbox
  whose workspace is empty stays broken: the fix is `git fetch --unshallow` on the host, then
  **Rebuild** (recreate). Detecting it would require the post-create probe above.
