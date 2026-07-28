import * as vscode from "vscode";
import * as images from "./images";
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
 * Run a slow `sbx` operation behind a notification spinner so clicking any lifecycle
 * action gives instant "something is happening" feedback (the same box Rebuild already
 * shows). Interactive prompts (secret entry) are deliberately kept OUTSIDE these — a
 * spinner must never fight a modal input box.
 */
async function withProgress<T>(
  title: string,
  task: () => Promise<T>
): Promise<T> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false,
    },
    task
  );
}

/** Create the sandbox (non-attaching) behind a progress spinner. */
function createSandbox(
  ref: sandbox.SandboxRef,
  workspace: string
): Promise<void> {
  return withProgress(`Creating sandbox ${ref.name}…`, () =>
    sandbox.create(ref, workspace)
  );
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

/** Build/load a ref's custom image with progress (no-op unless it has image + dockerfile). */
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
    () => images.ensureImage(ref.spec, repoRoot, { rebuild })
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
  if ((await sandbox.state(ref)) === "absent") {
    const workspace = sandbox.workspacePath();
    if (!workspace) {
      throw new Error("No workspace open.");
    }
    sbx.hostToSandboxPath(workspace); // fail fast on UNC/WSL paths, before any sbx mutation
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
}

/** FR-006: stop a sandbox (with progress; closes its terminals first to avoid exit popups). */
export async function stopRef(ref: sandbox.SandboxRef): Promise<void> {
  // Terminal disposal can take up to ~4s — keep it inside the spinner so the box appears
  // the instant the action is clicked, not only once the CLI call starts.
  await withProgress(`Stopping ${ref.name}…`, async () => {
    await disposeSandboxTerminals(ref.name);
    await sandbox.stop(ref);
  });
}

/** Destroy a sandbox instance (state gone; recipe kept). Closes its terminals first. */
export async function destroyRef(ref: sandbox.SandboxRef): Promise<void> {
  await withProgress(`Removing sandbox ${ref.name}…`, async () => {
    await disposeSandboxTerminals(ref.name);
    await sandbox.destroy(ref);
  });
}

/**
 * FR-007 Rebuild: refresh the image (FR-053), rebuild the custom image (if any), then
 * recreate the sandbox. A rebuild always starts from the freshest obtainable image;
 * when the refresh cannot happen (offline, local-only image) it warns and proceeds
 * from the cache instead of failing.
 */
export async function rebuildRef(
  root: vscode.Uri,
  ref: sandbox.SandboxRef
): Promise<void> {
  if (ref.spec.image && ref.spec.dockerfile) {
    await ensureImageForRef(ref, root.fsPath, true); // docker build --pull (FR-053)
  }
  // Recreate behind one spinner: terminal close (up to ~4s) + `sbx rm` when an instance
  // exists. Wrap the whole block — including the absent path, where only leftover or
  // reload-restored terminals need closing — so Rebuild never reintroduces a silent gap.
  await withProgress(`Removing sandbox ${ref.name}…`, async () => {
    await disposeSandboxTerminals(ref.name);
    if ((await sandbox.state(ref)) !== "absent") {
      await sandbox.destroy(ref);
    }
  });
  // FR-053: refresh AFTER the instance is gone (a template still referenced by a live
  // instance could refuse removal) and before the create that consumes it.
  if (!ref.spec.dockerfile) {
    const fresh = await withProgress(`Refreshing image for ${ref.name}…`, () =>
      images.refreshForRebuild(ref.spec)
    );
    if (!fresh) {
      void vscode.window.showWarningMessage(
        `Could not refresh the image for ${ref.name} — rebuilding from the cached image.`
      );
    }
  }
  const workspace = sandbox.workspacePath();
  if (!workspace) {
    throw new Error("No workspace open.");
  }
  sbx.hostToSandboxPath(workspace); // fail fast on UNC/WSL paths, before any sbx mutation
  // Same create-then-attach as createOrAttach: `sbx create` honours --name where the
  // one-shot run create-form does not (see createOrAttach).
  await createSandbox(ref, workspace);
  if (ref.spec.secrets.length > 0) {
    await secrets.ensureSecrets(ref);
  }
  openAgentAttach(ref);
  void publishPortsWhenReady(ref.name, ref.spec.ports);
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
  const workspace = sandbox.workspacePath();
  if (!workspace) {
    throw new Error("No workspace open.");
  }
  // Translate before any sbx mutation: throws a friendly error for UNC/WSL paths.
  const workspaceInside = sbx.hostToSandboxPath(workspace);
  if ((await sandbox.state(ref)) === "absent") {
    await ensureImageForRef(ref, root.fsPath);
    await createSandbox(ref, workspace);
  }
  if (ref.spec.secrets.length > 0) {
    // Same FR-032 re-check as createOrAttach: prompts only for missing secrets.
    await secrets.ensureSecrets(ref);
  }
  openShell(ref, workspaceInside);
  void publishPortsWhenReady(ref.name, ref.spec.ports);
}
