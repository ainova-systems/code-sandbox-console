import * as vscode from "vscode";
import { agentLabel } from "./agents";
import {
  CONFIG_DIR,
  CONFIG_FILE,
  readConfig,
  removeFromConfig,
  SandboxSpec,
} from "./config";
import { openForm } from "./form";
import { ensureIdentity, readIdentity } from "./identity";
import * as log from "./log";
import * as ops from "./ops";
import * as prereq from "./prereq";
import * as sandbox from "./sandbox";
import * as sbx from "./sbx";

/**
 * Sandbox Explorer (Features §10) — a tree of THIS repo's sandbox instances with live status.
 * Optionally grouped (spec.group) into folders. Node label = spec.title || key. Per-node
 * actions reuse ops.ts so the Explorer and palette commands never drift.
 */

const VIEW_ID = "sandboxConsoleExplorer";

class SandboxNode extends vscode.TreeItem {
  constructor(
    public readonly spec: SandboxSpec,
    public readonly state: sbx.SandboxState,
    // The concrete sbx ref, present ONLY once a local identity exists. Before the first
    // create the tree lists the recipe read-only (no identity written), so the ref is
    // absent and withNode() resolves it lazily — see registerExplorer().
    public readonly ref?: sandbox.SandboxRef
  ) {
    super(spec.title || spec.key, vscode.TreeItemCollapsibleState.None);
    // FR-054: a sandbox with an operation in flight renders busy. `sandbox.busy` matches
    // none of the menus' `when` clauses, so every action disappears for the duration —
    // the guard would decline them anyway, and an action you can click but not use is a
    // lie about the state.
    const busy = ref ? ops.busyLabel(ref.name) : undefined;
    this.description = busy
      ? `${agentLabel(spec.agent)} · ${busy.toLowerCase()}…`
      : `${agentLabel(spec.agent)} · ${state}`;
    this.tooltip = busy
      ? `${ref?.name} — ${busy} in progress`
      : ref
      ? `${ref.name} — ${state}`
      : `${spec.title || spec.key} — not created`;
    this.contextValue = busy ? "sandbox.busy" : `sandbox.${state}`;
    this.iconPath = new vscode.ThemeIcon(
      busy
        ? "sync~spin"
        : state === "running"
        ? "circle-filled"
        : state === "stopped"
        ? "circle-outline"
        : "add"
    );
    // No single-click action — clicking only selects; use the inline buttons (Connect to
    // open the agent, Shell for a terminal). VS Code has no separate double-click event.
  }

  get key(): string {
    return this.spec.key;
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

/**
 * Single node shown when `.sandbox/config.yaml` exists but is malformed — an empty tree
 * would misleadingly render the "No sandboxes yet" welcome. Click opens the file; no
 * popup spam on every refresh.
 */
class ConfigErrorNode extends vscode.TreeItem {
  constructor(root: vscode.Uri, err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    // readConfig() already prefixes the file path — redundant next to our label.
    const msg = raw.replace(/^\.sandbox\/config\.yaml:\s*/, "");
    super(
      `config.yaml is invalid: ${msg}`,
      vscode.TreeItemCollapsibleState.None
    );
    this.tooltip = `${CONFIG_DIR}/${CONFIG_FILE}: ${msg}`;
    this.contextValue = "configError";
    this.iconPath = new vscode.ThemeIcon("error");
    this.command = {
      command: "vscode.open",
      title: "Open config.yaml",
      arguments: [vscode.Uri.joinPath(root, CONFIG_DIR, CONFIG_FILE)],
    };
  }
}

/**
 * Single node shown when the host cannot run sandboxes (FR-059): no `sbx` CLI, an unhealthy
 * daemon, or nobody signed in. Without it the view falls through to an empty tree and VS Code
 * renders the "No sandboxes yet for this repo" welcome — false whenever the committed recipe
 * defines sandboxes, and pointing at New Sandbox, the one action that cannot work.
 */
class NotReadyNode extends vscode.TreeItem {
  constructor(problem: prereq.SbxProblem) {
    super(problem.summary, vscode.TreeItemCollapsibleState.None);
    this.description = problem.kind === "signed-out" ? "sbx login" : "not ready";
    this.tooltip = prereq.tooltip(problem);
    this.contextValue = "notReady";
    this.iconPath = new vscode.ThemeIcon("warning");
    this.command = {
      command: "sandboxConsole.checkPrerequisites",
      title: "Check prerequisites",
    };
  }
}

type Node = GroupNode | SandboxNode | ConfigErrorNode | NotReadyNode;

interface Loaded {
  groups: Map<string, SandboxNode[]>;
  ungrouped: SandboxNode[];
  /** Set when the recipe is malformed or the host is not ready — the only (root) node. */
  error?: ConfigErrorNode | NotReadyNode;
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
    if (
      element instanceof SandboxNode ||
      element instanceof ConfigErrorNode ||
      element instanceof NotReadyNode
    ) {
      return [];
    }
    if (loaded.error) {
      return [loaded.error];
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
    if (!root) {
      return this.store(result, gen);
    }
    // FR-059: an unusable host is a state of its own, not "no sandboxes".
    const readiness = await prereq.sbxReadiness();
    if (!readiness.ok) {
      result.error = new NotReadyNode(readiness);
      return this.store(result, gen);
    }
    let config;
    try {
      config = await readConfig(root);
    } catch (err) {
      // Malformed config (FR-009): render one error node, not an empty tree — the
      // viewsWelcome would misleadingly claim "No sandboxes yet for this repo."
      result.error = new ConfigErrorNode(root, err);
      return this.store(result, gen);
    }
    if (!config) {
      return this.store(result, gen); // no recipe → empty → viewsWelcome "New Sandbox"
    }
    // Discovery is read-only (FR-002): list the recipe WITHOUT writing into `.sandbox/`.
    // Read the identity but never create it — before the first create there is none, and
    // without one no instance for this working copy can exist, so every sandbox is
    // necessarily absent. The identity (and the rest of `.sandbox/`) is written only when
    // the user actually creates one — see withNode().
    const identity = await readIdentity(root);
    let refs: sandbox.SandboxRef[] = [];
    if (identity) {
      try {
        refs = await sandbox.refs(root, identity);
      } catch (err) {
        // refs() re-reads the config, so this is the same malformed-config case.
        result.error = new ConfigErrorNode(root, err);
        return this.store(result, gen);
      }
    } else {
      // No identity → refs() is skipped, but it is what normally validates the recipe's
      // argv-bound fields; without this an invalid `config.yaml` would look valid until
      // the first action. Validate here (no identity needed) so the error surfaces now.
      try {
        sandbox.assertSpecsValid(config.sandboxes);
      } catch (err) {
        result.error = new ConfigErrorNode(root, err);
        return this.store(result, gen);
      }
    }
    // One `sbx ls` for the whole tree (not one per node); skip it when nothing can exist
    // yet (no identity → all absent).
    let infos: sbx.SandboxInfo[] = [];
    if (identity) {
      try {
        infos = await sbx.list();
      } catch (err) {
        // Readiness passed, so this is a live CLI failure rather than a missing
        // prerequisite. Rendering every entry as "not created" would invent a state we do
        // not know — and contradict the status bar, which reports the same failure (FR-059).
        result.error = new NotReadyNode({
          ok: false,
          kind: "unhealthy",
          summary: "Sandbox state is unavailable.",
          detail: err instanceof Error ? err.message : String(err),
        });
        return this.store(result, gen);
      }
    }
    const status = new Map(infos.map((i) => [i.name, i.status]));
    type Entry = {
      spec: SandboxSpec;
      ref?: sandbox.SandboxRef;
      state: sbx.SandboxState;
    };
    const entries: Entry[] = identity
      ? refs.map((ref) => {
          const s = status.get(ref.name);
          const state: sbx.SandboxState =
            s === undefined ? "absent" : s === "running" ? "running" : "stopped";
          return { spec: ref.spec, ref, state };
        })
      : config.sandboxes.map((spec) => ({ spec, state: "absent" as const }));
    for (const entry of entries) {
      const node = new SandboxNode(entry.spec, entry.state, entry.ref);
      const group = entry.spec.group;
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
  if (err instanceof ops.HandledError) {
    return; // already explained in its own dialog (FR-058) — a second toast adds nothing
  }
  const msg = err instanceof Error ? err.message : String(err);
  // FR-055: the full CLI output that produced this message is one click away.
  void vscode.window
    .showErrorMessage(`Sandbox Console: ${action} failed. ${msg}`, "Show Log")
    .then((choice) => {
      if (choice === "Show Log") {
        log.show();
      }
    });
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
        if (node) {
          // The tree listed this sandbox before any identity existed. Creating one now is
          // correct: this helper backs create/connect/shell actions, so the user IS
          // creating/connecting their first sandbox — exactly when `.sandbox/` is seeded.
          const identity = await ensureIdentity(root);
          ref = await sandbox.primaryRef(root, identity, node.key);
        } else {
          // Defensive: a command fired without a node — resolve read-only, never write.
          const identity = await readIdentity(root);
          ref = identity ? await sandbox.primaryRef(root, identity) : undefined;
        }
      }
      if (!ref) {
        return;
      }
      await fn(root, ref);
      provider.refresh();
      // sbx state can lag the command (e.g. stop takes a moment) — re-check shortly after.
      setTimeout(() => provider.refresh(), 2500);
    } catch (err) {
      reportError(action, err);
    }
  }

  // Recipe-only actions (Edit, Remove from config) operate on the node's spec/key and must
  // NOT create an identity — the user is editing/removing a definition, not creating or
  // connecting a sandbox (spec 009: write `.sandbox/` only on first create). Remove still
  // destroys a live instance, but only via an already-resolved ref (present iff an identity
  // existed at render); with no identity none can exist, so there is nothing to destroy.
  async function withRecipeNode(
    node: SandboxNode | undefined,
    action: string,
    fn: (root: vscode.Uri, node: SandboxNode) => Promise<void>
  ): Promise<void> {
    const root = sandbox.workspaceRoot();
    if (!root || !node) {
      return;
    }
    try {
      await fn(root, node);
      provider.refresh();
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
      "sandboxConsole.item.openLogs",
      (node?: SandboxNode) =>
        withNode(node, "open logs", async (_root, ref) => {
          await ops.openLogs(ref);
        })
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
        withRecipeNode(node, "edit", async (root, n) => {
          await openForm(context, root, { kind: "edit", key: n.key });
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
        withRecipeNode(node, "remove", async (root, n) => {
          const ok = await vscode.window.showWarningMessage(
            `Remove "${n.spec.title || n.spec.key}" from .sandbox/config.yaml? This deletes the definition and destroys its instance + state.`,
            { modal: true },
            "Remove"
          );
          if (ok === "Remove") {
            // Destroy the live instance FIRST: if `sbx rm` fails, the definition must
            // stay in config.yaml so the tree can still show and manage the sandbox
            // (otherwise the microVM is orphaned, reachable only via raw `sbx ls`/`rm`).
            // No identity (n.ref undefined) → no instance can exist → nothing to destroy.
            if (n.ref && (await sandbox.state(n.ref)) !== "absent") {
              // FR-054: a declined destroy (another operation is in flight for this
              // sandbox) must keep the entry too — same reason as a failed one.
              if (!(await ops.destroyRef(n.ref))) {
                return;
              }
            }
            await removeFromConfig(root, n.key);
            await ops.removeHooks(root, n.key); // FR-060: its generated kit goes with it
          }
        })
    ),
    // FR-054: re-render the moment a sandbox becomes busy or free, so the spinner and the
    // hidden actions appear on the click, not on the next focus change.
    ops.onDidChangeBusy(() => provider.refresh()),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        provider.refresh();
      }
    }),
    vscode.window.onDidOpenTerminal(() => provider.refresh()),
    vscode.window.onDidCloseTerminal(() => provider.refresh())
  );
}
