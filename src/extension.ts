import * as vscode from "vscode";
import { DEFAULT_AGENT } from "./agents";
import { ensureIdentity, readIdentity } from "./identity";
import * as sandbox from "./sandbox";
import * as sbx from "./sbx";
import { openAgentAttach, openAgentCreate, openShell } from "./terminal";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("ainoflowSandbox.createClaude", () =>
      createAndAttach()
    ),
    vscode.commands.registerCommand("ainoflowSandbox.attach", () => attach()),
    vscode.commands.registerCommand("ainoflowSandbox.stop", () => stop()),
    vscode.commands.registerCommand("ainoflowSandbox.openShell", () =>
      shell()
    )
  );

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
  } catch (err) {
    fail("open shell", err);
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
