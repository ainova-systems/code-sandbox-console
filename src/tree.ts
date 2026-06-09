import * as vscode from "vscode";
import { agentLabel } from "./agents";
import { removeFromConfig } from "./config";
import { openForm } from "./form";
import { readIdentity } from "./identity";
import * as ops from "./ops";
import * as sandbox from "./sandbox";
import * as sbx from "./sbx";

/**
 * Sandbox Explorer (FRD §10) — a tree of THIS repo's sandbox instances with live status.
 * Optionally grouped (spec.group) into folders. Node label = spec.title || key. Per-node
 * actions reuse ops.ts so the Explorer and palette commands never drift.
 */

const VIEW_ID = "sandboxConsoleExplorer";

class SandboxNode extends vscode.TreeItem {
  constructor(
    public readonly ref: sandbox.SandboxRef,
    public readonly state: sbx.SandboxState
  ) {
    super(
      ref.spec.title || ref.spec.key,
      vscode.TreeItemCollapsibleState.None
    );
    this.description = `${agentLabel(ref.spec.agent)} · ${state}`;
    this.tooltip = `${ref.name} — ${state}`;
    this.contextValue = `sandbox.${state}`;
    this.iconPath = new vscode.ThemeIcon(
      state === "running"
        ? "circle-filled"
        : state === "stopped"
        ? "circle-outline"
        : "add"
    );
    // No single-click action — clicking only selects; use the inline buttons (Attach to
    // open the agent, New Terminal for a shell). VS Code has no separate double-click event.
  }
}

class GroupNode extends vscode.TreeItem {
  constructor(public readonly group: string, count: number) {
    super(group, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "group";
    this.iconPath = new vscode.ThemeIcon("folder");
    this.description = String(count);
  }
}

type Node = GroupNode | SandboxNode;

interface Loaded {
  groups: Map<string, SandboxNode[]>;
  ungrouped: SandboxNode[];
}

class SandboxExplorer implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private cache?: Loaded;
  private generation = 0;

  refresh(): void {
    this.generation++;
    this.cache = undefined;
    this.emitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    const loaded = await this.load();
    if (element instanceof GroupNode) {
      return loaded.groups.get(element.group) ?? [];
    }
    if (element instanceof SandboxNode) {
      return [];
    }
    const groupNodes: Node[] = [...loaded.groups.entries()].map(
      ([group, nodes]) => new GroupNode(group, nodes.length)
    );
    return [...groupNodes, ...loaded.ungrouped];
  }

  /** Cache the result only if no refresh happened mid-load (prevents stale tree). */
  private store(result: Loaded, gen: number): Loaded {
    if (gen === this.generation) {
      this.cache = result;
    }
    return result;
  }

  private async load(): Promise<Loaded> {
    if (this.cache) {
      return this.cache;
    }
    const gen = this.generation;
    const groups = new Map<string, SandboxNode[]>();
    const ungrouped: SandboxNode[] = [];
    const result: Loaded = { groups, ungrouped };
    const root = sandbox.workspaceRoot();
    if (!root || !(await sbx.available())) {
      return this.store(result, gen);
    }
    const identity = await readIdentity(root);
    if (!identity) {
      return this.store(result, gen); // viewsWelcome offers "New sandbox"
    }
    let refs: sandbox.SandboxRef[];
    try {
      refs = await sandbox.refs(root, identity);
    } catch {
      return this.store(result, gen);
    }
    // One `sbx ls` for the whole tree (not one per node).
    let infos: sbx.SandboxInfo[] = [];
    try {
      infos = await sbx.list();
    } catch {
      // not signed in / CLI error — treat all as absent
    }
    const status = new Map(infos.map((i) => [i.name, i.status]));
    for (const ref of refs) {
      const s = status.get(ref.name);
      const state: sbx.SandboxState =
        s === undefined ? "absent" : s === "running" ? "running" : "stopped";
      const node = new SandboxNode(ref, state);
      const group = ref.spec.group;
      if (group) {
        if (!groups.has(group)) {
          groups.set(group, []);
        }
        groups.get(group)!.push(node);
      } else {
        ungrouped.push(node);
      }
    }
    return this.store(result, gen);
  }
}

function reportError(action: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  vscode.window.showErrorMessage(`Sandbox Console: ${action} failed. ${msg}`);
}

/** Register the Explorer view + its per-node commands. */
export function registerExplorer(context: vscode.ExtensionContext): void {
  const provider = new SandboxExplorer();
  const view = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
  });

  async function withNode(
    node: SandboxNode | undefined,
    action: string,
    fn: (root: vscode.Uri, ref: sandbox.SandboxRef) => Promise<void>
  ): Promise<void> {
    const root = sandbox.workspaceRoot();
    if (!root) {
      return;
    }
    try {
      let ref = node?.ref;
      if (!ref) {
        const identity = await readIdentity(root);
        if (!identity) {
          return;
        }
        ref = await sandbox.primaryRef(root, identity);
      }
      await fn(root, ref);
      provider.refresh();
      // sbx state can lag the command (e.g. stop takes a moment) — re-check shortly after.
      setTimeout(() => provider.refresh(), 2500);
    } catch (err) {
      reportError(action, err);
    }
  }

  context.subscriptions.push(
    view,
    vscode.commands.registerCommand("sandboxConsole.refresh", () =>
      provider.refresh()
    ),
    vscode.commands.registerCommand(
      "sandboxConsole.item.attach",
      (node?: SandboxNode) =>
        withNode(node, "attach", (root, ref) => ops.createOrAttach(root, ref))
    ),
    vscode.commands.registerCommand(
      "sandboxConsole.item.stop",
      (node?: SandboxNode) =>
        withNode(node, "stop", async (_root, ref) => {
          await ops.stopRef(ref);
        })
    ),
    vscode.commands.registerCommand(
      "sandboxConsole.item.shell",
      (node?: SandboxNode) =>
        withNode(node, "open shell", (root, ref) => ops.shellRef(root, ref))
    ),
    vscode.commands.registerCommand(
      "sandboxConsole.item.rebuild",
      (node?: SandboxNode) =>
        withNode(node, "rebuild", async (root, ref) => {
          const ok = await vscode.window.showWarningMessage(
            `Rebuild ${ref.name}? Recreates the sandbox (workspace on the host mount is preserved).`,
            { modal: true },
            "Rebuild"
          );
          if (ok === "Rebuild") {
            await ops.rebuildRef(root, ref);
          }
        })
    ),
    vscode.commands.registerCommand(
      "sandboxConsole.item.edit",
      (node?: SandboxNode) =>
        withNode(node, "edit", async (root, ref) => {
          await openForm(context, root, { kind: "edit", key: ref.spec.key });
        })
    ),
    vscode.commands.registerCommand(
      "sandboxConsole.item.destroy",
      (node?: SandboxNode) =>
        withNode(node, "delete instance", async (_root, ref) => {
          const ok = await vscode.window.showWarningMessage(
            `Delete the "${ref.name}" instance? Destroys all sandbox state (host workspace untouched). The definition stays — you can recreate it.`,
            { modal: true },
            "Delete instance"
          );
          if (ok === "Delete instance") {
            await ops.destroyRef(ref);
          }
        })
    ),
    vscode.commands.registerCommand(
      "sandboxConsole.item.remove",
      (node?: SandboxNode) =>
        withNode(node, "remove", async (root, ref) => {
          const ok = await vscode.window.showWarningMessage(
            `Remove "${ref.spec.title || ref.spec.key}" from .sandbox/config.yaml? This deletes the definition and destroys its instance + state.`,
            { modal: true },
            "Remove"
          );
          if (ok === "Remove") {
            const existed = (await sandbox.state(ref)) !== "absent";
            // Update config first so the terminal-close refresh during destroy already
            // sees the sandbox gone (avoids a stale node lingering until the next refresh).
            await removeFromConfig(root, ref.spec.key);
            if (existed) {
              await ops.destroyRef(ref);
            }
          }
        })
    ),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        provider.refresh();
      }
    }),
    vscode.window.onDidOpenTerminal(() => provider.refresh()),
    vscode.window.onDidCloseTerminal(() => provider.refresh())
  );
}
