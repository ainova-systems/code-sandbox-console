import * as vscode from "vscode";
import * as images from "./images";
import * as sandbox from "./sandbox";
import * as secrets from "./secrets";
import { hostToSandboxPath } from "./sbx";
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

/** Build/load a ref's custom image with progress (no-op unless it has image + dockerfile). */
export async function ensureImageForRef(
  ref: sandbox.SandboxRef,
  repoRoot: string,
  rebuild = false
): Promise<void> {
  if (!ref.spec.image || !ref.spec.dockerfile) {
    return;
  }
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `${rebuild ? "Rebuilding" : "Building"} image ${ref.spec.image}…`,
      cancellable: false,
    },
    () => images.ensureImage(ref.spec, repoRoot, { rebuild })
  );
}

/**
 * Create-or-attach a specific sandbox (FR-003/005). When the recipe needs a custom image
 * or secrets, builds the image and provisions secrets first (creating the sandbox
 * non-attaching so per-sandbox secrets apply); otherwise the verified one-shot `sbx run`.
 */
export async function createOrAttach(
  root: vscode.Uri,
  ref: sandbox.SandboxRef
): Promise<void> {
  if ((await sandbox.state(ref)) !== "absent") {
    openAgentAttach(ref);
    return;
  }
  const workspace = sandbox.workspacePath();
  if (!workspace) {
    throw new Error("No workspace open.");
  }
  await ensureImageForRef(ref, root.fsPath);
  if (ref.spec.secrets.length > 0) {
    await sandbox.create(ref, workspace); // exists before per-sandbox secret set
    await secrets.ensureSecrets(ref);
    openAgentAttach(ref);
  } else {
    openAgentCreate(ref, workspace);
  }
}

/** FR-006: stop a sandbox, first closing its attached terminal (avoids a noisy exit 1). */
export async function stopRef(ref: sandbox.SandboxRef): Promise<void> {
  disposeSandboxTerminals(ref.name);
  await sandbox.stop(ref);
}

/** Destroy a sandbox instance (state gone; recipe kept). Closes its terminal first. */
export async function destroyRef(ref: sandbox.SandboxRef): Promise<void> {
  disposeSandboxTerminals(ref.name);
  await sandbox.destroy(ref);
}

/** FR-007 Rebuild: rebuild the custom image (if any) then recreate the sandbox. */
export async function rebuildRef(
  root: vscode.Uri,
  ref: sandbox.SandboxRef
): Promise<void> {
  disposeSandboxTerminals(ref.name);
  if (ref.spec.image && ref.spec.dockerfile) {
    await ensureImageForRef(ref, root.fsPath, true);
  }
  if ((await sandbox.state(ref)) !== "absent") {
    await sandbox.destroy(ref);
  }
  const workspace = sandbox.workspacePath();
  if (!workspace) {
    throw new Error("No workspace open.");
  }
  if (ref.spec.secrets.length > 0) {
    await sandbox.create(ref, workspace);
    await secrets.ensureSecrets(ref);
    openAgentAttach(ref);
  } else {
    openAgentCreate(ref, workspace);
  }
}

/** Open a shell in a specific sandbox at the workspace (creates it first if absent). */
export async function shellRef(
  root: vscode.Uri,
  ref: sandbox.SandboxRef
): Promise<void> {
  const workspace = sandbox.workspacePath();
  if (!workspace) {
    throw new Error("No workspace open.");
  }
  if ((await sandbox.state(ref)) === "absent") {
    await ensureImageForRef(ref, root.fsPath);
    await sandbox.create(ref, workspace);
  }
  openShell(ref, hostToSandboxPath(workspace));
}
