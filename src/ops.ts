import * as vscode from "vscode";
import * as images from "./images";
import * as sandbox from "./sandbox";
import * as sbx from "./sbx";
import * as secrets from "./secrets";
import {
  disposeSandboxTerminals,
  openAgentAttach,
  openAgentCreate,
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
 * Create-or-attach a specific sandbox (FR-003/005). When the recipe needs a custom image
 * or secrets, builds the image and provisions secrets first (creating the sandbox
 * non-attaching so per-sandbox secrets apply); otherwise the verified one-shot `sbx run`.
 * Attaching to an existing sandbox re-prompts for any still-missing secrets (FR-032).
 * Configured ports are published once the sandbox comes up.
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
    if (ref.spec.secrets.length > 0) {
      await createSandbox(ref, workspace); // exists before per-sandbox secret set
      await secrets.ensureSecrets(ref);
      openAgentAttach(ref);
    } else {
      openAgentCreate(ref, workspace);
    }
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

/** FR-007 Rebuild: rebuild the custom image (if any) then recreate the sandbox. */
export async function rebuildRef(
  root: vscode.Uri,
  ref: sandbox.SandboxRef
): Promise<void> {
  if (ref.spec.image && ref.spec.dockerfile) {
    await ensureImageForRef(ref, root.fsPath, true);
  }
  // Recreate (terminal close + `sbx rm`) behind one spinner; degrades to a plain Recreate
  // when the recipe has no custom image (Architecture §11).
  if ((await sandbox.state(ref)) !== "absent") {
    await withProgress(`Removing sandbox ${ref.name}…`, async () => {
      await disposeSandboxTerminals(ref.name);
      await sandbox.destroy(ref);
    });
  } else {
    await disposeSandboxTerminals(ref.name);
  }
  const workspace = sandbox.workspacePath();
  if (!workspace) {
    throw new Error("No workspace open.");
  }
  sbx.hostToSandboxPath(workspace); // fail fast on UNC/WSL paths, before any sbx mutation
  if (ref.spec.secrets.length > 0) {
    await createSandbox(ref, workspace);
    await secrets.ensureSecrets(ref);
    openAgentAttach(ref);
  } else {
    openAgentCreate(ref, workspace);
  }
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
