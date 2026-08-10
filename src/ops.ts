import * as vscode from "vscode";
import * as git from "./git";
import * as images from "./images";
import * as log from "./log";
import * as names from "./names";
import * as sandbox from "./sandbox";
import * as sbx from "./sbx";
import * as secrets from "./secrets";
import {
  disposeSandboxTerminals,
  openAgentAttach,
  openShell,
} from "./terminal";

/**
 * Per-sandbox lifecycle operations shared by the palette commands (primary sandbox) and
 * the Sandbox Explorer (a selected node), so the two never drift. Confirmation prompts
 * live in the command layer; these just do the work.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * FR-056: raised when the user cancels a progress notification. `detail` names the state
 * the sandbox was left in, so a rebuild abandoned after its instance was removed says so
 * instead of implying nothing happened.
 */
class Cancelled extends Error {
  constructor(readonly detail?: string) {
    super("cancelled");
  }
}

/**
 * FR-054: at most one lifecycle operation per sandbox, keyed by sbx name and valued with
 * the operation's label. Different operations on one sandbox are mutually exclusive too —
 * a Stop landing in the middle of a Rebuild's recreate is the same race as a second
 * Rebuild.
 */
const inFlight = new Map<string, string>();

const busyChanged = new vscode.EventEmitter<void>();

/** Fires whenever a sandbox becomes busy or free, so the Explorer can re-render (FR-054). */
export const onDidChangeBusy = busyChanged.event;

/** The operation running for this sandbox, if any — the Explorer's busy label (FR-054). */
export function busyLabel(name: string): string | undefined {
  return inFlight.get(name);
}

/**
 * FR-054: run `fn` only if nothing else is already running for this sandbox; otherwise
 * report what is running and decline. Returns whether it ran, which the "Remove from
 * config" flow needs — it must not drop the recipe entry when its destroy was declined.
 *
 * Deliberately declines instead of awaiting the in-flight operation: attaching to it
 * would look like the second click worked and then produce one outcome for two requests.
 * The guard lives here, below every caller (palette, Explorer, form), so the entry points
 * cannot drift apart — which is how a doubled Rebuild started two pipelines against one
 * sandbox name.
 */
async function exclusive(
  name: string,
  operation: string,
  fn: () => Promise<void>
): Promise<boolean> {
  const running = inFlight.get(name);
  if (running) {
    void vscode.window
      .showWarningMessage(
        // No promise of a Cancel button: Stop, Delete and a Rebuild's removal stage are
        // deliberately non-cancellable (FR-056), so their notification has none.
        `${running} is already running for ${name} — wait for it to finish.`,
        "Show Log"
      )
      .then((choice) => {
        if (choice === "Show Log") {
          log.show();
        }
      });
    return false;
  }
  inFlight.set(name, operation);
  busyChanged.fire();
  try {
    await fn();
    return true;
  } catch (err) {
    if (err instanceof Cancelled) {
      void vscode.window.showInformationMessage(
        `${operation} cancelled for ${name}.${err.detail ? ` ${err.detail}` : ""}`
      );
      return false;
    }
    throw err;
  } finally {
    inFlight.delete(name);
    busyChanged.fire();
  }
}

/** Keep the notification message to one readable line of child output (FR-055). */
function trimForNotification(line: string): string {
  const clean = line.replace(/\s+/g, " ").trim();
  return clean.length > 120 ? `${clean.slice(0, 119)}…` : clean;
}

/**
 * Run a slow `sbx` operation behind a notification spinner so clicking any lifecycle
 * action gives instant "something is happening" feedback. The task receives an operation
 * context: its `onLine` streams the child's latest output line into the notification
 * message (FR-055), and its `token` — present only for `cancellable` operations — kills
 * the running child (FR-056). Interactive prompts (secret entry) are deliberately kept
 * OUTSIDE these — a spinner must never fight a modal input box.
 */
async function withProgress<T>(
  title: string,
  task: (ctx: log.OpContext) => Promise<T>,
  opts?: { cancellable?: boolean; busyFor?: string; cancelNote?: string }
): Promise<T> {
  const cancellable = opts?.cancellable ?? false;
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable,
    },
    async (progress, token) => {
      let cancelling = false;
      const ctx: log.OpContext = {
        token: cancellable ? token : undefined,
        onLine: (line) =>
          progress.report({
            // Once cancelling, the streamed lines are the command winding down (an sbx
            // child is not killed — see sbx.run), so keep saying so rather than looking
            // like the cancel was ignored.
            message: cancelling
              ? `Cancelling — ${trimForNotification(line)}`
              : trimForNotification(line),
          }),
      };
      const cancelNote = ctx.token?.onCancellationRequested(() => {
        cancelling = true;
        progress.report({ message: opts?.cancelNote ?? "Cancelling…" });
        // Relabel the Explorer node too. An sbx child runs to completion after the click
        // (see sbx.run), and a `--clone` create can take minutes to get there — a node
        // still reading "connect…" through that reads as a hang, and contradicts the
        // notification standing right next to it.
        if (opts?.busyFor && inFlight.has(opts.busyFor)) {
          inFlight.set(opts.busyFor, "Cancelling");
          busyChanged.fire();
        }
      });
      let result: T;
      try {
        result = await task(ctx);
      } catch (err) {
        // A killed child exits non-zero with whatever message it managed to print, so
        // the token — not the error text — is the truth about what happened.
        if (ctx.token?.isCancellationRequested) {
          throw new Cancelled();
        }
        throw err;
      } finally {
        cancelNote?.dispose();
      }
      // The normal path for a cancelled sbx call, which is allowed to run to completion
      // (sbx.run) and therefore succeeds: the token, not the outcome, decides. Also
      // catches a docker child that finished between the click and the kill, and a
      // best-effort step that reports failure by returning (images.refreshForRebuild).
      // Without this, "Cancel" during a rebuild's build stage would go on to destroy and
      // recreate the sandbox.
      if (ctx.token?.isCancellationRequested) {
        throw new Cancelled();
      }
      return result;
    }
  );
}

/**
 * FR-056: undo a create the user cancelled. `sbx create` is allowed to finish first
 * (`sbx.run` never kills it), so by the time this runs the sandbox exists and sbx knows
 * about every resource it made — which is exactly what makes `sbx rm --force` able to
 * clean it up completely. Cancel therefore returns to `absent`, the state the create
 * started from.
 *
 * Still polls rather than removing once: the create may have failed on its own, and a
 * sandbox that is mid-registration would otherwise be missed. Returns the sentence
 * describing what happened, for the cancellation message.
 */
async function rollbackCreate(
  ref: sandbox.SandboxRef
): Promise<string | undefined> {
  return withProgress(`Cancelling — removing ${ref.name}…`, async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      let state: sbx.SandboxState = "absent";
      try {
        state = await sandbox.state(ref);
      } catch {
        // transient CLI error — try again
      }
      if (state !== "absent") {
        try {
          await sandbox.destroy(ref);
          return "The created sandbox was removed.";
        } catch {
          return `The sandbox may still exist — check the Sandboxes view, or remove ${ref.name} by hand.`;
        }
      }
      await sleep(700);
    }
    return undefined; // the create never got as far as registering a sandbox
  });
}

/**
 * FR-058: the precondition `mount: clone` puts on the workspace, checked before the first
 * sbx call — like the UNC translation above, and for the same reason: what it prevents
 * cannot be repaired afterwards.
 *
 * sbx builds the sandbox's copy with `git clone --reference <read-only host mount>`, which
 * git refuses when the source is shallow. The create still succeeds, so nothing here would
 * notice: the failure happens inside the sandbox at start-up, scrolls past in the agent
 * terminal, and leaves the agent in an empty workspace directory. Worse, it does not
 * self-heal — once the agent writes anything into that directory, every later start fails
 * on "already exists and is not an empty directory" instead, and the real cause is gone.
 *
 * Refuse, don't fix (spec 015): `git fetch --unshallow` changes what the user's working
 * copy contains, so it is named, explained, and left to them. `mount: direct` is untouched
 * — it clones nothing.
 */
async function assertMountUsable(
  ref: sandbox.SandboxRef,
  workspace: string
): Promise<void> {
  if (ref.spec.mount !== "clone") {
    return;
  }
  if (!(await git.isShallowRepository(workspace))) {
    return;
  }
  throw new Error(
    `${ref.name} uses mount: clone, but this repository is shallow — its history was ` +
      "truncated by a `--depth` clone or fetch. Docker Sandboxes copies the repo into " +
      "the sandbox with `git clone --reference`, and git refuses a shallow source, so " +
      "the sandbox would start with an empty workspace. Run `git fetch --unshallow` in " +
      "the repository — it downloads the missing history into your working copy, which " +
      "is why it is left to you — then try again. Or set this sandbox to mount: direct, " +
      "which needs no clone."
  );
}

/**
 * Create the sandbox (non-attaching) behind a progress spinner. Cancellable, with the
 * caveat that matters: the CLI is not killed (see `sbx.run`), so cancelling waits for the
 * create to finish and then removes it. The end state is what the user asked for — no
 * sandbox — but a cancel can take as long as the create it is undoing.
 */
async function createSandbox(
  ref: sandbox.SandboxRef,
  workspace: string
): Promise<void> {
  try {
    await withProgress(
      `Creating sandbox ${ref.name}…`,
      (ctx) => sandbox.create(ref, workspace, ctx),
      {
        cancellable: true,
        busyFor: ref.name,
        // Say why this one does not stop at once: the create is left to finish (sbx.run)
        // and a `--clone` create can spend minutes cloning before it gets there.
        cancelNote: "Cancelling — letting the create finish so it can be removed cleanly…",
      }
    );
  } catch (err) {
    if (err instanceof sbx.NameClaimedError) {
      // FR-057: the name is claimed by leaked runtime state and will fail forever. Record
      // it here — where the failure is observed — so the next new sandbox cannot be handed
      // the same name (the extension has no other way to learn this; see names.ts).
      await names.remember(ref.name);
    }
    throw err instanceof Cancelled ? new Cancelled(await rollbackCreate(ref)) : err;
  }
}

/**
 * Publish the spec's ports once the sandbox is actually running (`sbx ports` needs a live
 * sandbox, and `sbx run` starts it asynchronously in a terminal). Best-effort: polls state
 * for ~30s, then publishes each port, ignoring "already bound" races. Call with `void`.
 */
export async function publishPortsWhenReady(
  name: string,
  ports: number[]
): Promise<void> {
  if (ports.length === 0) {
    return;
  }
  for (let i = 0; i < 30; i++) {
    let running = false;
    try {
      running = (await sbx.stateOf(name)) === "running";
    } catch {
      // ignore transient CLI errors
    }
    if (running) {
      for (const port of ports) {
        try {
          await sbx.publishPort(name, port);
        } catch {
          // already bound / still racing — best-effort
        }
      }
      return;
    }
    await sleep(1000);
  }
}

/**
 * Build/load a ref's custom image with progress (no-op unless it has image + dockerfile).
 * The longest operation in the product — `docker build --pull` re-fetches the agent base
 * on every rebuild (FR-053) — so it streams its output into the notification and is
 * cancellable (FR-055/FR-056).
 */
export async function ensureImageForRef(
  ref: sandbox.SandboxRef,
  repoRoot: string,
  rebuild = false
): Promise<void> {
  if (!ref.spec.image || !ref.spec.dockerfile) {
    return;
  }
  await withProgress(
    `${rebuild ? "Rebuilding" : "Building"} image ${ref.spec.image}…`,
    (ctx) => images.ensureImage(ref.spec, repoRoot, { rebuild, ctx }),
    { cancellable: true, busyFor: ref.name }
  );
}

/**
 * Create-or-attach a specific sandbox (FR-003/005). An absent sandbox is always created
 * non-attaching (`sbx create` behind the progress spinner) and then attached by name:
 * the one-shot create-form `sbx run <agent> <workspace> --name <name>` matches an
 * existing sandbox by agent+workspace and ignores `--name` (sbx v0.31.3), so any other
 * sandbox on the same workspace — e.g. an orphan from a regenerated `.sandbox` identity —
 * made it exit 1 with the error text lost in the closing terminal. `sbx create` honours
 * `--name`, and its stderr surfaces as a real error message. Creating first also lets
 * per-sandbox secrets apply before the agent starts (FR-032). Attaching to an existing
 * sandbox re-prompts for any still-missing secrets. Configured ports are published once
 * the sandbox comes up.
 */
export async function createOrAttach(
  root: vscode.Uri,
  ref: sandbox.SandboxRef
): Promise<void> {
  await exclusive(ref.name, "Connect", async () => {
    if ((await sandbox.state(ref)) === "absent") {
      const workspace = sandbox.workspacePath();
      if (!workspace) {
        throw new Error("No workspace open.");
      }
      sbx.hostToSandboxPath(workspace); // fail fast on UNC/WSL paths, before any sbx mutation
      await assertMountUsable(ref, workspace); // FR-058: clone mount needs full history
      await ensureImageForRef(ref, root.fsPath);
      await createSandbox(ref, workspace);
      if (ref.spec.secrets.length > 0) {
        await secrets.ensureSecrets(ref); // exists before per-sandbox secret set
      }
      openAgentAttach(ref);
    } else {
      if (ref.spec.secrets.length > 0) {
        // Re-check declared secrets on every attach (FR-032): a cancelled prompt or a
        // secret deleted via the CLI would otherwise stay missing forever. Prompts only
        // for missing ones — a cheap no-op when everything is provisioned.
        await secrets.ensureSecrets(ref);
      }
      openAgentAttach(ref);
    }
    void publishPortsWhenReady(ref.name, ref.spec.ports);
  });
}

/** FR-006: stop a sandbox (with progress; closes its terminals first to avoid exit popups). */
export async function stopRef(ref: sandbox.SandboxRef): Promise<void> {
  await exclusive(ref.name, "Stop", async () => {
    // Terminal disposal can take up to ~4s — keep it inside the spinner so the box appears
    // the instant the action is clicked, not only once the CLI call starts. Not
    // cancellable (FR-056): interrupting `sbx stop` is strictly worse than waiting.
    await withProgress(`Stopping ${ref.name}…`, async () => {
      await disposeSandboxTerminals(ref.name);
      await sandbox.stop(ref);
    });
  });
}

/**
 * Destroy a sandbox instance (state gone; recipe kept). Closes its terminals first.
 * Returns whether it ran: "Remove from config" destroys the instance before dropping the
 * recipe entry, and must not drop it when the destroy was declined (FR-054) — otherwise
 * the microVM is orphaned, reachable only via raw `sbx ls`/`rm`.
 */
export function destroyRef(ref: sandbox.SandboxRef): Promise<boolean> {
  return exclusive(ref.name, "Delete", async () => {
    await withProgress(`Removing sandbox ${ref.name}…`, async () => {
      await disposeSandboxTerminals(ref.name);
      await sandbox.destroy(ref);
    });
  });
}

/**
 * FR-007 Rebuild: refresh the image (FR-053), rebuild the custom image (if any), then
 * recreate the sandbox. A rebuild always starts from the freshest obtainable image;
 * when the refresh cannot happen (offline, local-only image) it warns and proceeds
 * from the cache instead of failing.
 *
 * FR-056: cancelling any stage abandons the whole rebuild — the `Cancelled` thrown by
 * `withProgress` propagates rather than falling through to the next stage. The stage
 * reached decides what the user is told about the state left behind, since the removal
 * in the middle is not undoable.
 */
export async function rebuildRef(
  root: vscode.Uri,
  ref: sandbox.SandboxRef
): Promise<void> {
  await exclusive(ref.name, "Rebuild", async () => {
    // What cancelling from the current stage leaves behind; undefined = nothing touched.
    let leftBehind: string | undefined;
    try {
      // Both workspace checks run before the first destructive step, not next to the
      // recreate they guard: a rebuild refused here leaves the existing sandbox alone,
      // where the same refusal after the removal stage would leave the user with nothing.
      const workspace = sandbox.workspacePath();
      if (!workspace) {
        throw new Error("No workspace open.");
      }
      sbx.hostToSandboxPath(workspace); // fail fast on UNC/WSL paths, before any sbx mutation
      await assertMountUsable(ref, workspace); // FR-058: clone mount needs full history
      if (ref.spec.image && ref.spec.dockerfile) {
        await ensureImageForRef(ref, root.fsPath, true); // docker build --pull (FR-053)
      }
      // Recreate behind one spinner: terminal close (up to ~4s) + `sbx rm` when an
      // instance exists. Wrap the whole block — including the absent path, where only
      // leftover or reload-restored terminals need closing — so Rebuild never
      // reintroduces a silent gap. Not cancellable: a half-interrupted `sbx rm` is worse
      // than waiting the few seconds it takes.
      await withProgress(`Removing sandbox ${ref.name}…`, async () => {
        await disposeSandboxTerminals(ref.name);
        if ((await sandbox.state(ref)) !== "absent") {
          await sandbox.destroy(ref);
        }
      });
      leftBehind = "The previous instance is already gone — Connect recreates it.";
      // FR-053: refresh AFTER the instance is gone (a template still referenced by a live
      // instance could refuse removal) and before the create that consumes it.
      if (!ref.spec.dockerfile) {
        const fresh = await withProgress(
          `Refreshing image for ${ref.name}…`,
          (ctx) => images.refreshForRebuild(ref.spec, ctx),
          { cancellable: true, busyFor: ref.name }
        );
        if (!fresh) {
          void vscode.window.showWarningMessage(
            `Could not refresh the image for ${ref.name} — rebuilding from the cached image.`
          );
        }
      }
      leftBehind = "Connect recreates the sandbox.";
      // Same create-then-attach as createOrAttach: `sbx create` honours --name where the
      // one-shot run create-form does not (see createOrAttach).
      await createSandbox(ref, workspace);
      leftBehind = undefined;
      if (ref.spec.secrets.length > 0) {
        await secrets.ensureSecrets(ref);
      }
      openAgentAttach(ref);
      void publishPortsWhenReady(ref.name, ref.spec.ports);
    } catch (err) {
      // Re-raise with the state note; `exclusive` renders it as one message. A detail the
      // stage already set (the create rollback) is more specific — keep it.
      throw err instanceof Cancelled
        ? new Cancelled(err.detail ?? leftBehind)
        : err;
    }
  });
}

/**
 * Open a shell in a specific sandbox at the workspace. Creates it first if absent,
 * mirroring createOrAttach: declared secrets are provisioned (FR-032) and configured
 * ports are published once the sandbox comes up.
 */
export async function shellRef(
  root: vscode.Uri,
  ref: sandbox.SandboxRef
): Promise<void> {
  await exclusive(ref.name, "Shell", async () => {
    const workspace = sandbox.workspacePath();
    if (!workspace) {
      throw new Error("No workspace open.");
    }
    // Translate before any sbx mutation: throws a friendly error for UNC/WSL paths.
    const workspaceInside = sbx.hostToSandboxPath(workspace);
    if ((await sandbox.state(ref)) === "absent") {
      await assertMountUsable(ref, workspace); // FR-058: clone mount needs full history
      await ensureImageForRef(ref, root.fsPath);
      await createSandbox(ref, workspace);
    }
    if (ref.spec.secrets.length > 0) {
      // Same FR-032 re-check as createOrAttach: prompts only for missing secrets.
      await secrets.ensureSecrets(ref);
    }
    openShell(ref, workspaceInside);
    void publishPortsWhenReady(ref.name, ref.spec.ports);
  });
}
