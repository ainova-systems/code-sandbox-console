import * as vscode from "vscode";
import { agentLabel } from "./agents";
import { ensureIdentity, readIdentity } from "./identity";
import * as sandbox from "./sandbox";
import * as sbx from "./sbx";
import { openForm } from "./form";
import * as ops from "./ops";
import { registerExplorer } from "./tree";

let statusItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand("sandboxConsole.createClaude", () =>
      createAndAttach()
    ),
    vscode.commands.registerCommand("sandboxConsole.attach", () => attach()),
    vscode.commands.registerCommand("sandboxConsole.stop", () => stop()),
    vscode.commands.registerCommand("sandboxConsole.openShell", () => shell()),
    vscode.commands.registerCommand("sandboxConsole.rebuild", () => rebuild()),
    vscode.commands.registerCommand("sandboxConsole.newSandbox", async () => {
      const root = sandbox.workspaceRoot();
      if (!root) {
        vscode.window.showErrorMessage(
          "Sandbox Console: open a folder/repository first."
        );
        return;
      }
      await openForm(context, root, { kind: "new" });
    }),
    // Keep the indicator live without polling: refresh when the window regains
    // focus (state may have changed via the CLI) and when terminals come/go.
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
  void discoverAndOffer();
}

export function deactivate(): void {
  // Sandboxes are long-lived and intentionally outlive the extension host.
}

function fail(action: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  vscode.window.showErrorMessage(
    `Sandbox Console: ${action} failed. ${msg} (If you are not signed in, run "sbx login".)`
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
    vscode.window.showErrorMessage(
      'Sandbox Console: Docker Sandboxes (sbx) was not found. Install it, then run "sbx login".'
    );
    return undefined;
  }
  return root;
}

/** FR-003: create the primary sandbox and attach (resume-first; image+secrets via ops). */
async function createAndAttach(): Promise<void> {
  const root = await preflight();
  if (!root) {
    return;
  }
  try {
    const identity = await ensureIdentity(root);
    const ref = await sandbox.primaryRef(root, identity);
    await ops.createOrAttach(root, ref);
    refreshSoon();
  } catch (err) {
    fail("create", err);
  }
}

/** FR-007 Rebuild: rebuild the custom image (if any) and recreate the primary sandbox. */
async function rebuild(): Promise<void> {
  const root = await preflight();
  if (!root) {
    return;
  }
  try {
    const identity = await readIdentity(root);
    if (!identity) {
      vscode.window.showInformationMessage("No sandbox to rebuild.");
      return;
    }
    const ref = await sandbox.primaryRef(root, identity);
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
    if (choice !== "Rebuild") {
      return;
    }
    await ops.rebuildRef(root, ref);
    refreshSoon();
  } catch (err) {
    fail("rebuild", err);
  }
}

/** FR-005: attach to the existing sandbox; sbx run resumes it if stopped. */
async function attach(): Promise<void> {
  const root = await preflight();
  if (!root) {
    return;
  }
  try {
    const identity = await readIdentity(root);
    if (!identity) {
      return void createAndAttach();
    }
    const ref = await sandbox.primaryRef(root, identity);
    await ops.createOrAttach(root, ref);
    refreshSoon();
  } catch (err) {
    fail("attach", err);
  }
}

/** FR-006: stop the sandbox, preserving all state. */
async function stop(): Promise<void> {
  const root = await preflight();
  if (!root) {
    return;
  }
  try {
    const identity = await readIdentity(root);
    if (!identity) {
      vscode.window.showInformationMessage("No sandbox to stop.");
      return;
    }
    const ref = await sandbox.primaryRef(root, identity);
    if ((await sandbox.state(ref)) !== "running") {
      vscode.window.showInformationMessage("Sandbox is not running.");
      return;
    }
    await ops.stopRef(ref);
    vscode.window.showInformationMessage(
      `${agentLabel(ref.spec.agent)} sandbox stopped. State is preserved.`
    );
    void refreshStatus();
  } catch (err) {
    fail("stop", err);
  }
}

/** Open Shell: ensure the sandbox exists, then open a shell (auto-starts). */
async function shell(): Promise<void> {
  const root = await preflight();
  if (!root) {
    return;
  }
  try {
    const identity = await ensureIdentity(root);
    const ref = await sandbox.primaryRef(root, identity);
    await ops.shellRef(root, ref);
    refreshSoon();
  } catch (err) {
    fail("open shell", err);
  }
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

/** Reflect the current sandbox state in the status bar (click → attach/create). */
async function refreshStatus(): Promise<void> {
  const root = sandbox.workspaceRoot();
  if (!root || !(await sbx.available())) {
    statusItem.hide();
    return;
  }
  const identity = await readIdentity(root);
  if (!identity) {
    setStatus(
      "$(add) Claude Sandbox",
      "No sandbox for this project — click to create",
      "sandboxConsole.createClaude"
    );
    return;
  }
  let ref: sandbox.SandboxRef;
  let state: sbx.SandboxState;
  try {
    ref = await sandbox.primaryRef(root, identity);
    state = await sandbox.state(ref);
  } catch {
    statusItem.hide(); // not signed in, or a malformed config — stay quiet
    return;
  }
  const label = `${agentLabel(ref.spec.agent)} Sandbox`;
  switch (state) {
    case "running":
      setStatus(
        `$(circle-filled) ${label}`,
        "Running — click to connect",
        "sandboxConsole.attach"
      );
      break;
    case "stopped":
      setStatus(
        `$(circle-outline) ${label}`,
        "Stopped — click to connect",
        "sandboxConsole.attach"
      );
      break;
    case "absent":
      setStatus(
        `$(add) ${label}`,
        "Not created — click to create",
        "sandboxConsole.createClaude"
      );
      break;
  }
}

/**
 * FRD section 3 + "Attach before Create": on open, surface the resume-first
 * action that matches the discovered state.
 */
async function discoverAndOffer(): Promise<void> {
  const root = sandbox.workspaceRoot();
  if (!root) {
    return;
  }
  const identity = await readIdentity(root);
  if (!identity) {
    await offerCreate("Sandbox not found.");
    return;
  }
  if (!(await sbx.available())) {
    return; // Stay quiet; commands explain when invoked.
  }

  let ref: sandbox.SandboxRef;
  let current: sbx.SandboxState;
  try {
    ref = await sandbox.primaryRef(root, identity);
    current = await sandbox.state(ref);
  } catch {
    return; // not signed in, or a malformed config — don't nag on startup.
  }
  const label = agentLabel(ref.spec.agent);

  if (current === "running") {
    if (
      (await vscode.window.showInformationMessage(
        `${label} Sandbox found · Running`,
        "Connect"
      )) === "Connect"
    ) {
      await attach();
    }
  } else if (current === "stopped") {
    if (
      (await vscode.window.showInformationMessage(
        `${label} Sandbox found · Stopped`,
        "Connect"
      )) === "Connect"
    ) {
      await attach();
    }
  } else {
    await offerCreate("Sandbox not found.");
  }
}

async function offerCreate(message: string): Promise<void> {
  if (
    (await vscode.window.showInformationMessage(
      message,
      "Create Claude Sandbox"
    )) === "Create Claude Sandbox"
  ) {
    await createAndAttach();
  }
}
