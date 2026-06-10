import * as vscode from "vscode";
import { readConfig, SandboxSpec } from "./config";
import { SandboxIdentity } from "./identity";
import * as sbx from "./sbx";

/**
 * A concrete sandbox for this repo: a recipe spec (FR-009) plus the derived sbx name. The
 * name is `<projectName>-<key>-<id>` — projectName is the committed config.name (or the
 * folder), id is the local random identity — so separate copies/worktrees on one host get
 * independent, conflict-free sandbox names. sbx names allow letters, digits, `.`, `+`, `-`.
 */
export interface SandboxRef {
  spec: SandboxSpec;
  /** sbx sandbox name: `<projectName>-<key>-<id>`. */
  name: string;
  /** Committed project label (config.name, or the folder name). */
  projectName: string;
}

/**
 * Make a name part valid for sbx: each disallowed run becomes "-", the part must start
 * with a letter/digit (sbx + argv safety), and a part with nothing usable left (e.g. a
 * fully non-ASCII folder name) falls back to "sandbox" — mirroring form.ts tagSafe().
 */
function sanitize(part: string): string {
  const safe = part
    .replace(/[^A-Za-z0-9.+-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+$/, "");
  return safe || "sandbox";
}

function folderName(root: vscode.Uri): string {
  return root.path.split("/").filter(Boolean).pop() ?? "workspace";
}

export function sandboxName(
  projectName: string,
  key: string,
  id: string
): string {
  // sanitize() guarantees valid, non-empty parts; the composed name still passes the
  // argv-boundary assert (FR-009 values land in sbx argv, also via terminal shellArgs)
  // as a backstop against regressions in either side.
  return sbx.assertSandboxName(
    `${sanitize(projectName)}-${sanitize(key)}-${id}`
  );
}

export function ref(
  projectName: string,
  spec: SandboxSpec,
  id: string
): SandboxRef {
  // Validate config-derived argv values at derivation too — terminal.ts builds
  // `sbx run --name <name> [-t <image>] <agent> ...` straight from this ref.
  sbx.assertAgentId(spec.agent);
  if (spec.image) {
    sbx.assertImageTag(spec.image);
  }
  return { spec, projectName, name: sandboxName(projectName, spec.key, id) };
}

/** Every sandbox declared for this repo (empty when there's no `.sandbox/config.yaml`). */
export async function refs(
  root: vscode.Uri,
  identity: SandboxIdentity
): Promise<SandboxRef[]> {
  const config = await readConfig(root);
  if (!config) {
    return []; // no recipe → no sandboxes (UI offers "New Sandbox"); no implicit default
  }
  const projectName = config.name ?? folderName(root);
  return config.sandboxes.map((spec) => ref(projectName, spec, identity.id));
}

/**
 * The sandbox the single-action commands target (FR-050): the locally preferred key
 * (last picked, if still defined) → the recipe's `default: true` entry → the first
 * entry; undefined when none is defined yet.
 */
export async function primaryRef(
  root: vscode.Uri,
  identity: SandboxIdentity,
  preferKey?: string
): Promise<SandboxRef | undefined> {
  const all = await refs(root, identity);
  return (
    (preferKey ? all.find((r) => r.spec.key === preferKey) : undefined) ??
    all.find((r) => r.spec.default) ??
    all[0]
  );
}

export function state(sandbox: SandboxRef): Promise<sbx.SandboxState> {
  return sbx.stateOf(sandbox.name);
}

/** FR-006: stop, preserving state. */
export function stop(sandbox: SandboxRef): Promise<void> {
  return sbx.stop(sandbox.name);
}

/** FR-007 / Delete: remove the sandbox and all its state. */
export function destroy(sandbox: SandboxRef): Promise<void> {
  return sbx.remove(sandbox.name);
}

/** Create the sandbox without attaching (used before opening a shell). */
export function create(sandbox: SandboxRef, workspace: string): Promise<void> {
  return sbx.create({
    name: sandbox.name,
    agent: sandbox.spec.agent,
    workspace,
    clone: sandbox.spec.mount === "clone",
    image: sandbox.spec.image,
  });
}

export function workspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}
