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

/** Does this terminal belong to the given sandbox? Matches by the sandbox name embedded
 * in the tab title (survives Extension Host reloads) or in the launch args. */
function terminalMatches(t: vscode.Terminal, name: string): boolean {
  if (t.name.includes(name)) {
    return true;
  }
  const args = (t.creationOptions as vscode.TerminalOptions)?.shellArgs;
  return Array.isArray(args) && args.includes(name);
}

/**
 * Close every terminal (agent + shells, tracked or reload-restored) for a sandbox and
 * RESOLVE only once they've actually closed. Callers await this before `sbx stop`/`rm` so
 * the sandbox isn't torn out from under a live `sbx run`/`exec` client — that self-exit is
 * what produces the "terminated with exit code 1/137" popup.
 */
export function disposeSandboxTerminals(name: string): Promise<void> {
  agentTerminals.delete(name);
  shellTerminals.delete(name);
  const targets = vscode.window.terminals.filter((t) => terminalMatches(t, name));
  if (targets.length === 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let remaining = targets.length;
    let finished = false;
    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      sub.dispose();
      clearTimeout(timer);
      resolve();
    };
    const sub = vscode.window.onDidCloseTerminal((closed) => {
      if (targets.includes(closed)) {
        remaining--;
        if (remaining <= 0) {
          finish();
        }
      }
    });
    const timer = setTimeout(finish, 4000); // safety: never hang if a close event is missed
    for (const t of targets) {
      t.dispose();
    }
  });
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
    `${agentLabel(sandbox.spec.agent)} · ${sandbox.name}`,
    args
  );
}

/**
 * Attach to an existing sandbox: `sbx run <name>` resumes the sandbox if stopped. Reuses a
 * live terminal (the same session) when present; otherwise launches the agent fresh. We do
 * NOT auto-pass `--continue`: closing a terminal ends that attach session, so forcing a
 * resume could spawn a second agent over interrupted work. Resume a conversation explicitly
 * inside the agent (e.g. Claude's `/resume`) when you actually want it.
 */
export function openAgentAttach(sandbox: SandboxRef): vscode.Terminal {
  return openAgentTerminal(
    sandbox.name,
    `${agentLabel(sandbox.spec.agent)} · ${sandbox.name}`,
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
  const terminal = term(`Shell · ${sandbox.name}`, [
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
