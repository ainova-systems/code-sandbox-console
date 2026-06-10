import * as vscode from "vscode";
import { agentLabel } from "./agents";
import { readConfig, SandboxConfig, SandboxSpec } from "./config";
import { openForm, showInvalidConfig } from "./form";
import { ensureIdentity, readIdentity } from "./identity";
import * as ops from "./ops";
import * as sandbox from "./sandbox";
import * as sbx from "./sbx";
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
    vscode.commands.registerCommand("sandboxConsole.pickSandbox", () =>
      pickSandbox()
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
  void refreshStatus();
  // FR-002: discover on workspace open and offer the resume-first action.
  void discoverAndOffer();
}

export function deactivate(): void {
  // Sandboxes are long-lived and intentionally outlive the extension host.
}

function fail(action: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  // Only suggest "sbx login" when the CLI output actually points at auth — for build
  // or config failures the hint would send users down the wrong path.
  const hint = /log\s*in|sign\s*in|unauthorized|authenticat/i.test(msg)
    ? ' (If you are not signed in, run "sbx login".)'
    : "";
  vscode.window.showErrorMessage(
    `Sandbox Console: ${action} failed. ${msg}${hint}`
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

/**
 * Features §3 + "Attach before Create": on open, surface the resume-first action that matches
 * the discovered state — but only for repos that opted into sandboxes (a committed
 * recipe with entries). A repo without a recipe gets NO startup notification: the
 * status bar `+ New Sandbox` and the Sandboxes view are the quiet entry points.
 */
async function discoverAndOffer(): Promise<void> {
  const root = sandbox.workspaceRoot();
  if (!root || !(await sbx.available())) {
    return;
  }
  let config;
  try {
    config = await readConfig(root);
  } catch {
    return; // malformed — don't nag on startup
  }
  if (!config || config.sandboxes.length === 0) {
    return; // no recipe — stay quiet (status bar / Explorer offer New Sandbox)
  }
  const primary = primarySpecOf(config);
  const name = `${primary.title || primary.key} (${agentLabel(primary.agent)})`;
  const identity = await readIdentity(root);
  if (!identity) {
    if (
      (await vscode.window.showInformationMessage(
        `Sandbox ${name} is not created yet`,
        "Connect"
      )) === "Connect"
    ) {
      await attach();
    }
    return;
  }
  let ref: sandbox.SandboxRef | undefined;
  let current: sbx.SandboxState;
  try {
    ref = await sandbox.primaryRef(root, identity, lastKey());
    if (!ref) {
      return;
    }
    current = await sandbox.state(ref);
  } catch {
    return; // not signed in — don't nag on startup
  }
  const found =
    current === "absent"
      ? `Sandbox ${name} is not created yet`
      : `Sandbox ${name} found · ${current}`;
  if (
    (await vscode.window.showInformationMessage(found, "Connect")) === "Connect"
  ) {
    await attach();
  }
}
