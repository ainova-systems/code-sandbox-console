import * as vscode from "vscode";
import { agentLabel } from "./agents";
import { readConfig } from "./config";
import { openForm, showInvalidConfig } from "./form";
import { ensureIdentity, readIdentity } from "./identity";
import * as ops from "./ops";
import * as sandbox from "./sandbox";
import * as sbx from "./sbx";
import { registerExplorer } from "./tree";

let statusItem: vscode.StatusBarItem;
// Bumped on every refresh so an older, slower run can never overwrite a newer one
// (same idea as the tree's generation counter).
let statusGeneration = 0;

export function activate(context: vscode.ExtensionContext): void {
  statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand("sandboxConsole.attach", () => attach()),
    vscode.commands.registerCommand("sandboxConsole.stop", () => stop()),
    vscode.commands.registerCommand("sandboxConsole.openShell", () => shell()),
    vscode.commands.registerCommand("sandboxConsole.rebuild", () => rebuild()),
    vscode.commands.registerCommand("sandboxConsole.newSandbox", async () => {
      // Same preflight as every other command: without it a missing sbx CLI only
      // surfaces as a raw "sbx ls failed" after the form has written `.sandbox/`.
      const root = await preflight();
      if (!root) {
        return;
      }
      await openForm(context, root, { kind: "new" });
    }),
    // Keep the indicator live without polling: refresh when the window regains focus
    // (state may have changed via the CLI) and when terminals come/go.
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        void refreshStatus();
      }
    }),
    vscode.window.onDidOpenTerminal(() => refreshSoon()),
    vscode.window.onDidCloseTerminal(() => void refreshStatus())
  );

  registerExplorer(context);
  void refreshStatus();
  // FR-002: discover on workspace open and offer the resume-first action.
  void discoverAndOffer(context);
}

export function deactivate(): void {
  // Sandboxes are long-lived and intentionally outlive the extension host.
}

function fail(action: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  // Only suggest "sbx login" when the CLI output actually points at auth — for build
  // or config failures the hint would send users down the wrong path.
  const hint = /log\s*in|sign\s*in|unauthorized|authenticat/i.test(msg)
    ? ' (If you are not signed in, run "sbx login".)'
    : "";
  vscode.window.showErrorMessage(
    `Sandbox Console: ${action} failed. ${msg}${hint}`
  );
}

/** Require an open workspace and a working sbx CLI. */
async function preflight(): Promise<vscode.Uri | undefined> {
  const root = sandbox.workspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage(
      "Sandbox Console: open a folder/repository first."
    );
    return undefined;
  }
  if (!(await sbx.available())) {
    void vscode.window
      .showErrorMessage(
        'Sandbox Console: Docker Sandboxes (sbx) was not found. Install it, then run "sbx login".',
        "Install instructions"
      )
      .then((choice) => {
        if (choice === "Install instructions") {
          void vscode.env.openExternal(
            vscode.Uri.parse("https://docs.docker.com/ai/sandboxes/")
          );
        }
      });
    return undefined;
  }
  return root;
}

/**
 * Run an action on the repo's PRIMARY sandbox (first entry in `.sandbox/config.yaml` —
 * any agent, no implicit Claude). If no sandboxes are defined yet, either open the New
 * Sandbox form (`promptIfNone`) or just inform.
 */
async function actOnPrimary(
  action: string,
  fn: (root: vscode.Uri, ref: sandbox.SandboxRef) => Promise<void>,
  promptIfNone = false
): Promise<void> {
  const root = await preflight();
  if (!root) {
    return;
  }
  try {
    let config;
    try {
      config = await readConfig(root);
    } catch (err) {
      // A malformed recipe must not masquerade as "no sandboxes yet" — the repo HAS
      // sandboxes; tell the same story as the form/tree and point at the file.
      await showInvalidConfig(root, err);
      return;
    }
    const hasSpecs = config !== undefined && config.sandboxes.length > 0;
    const identity = hasSpecs ? await ensureIdentity(root) : undefined;
    const ref = identity ? await sandbox.primaryRef(root, identity) : undefined;
    if (!ref) {
      if (promptIfNone) {
        await vscode.commands.executeCommand("sandboxConsole.newSandbox");
      } else {
        vscode.window.showInformationMessage(
          "No sandboxes for this repo yet — use New Sandbox to create one."
        );
      }
      return;
    }
    await fn(root, ref);
    refreshSoon();
  } catch (err) {
    fail(action, err);
  }
}

/** FR-003/005: connect to the primary sandbox (creates it if absent). */
async function attach(): Promise<void> {
  await actOnPrimary("connect", (root, ref) => ops.createOrAttach(root, ref), true);
}

/** Open a shell in the primary sandbox. */
async function shell(): Promise<void> {
  await actOnPrimary("open shell", (root, ref) => ops.shellRef(root, ref), true);
}

/** FR-007 Rebuild: rebuild the custom image (if any) and recreate the primary sandbox. */
async function rebuild(): Promise<void> {
  await actOnPrimary("rebuild", async (root, ref) => {
    const hasImage = Boolean(ref.spec.image && ref.spec.dockerfile);
    const choice = await vscode.window.showWarningMessage(
      `Rebuild ${ref.name}? ${
        hasImage
          ? "Rebuilds the image and recreates the sandbox."
          : "Recreates the sandbox."
      } The workspace on the host mount is preserved.`,
      { modal: true },
      "Rebuild"
    );
    if (choice === "Rebuild") {
      await ops.rebuildRef(root, ref);
    }
  });
}

/** FR-006: stop the primary sandbox, preserving all state. */
async function stop(): Promise<void> {
  await actOnPrimary("stop", async (_root, ref) => {
    if ((await sandbox.state(ref)) !== "running") {
      vscode.window.showInformationMessage("Sandbox is not running.");
      return;
    }
    await ops.stopRef(ref);
    vscode.window.showInformationMessage(
      `${agentLabel(ref.spec.agent)} sandbox stopped. State is preserved.`
    );
  });
}

function setStatus(text: string, tooltip: string, command: string): void {
  statusItem.text = text;
  statusItem.tooltip = tooltip;
  statusItem.command = command;
  statusItem.show();
}

/** Refresh now, then again shortly after — sandbox create/start is async. */
function refreshSoon(): void {
  void refreshStatus();
  setTimeout(() => void refreshStatus(), 2500);
  setTimeout(() => void refreshStatus(), 7000);
}

/** Reflect the primary sandbox's state in the status bar (click → connect / new). */
async function refreshStatus(): Promise<void> {
  // Overlapping refreshes race across the awaits below; bail out before touching the
  // status bar whenever a newer refresh started mid-load (prevents stale state).
  const gen = ++statusGeneration;
  const stale = (): boolean => gen !== statusGeneration;
  const root = sandbox.workspaceRoot();
  if (!root || !(await sbx.available())) {
    if (!stale()) {
      statusItem.hide();
    }
    return;
  }
  let config;
  try {
    config = await readConfig(root);
  } catch {
    if (!stale()) {
      statusItem.hide(); // malformed config — stay quiet
    }
    return;
  }
  if (stale()) {
    return;
  }
  if (!config || config.sandboxes.length === 0) {
    setStatus(
      "$(add) New Sandbox",
      "No sandboxes for this repo — click to create one",
      "sandboxConsole.newSandbox"
    );
    return;
  }
  const label = `${agentLabel(config.sandboxes[0].agent)} Sandbox`;
  const identity = await readIdentity(root);
  if (stale()) {
    return;
  }
  if (!identity) {
    setStatus(`$(add) ${label}`, "Not created — click to connect", "sandboxConsole.attach");
    return;
  }
  let ref: sandbox.SandboxRef | undefined;
  let state: sbx.SandboxState;
  try {
    ref = await sandbox.primaryRef(root, identity);
    if (!ref) {
      if (!stale()) {
        statusItem.hide();
      }
      return;
    }
    state = await sandbox.state(ref);
  } catch {
    if (!stale()) {
      statusItem.hide(); // not signed in — stay quiet
    }
    return;
  }
  if (stale()) {
    return;
  }
  switch (state) {
    case "running":
      setStatus(`$(circle-filled) ${label}`, "Running — click to connect", "sandboxConsole.attach");
      break;
    case "stopped":
      setStatus(`$(circle-outline) ${label}`, "Stopped — click to connect", "sandboxConsole.attach");
      break;
    case "absent":
      setStatus(`$(add) ${label}`, "Not created — click to connect", "sandboxConsole.attach");
      break;
  }
}

/**
 * Features §3 + "Attach before Create": on open, surface the resume-first action that matches
 * the discovered state. No implicit Claude — offers New Sandbox when nothing is defined.
 */
async function discoverAndOffer(context: vscode.ExtensionContext): Promise<void> {
  const root = sandbox.workspaceRoot();
  if (!root || !(await sbx.available())) {
    return;
  }
  let config;
  try {
    config = await readConfig(root);
  } catch {
    return; // malformed — don't nag on startup
  }
  if (!config || config.sandboxes.length === 0) {
    // No committed recipe: offer at most once per workspace so fresh repos are not
    // nagged on every window open. (A committed config is an opt-in — keep offering.)
    if (context.workspaceState.get<boolean>("sandboxConsole.offeredCreate")) {
      return;
    }
    await context.workspaceState.update("sandboxConsole.offeredCreate", true);
    if (
      (await vscode.window.showInformationMessage(
        "No sandboxes for this repo.",
        "New Sandbox"
      )) === "New Sandbox"
    ) {
      await vscode.commands.executeCommand("sandboxConsole.newSandbox");
    }
    return;
  }
  const label = agentLabel(config.sandboxes[0].agent);
  const identity = await readIdentity(root);
  if (!identity) {
    if (
      (await vscode.window.showInformationMessage(
        `${label} Sandbox is not created yet`,
        "Connect"
      )) === "Connect"
    ) {
      await attach();
    }
    return;
  }
  let ref: sandbox.SandboxRef | undefined;
  let current: sbx.SandboxState;
  try {
    ref = await sandbox.primaryRef(root, identity);
    if (!ref) {
      return;
    }
    current = await sandbox.state(ref);
  } catch {
    return; // not signed in — don't nag on startup
  }
  const found =
    current === "absent"
      ? `${label} Sandbox is not created yet`
      : `${label} Sandbox found · ${current}`;
  if (
    (await vscode.window.showInformationMessage(found, "Connect")) === "Connect"
  ) {
    await attach();
  }
}
