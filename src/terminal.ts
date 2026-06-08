import * as vscode from "vscode";
import { sbxPath } from "./sbx";
import { SandboxRef } from "./sandbox";

/**
 * Open a native VS Code terminal that drives `sbx`. The native terminal owns a
 * real PTY (ConPTY/winpty), so ANSI, resize, and interactive agents work for
 * free, satisfying FR-010/FR-011 with no native dependency.
 */
function term(name: string, args: string[]): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name,
    shellPath: sbxPath(),
    shellArgs: args,
  });
  terminal.show();
  return terminal;
}

/**
 * Create-or-attach: `sbx run --name <name> <agent> <workspace>` creates the
 * sandbox if absent and attaches the agent (FR-003 + FR-005).
 */
export function openAgentCreate(
  sandbox: SandboxRef,
  workspace: string,
  clone = false
): vscode.Terminal {
  const args = ["run", "--name", sandbox.name];
  if (clone) {
    args.push("--clone");
  }
  args.push(sandbox.agent.id, workspace);
  return term(`${sandbox.agent.label} Sandbox`, args);
}

/**
 * Attach to an existing sandbox by name: `sbx run <name>` resumes it if stopped
 * and attaches the agent (FR-004 + FR-005).
 */
export function openAgentAttach(sandbox: SandboxRef): vscode.Terminal {
  return term(`${sandbox.agent.label} Sandbox`, ["run", sandbox.name]);
}

/**
 * Open a shell inside the sandbox at the workspace; `sbx exec` auto-starts it if
 * stopped. `workspaceInside` is the host path translated to its in-sandbox mount
 * (e.g. D:\repo -> /d/repo); `-w` drops the shell into the repo rather than the
 * empty default home.
 */
export function openShell(
  sandbox: SandboxRef,
  workspaceInside: string
): vscode.Terminal {
  return term(`Shell · ${sandbox.identity.name}`, [
    "exec",
    "-it",
    "-w",
    workspaceInside,
    sandbox.name,
    "bash",
  ]);
}
