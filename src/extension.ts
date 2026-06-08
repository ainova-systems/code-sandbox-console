import * as vscode from "vscode";
import { DEFAULT_AGENT } from "./agents";
import { ensureIdentity, readIdentity } from "./identity";
import * as sandbox from "./sandbox";
import * as sbx from "./sbx";
import { openAgentAttach, openAgentCreate, openShell } from "./terminal";

let statusItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand("ainoflowSandbox.createClaude", () =>
      createAndAttach()
    ),
    vscode.commands.registerCommand("ainoflowSandbox.attach", () => attach()),
    vscode.commands.registerCommand("ainoflowSandbox.stop", () => stop()),
    vscode.commands.registerCommand("ainoflowSandbox.openShell", () => shell()),
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
    `Ainoflow Sandbox: ${action} failed. ${msg} (If you are not signed in, run "sbx login".)`
  );
}

/** Require an open workspace and a working sbx CLI. */
async function preflight(): Promise<vscode.Uri | undefined> {
  const root = sandbox.workspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage(
      "Ainoflow Sandbox: open a folder/repository first."
    );
    return undefined;
  }
  if (!(await sbx.available())) {
    vscode.window.showErrorMessage(
      'Ainoflow Sandbox: Docker Sandboxes (sbx) was not found. Install it, then run "sbx login".'
    );
    return undefined;
  }
  return root;
}

/** FR-003: create the Claude sandbox and attach (create-or-attach via sbx run). */
async function createAndAttach(): Promise<void> {
  const root = await preflight();
  if (!root) {
    return;
  }
  try {
    const identity = await ensureIdentity(root);
    const ref = sandbox.ref(identity, DEFAULT_AGENT);
    const workspace = sandbox.workspacePath()!;
    if ((await sandbox.state(ref)) === "absent") {
      openAgentCreate(ref, workspace);
    } else {
      openAgentAttach(ref);
    }
    refreshSoon();
  } catch (err) {
    fail("create", err);
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
    const ref = sandbox.ref(identity, DEFAULT_AGENT);
    if ((await sandbox.state(ref)) === "absent") {
      return void createAndAttach();
    }
    openAgentAttach(ref);
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
    const ref = sandbox.ref(identity, DEFAULT_AGENT);
    if ((await sandbox.state(ref)) !== "running") {
      vscode.window.showInformationMessage("Sandbox is not running.");
      return;
    }
    await sandbox.stop(ref);
    vscode.window.showInformationMessage(
      `${DEFAULT_AGENT.label} sandbox stopped. State is preserved.`
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
    const ref = sandbox.ref(identity, DEFAULT_AGENT);
    const host = sandbox.workspacePath()!;
    if ((await sandbox.state(ref)) === "absent") {
      await sandbox.create(ref, host);
    }
    openShell(ref, sbx.hostToSandboxPath(host));
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
      "ainoflowSandbox.createClaude"
    );
    return;
  }
  let state: sbx.SandboxState;
  try {
    state = await sandbox.state(sandbox.ref(identity, DEFAULT_AGENT));
  } catch {
    statusItem.hide(); // e.g. not signed in
    return;
  }
  switch (state) {
    case "running":
      setStatus(
        "$(circle-filled) Claude Sandbox",
        "Running — click to attach",
        "ainoflowSandbox.attach"
      );
      break;
    case "stopped":
      setStatus(
        "$(circle-outline) Claude Sandbox",
        "Stopped — click to start & attach",
        "ainoflowSandbox.attach"
      );
      break;
    case "absent":
      setStatus(
        "$(add) Claude Sandbox",
        "Not created — click to create",
        "ainoflowSandbox.createClaude"
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

  let current: sbx.SandboxState;
  try {
    current = await sandbox.state(sandbox.ref(identity, DEFAULT_AGENT));
  } catch {
    return; // e.g. not signed in — don't nag on startup.
  }

  if (current === "running") {
    if (
      (await vscode.window.showInformationMessage(
        `${DEFAULT_AGENT.label} Sandbox found · Running`,
        "Attach"
      )) === "Attach"
    ) {
      await attach();
    }
  } else if (current === "stopped") {
    if (
      (await vscode.window.showInformationMessage(
        `${DEFAULT_AGENT.label} Sandbox found · Stopped`,
        "Start and Attach"
      )) === "Start and Attach"
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
