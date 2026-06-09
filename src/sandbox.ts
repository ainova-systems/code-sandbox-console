import * as vscode from "vscode";
import { DEFAULT_AGENT } from "./agents";
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

function sanitize(part: string): string {
  return part.replace(/[^A-Za-z0-9.+-]/g, "-");
}

function folderName(root: vscode.Uri): string {
  return root.path.split("/").filter(Boolean).pop() ?? "workspace";
}

export function sandboxName(
  projectName: string,
  key: string,
  id: string
): string {
  return `${sanitize(projectName)}-${sanitize(key)}-${id}`;
}

export function ref(
  projectName: string,
  spec: SandboxSpec,
  id: string
): SandboxRef {
  return { spec, projectName, name: sandboxName(projectName, spec.key, id) };
}

/** The implicit recipe when `.sandbox/config.yaml` is absent: a single Claude sandbox. */
export function defaultSpec(): SandboxSpec {
  return {
    key: DEFAULT_AGENT.id,
    agent: DEFAULT_AGENT.id,
    mount: "direct",
    secrets: [],
    ports: [],
  };
}

/** Every sandbox declared for this repo (the recipe, or the default single Claude). */
export async function refs(
  root: vscode.Uri,
  identity: SandboxIdentity
): Promise<SandboxRef[]> {
  const config = await readConfig(root);
  const projectName = config?.name ?? folderName(root);
  const specs = config?.sandboxes ?? [defaultSpec()];
  return specs.map((spec) => ref(projectName, spec, identity.id));
}

/** The primary sandbox for the single-action commands (first recipe entry / default). */
export async function primaryRef(
  root: vscode.Uri,
  identity: SandboxIdentity
): Promise<SandboxRef> {
  const all = await refs(root, identity);
  return all[0]!; // refs() always yields at least the default
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
