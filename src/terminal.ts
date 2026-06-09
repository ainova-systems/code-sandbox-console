import * as vscode from "vscode";
import { agentLabel } from "./agents";
import { sbxPath } from "./sbx";
import { SandboxRef } from "./sandbox";

/**
 * Native VS Code terminals driving `sbx`. The native terminal owns a real PTY
 * (ConPTY/winpty), so ANSI, resize, and interactive agents work for free (FR-010/011).
 *
 * Agent terminals are tracked per sandbox name and REUSED: a second `sbx run <name>` is
 * not a separate instance — it's another attach session into the same microVM (shared
 * filesystem), which would race. So clicking a running sandbox reveals its existing
 * terminal rather than opening a duplicate. For true parallelism use a worktree or
 * `mount: clone` (each maps to its own sandbox).
 */

const agentTerminals = new Map<string, vscode.Terminal>();
const shellTerminals = new Map<string, vscode.Terminal[]>();

function term(name: string, args: string[]): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name,
    shellPath: sbxPath(),
    shellArgs: args,
  });
  terminal.show();
  return terminal;
}

/** Reveal a live agent terminal for this sandbox, or undefined if none/dead. */
function revealAgentTerminal(name: string): vscode.Terminal | undefined {
  const existing = agentTerminals.get(name);
  if (existing) {
    const alive =
      vscode.window.terminals.includes(existing) &&
      existing.exitStatus === undefined;
    if (alive) {
      existing.show();
      return existing;
    }
    agentTerminals.delete(name);
  }
  return undefined;
}

function openAgentTerminal(
  name: string,
  label: string,
  args: string[]
): vscode.Terminal {
  const reused = revealAgentTerminal(name);
  if (reused) {
    return reused;
  }
  const terminal = term(label, args);
  agentTerminals.set(name, terminal);
  return terminal;
}

/** Close (and forget) every tracked terminal (agent + shells) for a sandbox. Called
 * before stop/destroy/rebuild so killing the sandbox doesn't leave "exit 137" popups. */
export function disposeSandboxTerminals(name: string): void {
  const agent = agentTerminals.get(name);
  if (agent) {
    agentTerminals.delete(name);
    agent.dispose();
  }
  const shells = shellTerminals.get(name);
  if (shells) {
    shellTerminals.delete(name);
    for (const t of shells) {
      t.dispose();
    }
  }
}

/**
 * Create-or-attach: `sbx run --name <name> [--clone] [-t <image>] <agent> <workspace>`
 * creates the sandbox if absent and attaches the agent (FR-003 + FR-005). A custom image
 * (`spec.image`) must already be in the sbx store (built/loaded first — see sbx.ts).
 */
export function openAgentCreate(
  sandbox: SandboxRef,
  workspace: string
): vscode.Terminal {
  const args = ["run", "--name", sandbox.name];
  if (sandbox.spec.mount === "clone") {
    args.push("--clone");
  }
  if (sandbox.spec.image) {
    args.push("-t", sandbox.spec.image);
  }
  args.push(sandbox.spec.agent, workspace);
  return openAgentTerminal(
    sandbox.name,
    `${agentLabel(sandbox.spec.agent)} Sandbox`,
    args
  );
}

/**
 * Attach to an existing sandbox by name: `sbx run <name>` resumes it if stopped and
 * attaches the agent (FR-004 + FR-005). Reuses the existing terminal if one is live.
 */
export function openAgentAttach(sandbox: SandboxRef): vscode.Terminal {
  return openAgentTerminal(
    sandbox.name,
    `${agentLabel(sandbox.spec.agent)} Sandbox`,
    ["run", sandbox.name]
  );
}

/**
 * Open a shell inside the sandbox at the workspace; `sbx exec` auto-starts it if stopped.
 * `workspaceInside` is the host path translated to its in-sandbox mount (e.g. D:\repo ->
 * /d/repo). Shells are intentionally NOT pooled — multiple shells are fine.
 */
export function openShell(
  sandbox: SandboxRef,
  workspaceInside: string
): vscode.Terminal {
  const terminal = term(`Shell · ${sandbox.identity.name}`, [
    "exec",
    "-it",
    "-w",
    workspaceInside,
    sandbox.name,
    "bash",
  ]);
  const list = shellTerminals.get(sandbox.name) ?? [];
  list.push(terminal);
  shellTerminals.set(sandbox.name, list);
  return terminal;
}
