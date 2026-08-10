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
/** Terminals handed to dispose() that may outlive the 4s close timeout — never adopt these. */
const disposing = new Set<vscode.Terminal>();

/**
 * Evict closed terminals from both pools so dead Terminal objects don't accumulate.
 * Registered lazily on first use: terminal.ts has no activate/deactivate hook (only
 * functions imported by ops.ts), so this single subscription deliberately lives for
 * the extension-host process.
 */
let closeListener: vscode.Disposable | undefined;

function ensureCloseListener(): void {
  if (closeListener) {
    return;
  }
  closeListener = vscode.window.onDidCloseTerminal((closed) => {
    disposing.delete(closed);
    for (const [name, terminal] of agentTerminals) {
      if (terminal === closed) {
        agentTerminals.delete(name);
      }
    }
    for (const [name, list] of shellTerminals) {
      const remaining = list.filter((t) => t !== closed);
      if (remaining.length === 0) {
        shellTerminals.delete(name);
      } else if (remaining.length < list.length) {
        shellTerminals.set(name, remaining);
      }
    }
  });
}

function term(name: string, args: string[]): vscode.Terminal {
  ensureCloseListener();
  const terminal = vscode.window.createTerminal({
    name,
    shellPath: sbxPath(),
    shellArgs: args,
  });
  terminal.show();
  return terminal;
}

/** Reveal a live agent terminal for this sandbox, or undefined if none/dead. Falls back
 * to scanning open terminals so reuse survives Extension Host reloads: the Map is empty
 * then, but VS Code revives the terminal and its still-running `sbx run`. */
function revealAgentTerminal(
  name: string,
  label: string
): vscode.Terminal | undefined {
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
  // Map miss (e.g. after a window reload): adopt the revived agent terminal instead of
  // racing a second concurrent `sbx run <name>` into the same microVM. Same-session
  // terminals are told apart by launch args (`run` = agent session, `exec` = shell);
  // revived ones lose their args, so fall back to the exact agent tab title.
  const revived = vscode.window.terminals.find((t) => {
    if (t.exitStatus !== undefined || disposing.has(t)) {
      return false;
    }
    const args = (t.creationOptions as vscode.TerminalOptions)?.shellArgs;
    if (Array.isArray(args)) {
      return args[0] === "run" && args.includes(name);
    }
    return t.name === label;
  });
  if (revived) {
    ensureCloseListener();
    agentTerminals.set(name, revived);
    revived.show();
    return revived;
  }
  return undefined;
}

function openAgentTerminal(
  name: string,
  label: string,
  args: string[]
): vscode.Terminal {
  const reused = revealAgentTerminal(name, label);
  if (reused) {
    return reused;
  }
  const terminal = term(label, args);
  agentTerminals.set(name, terminal);
  return terminal;
}

/** Does this terminal belong to the given sandbox? Matches the exact name after the
 * `<label> · ` tab-title delimiter (a bare substring test would cross-match sandboxes
 * whose full name embeds another's) or as an exact launch-args element. */
function terminalMatches(t: vscode.Terminal, name: string): boolean {
  if (t.name.endsWith(` · ${name}`)) {
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
  ensureCloseListener(); // evicts from `disposing` too — needed even before any term()
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
      disposing.add(t); // a dying terminal must never be adopted as a live agent session
      t.dispose();
    }
  });
}

/**
 * A plain **host** terminal at `cwd` with `command` typed in but NOT executed — the user
 * presses Enter. Used by the FR-058 refusal to hand over `git fetch --unshallow` without
 * running it: the extension never changes what a user's repository contains, and typing it
 * for them removes the only friction that leaves.
 *
 * Deliberately not an sbx terminal: this runs on the host, in the user's own shell, so it
 * carries no `shellPath` and is not pooled.
 */
export function openHostCommandTerminal(
  cwd: string,
  command: string,
  name: string
): void {
  const terminal = vscode.window.createTerminal({ name, cwd });
  terminal.show();
  terminal.sendText(command, false); // false = type it, leave the Enter to the user
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
