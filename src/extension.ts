import * as vscode from "vscode";
import { agentLabel } from "./agents";
import { CONFIG_DIR, readConfig, SandboxConfig, SandboxSpec } from "./config";
import { openForm, showInvalidConfig } from "./form";
import { ensureIdentity, readIdentity } from "./identity";
import * as log from "./log";
import * as names from "./names";
import * as ops from "./ops";
import * as sandbox from "./sandbox";
import * as sbx from "./sbx";
import { ensureProjectScript } from "./script";
import { manageCachedSecrets } from "./secrets";
import { registerExplorer } from "./tree";

let statusItem: vscode.StatusBarItem;
// Bumped on every refresh so an older, slower run can never overwrite a newer one
// (same idea as the tree's generation counter).
let statusGeneration = 0;
// FR-050: the locally active sandbox (last picked) survives reloads per workspace.
const LAST_SANDBOX = "sandboxConsole.lastSandbox";
let extCtx: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext): void {
  extCtx = context;
  // FR-057: the record of sbx names this machine can no longer create is per working copy.
  names.init(context.workspaceState);
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
    // FR-055: the operation log — every sbx/docker invocation, streamed while it runs.
    vscode.commands.registerCommand("sandboxConsole.showLog", () => log.show()),
    { dispose: () => log.dispose() },
    vscode.commands.registerCommand("sandboxConsole.pickSandbox", () =>
      pickSandbox()
    ),
    vscode.commands.registerCommand("sandboxConsole.manageSecrets", () =>
      manageCachedSecrets().catch((err) => fail("manage cached secrets", err))
    ),
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
  watchRecipe(context);
  // FR-002: startup discovery is SILENT — it only feeds the status bar and the
  // Explorer. Opening a workspace never raises notifications; Connect lives one
  // click away in the status bar.
  void refreshStatus();
  // FR-052: keep the generated project CLI current for repos that use sandboxes.
  void refreshProjectScript();
}

/**
 * FR-009: follow the recipe on disk. `.sandbox/config.yaml` is a committed file the docs
 * actively tell people to edit by hand, and it also changes under a git pull or a second
 * VS Code window — but the status bar and the Explorer resolve their keys (and therefore
 * sbx names) when they render. Without this, editing the recipe left both surfaces acting
 * on the previous key until something unrelated refreshed them, so Connect went out under
 * the old sandbox name — a rename appeared not to work.
 *
 * Watching, not polling: discovery stays event-driven and silent (FR-002), and the watcher
 * only observes — it never writes into `.sandbox/`.
 */
function watchRecipe(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return;
  }
  // `.sandbox/*.yaml` = the recipe plus identity.yaml (a regenerated id changes every
  // sandbox name too). Scoped to the workspace folder so a nested repo cannot fire it.
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, `${CONFIG_DIR}/*.yaml`)
  );
  let pending: NodeJS.Timeout | undefined;
  const changed = (): void => {
    // A single save can emit several events; refreshing per event would run one `sbx ls`
    // each. Coalesce them — the tree and the status bar re-read the file when they reload.
    if (pending) {
      clearTimeout(pending);
    }
    pending = setTimeout(() => {
      pending = undefined;
      void refreshStatus();
      void vscode.commands
        .executeCommand("sandboxConsole.refresh")
        .then(undefined, () => undefined);
    }, 300);
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(changed),
    watcher.onDidCreate(changed),
    watcher.onDidDelete(changed),
    {
      dispose: () => {
        if (pending) {
          clearTimeout(pending);
        }
      },
    }
  );
}

export function deactivate(): void {
  // Sandboxes are long-lived and intentionally outlive the extension host.
}

function fail(action: string, err: unknown): void {
  if (err instanceof ops.HandledError) {
    return; // already explained in its own dialog (FR-058) — a second toast adds nothing
  }
  const msg = err instanceof Error ? err.message : String(err);
  // Only suggest "sbx login" when the CLI output actually points at auth — for build
  // or config failures the hint would send users down the wrong path.
  const hint = /log\s*in|sign\s*in|unauthorized|authenticat/i.test(msg)
    ? ' (If you are not signed in, run "sbx login".)'
    : "";
  // FR-055: the full CLI output that produced this message is one click away.
  void vscode.window
    .showErrorMessage(
      `Sandbox Console: ${action} failed. ${msg}${hint}`,
      "Show Log"
    )
    .then((choice) => {
      if (choice === "Show Log") {
        log.show();
      }
    });
}

/**
 * FR-052: refresh `.sandbox/scripts/sbx.sh` on activation — only for repos that already
 * opted into sandboxes (a recipe with entries exists) AND already have the script. It is
 * never created merely by opening a project (`createIfMissing: false`) — the first
 * sandbox seeds it (FR-002: opening a workspace writes nothing into `.sandbox/`).
 * Generation is one-way: the extension writes the script but never executes it.
 */
async function refreshProjectScript(): Promise<void> {
  const root = sandbox.workspaceRoot();
  if (!root) {
    return;
  }
  try {
    const config = await readConfig(root);
    if (!config || config.sandboxes.length === 0) {
      return;
    }
    const version =
      (extCtx.extension.packageJSON as { version?: string }).version ?? "0.0.0";
    await ensureProjectScript(root, version, { createIfMissing: false });
  } catch {
    // malformed config / unwritable repo — the script is a convenience, stay quiet
  }
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

/** The locally active sandbox key, if the user has picked one (FR-050). */
function lastKey(): string | undefined {
  return extCtx.workspaceState.get<string>(LAST_SANDBOX);
}

/** Resolve which spec the status bar / single-action commands target (FR-050). */
function primarySpecOf(config: SandboxConfig): SandboxSpec {
  const lk = lastKey();
  return (
    config.sandboxes.find((s) => s.key === lk) ??
    config.sandboxes.find((s) => s.default) ??
    config.sandboxes[0]
  );
}

/**
 * Run an action on the repo's ACTIVE sandbox (FR-050: last picked → `default: true` →
 * first recipe entry — any agent, no implicit Claude). If no sandboxes are defined yet,
 * either open the New Sandbox form (`promptIfNone`) or just inform.
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
    const ref = identity
      ? await sandbox.primaryRef(root, identity, lastKey())
      : undefined;
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

/**
 * FR-050: the status-bar click / `Switch Sandbox` palette command. One defined sandbox
 * connects directly; several open a Quick Pick (picking also makes it the active one);
 * none routes to the New Sandbox form.
 */
async function pickSandbox(): Promise<void> {
  const root = await preflight();
  if (!root) {
    return;
  }
  let config;
  try {
    config = await readConfig(root);
  } catch (err) {
    await showInvalidConfig(root, err);
    return;
  }
  if (!config || config.sandboxes.length === 0) {
    await vscode.commands.executeCommand("sandboxConsole.newSandbox");
    return;
  }
  try {
    if (config.sandboxes.length === 1) {
      await connectTo(root, config.sandboxes[0].key);
      return;
    }
    const identity = await ensureIdentity(root);
    const refs = await sandbox.refs(root, identity);
    let infos: sbx.SandboxInfo[] = [];
    try {
      infos = await sbx.list();
    } catch {
      // not signed in / CLI error — show every sandbox as not created
    }
    const status = new Map(infos.map((i) => [i.name, i.status]));
    type Item = vscode.QuickPickItem & { key?: string };
    const items: Item[] = refs.map((ref) => {
      const s = status.get(ref.name);
      const icon =
        s === undefined
          ? "$(add)"
          : s === "running"
          ? "$(circle-filled)"
          : "$(circle-outline)";
      const state =
        s === undefined ? "not created" : s === "running" ? "running" : "stopped";
      return {
        label: `${icon} ${ref.spec.title || ref.spec.key}`,
        description: `${agentLabel(ref.spec.agent)} · ${state}${
          ref.spec.default ? " · default" : ""
        }`,
        key: ref.spec.key,
      };
    });
    items.push({ label: "$(add) New Sandbox…" });
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Connect to a sandbox (it becomes the active one)",
    });
    if (!picked) {
      return;
    }
    if (!picked.key) {
      await vscode.commands.executeCommand("sandboxConsole.newSandbox");
      return;
    }
    await connectTo(root, picked.key);
  } catch (err) {
    fail("connect", err);
  }
}

/** Connect to a specific recipe sandbox and remember it as the active one (FR-050). */
async function connectTo(root: vscode.Uri, key: string): Promise<void> {
  await extCtx.workspaceState.update(LAST_SANDBOX, key);
  const identity = await ensureIdentity(root);
  const ref = await sandbox.primaryRef(root, identity, key);
  if (!ref) {
    return;
  }
  await ops.createOrAttach(root, ref);
  refreshSoon();
}

/** FR-003/005: connect to the active sandbox (creates it if absent). */
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
  // FR-050: the item shows the ACTIVE sandbox by its display name, not an agent label.
  const primary = primarySpecOf(config);
  const label = primary.title || primary.key;
  const who = agentLabel(primary.agent);
  const identity = await readIdentity(root);
  if (stale()) {
    return;
  }
  if (!identity) {
    setStatus(
      `$(add) ${label}`,
      `${who} · not created — click to connect or switch`,
      "sandboxConsole.pickSandbox"
    );
    return;
  }
  let ref: sandbox.SandboxRef | undefined;
  let state: sbx.SandboxState;
  try {
    ref = await sandbox.primaryRef(root, identity, lastKey());
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
      setStatus(
        `$(circle-filled) ${label}`,
        `${who} · running — click to connect or switch`,
        "sandboxConsole.pickSandbox"
      );
      break;
    case "stopped":
      setStatus(
        `$(circle-outline) ${label}`,
        `${who} · stopped — click to connect or switch`,
        "sandboxConsole.pickSandbox"
      );
      break;
    case "absent":
      setStatus(
        `$(add) ${label}`,
        `${who} · not created — click to connect or switch`,
        "sandboxConsole.pickSandbox"
      );
      break;
  }
}

