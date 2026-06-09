import * as vscode from "vscode";
import { DEFAULT_AGENT } from "./agents";
import { readConfig, SandboxSpec } from "./config";
import { SandboxIdentity } from "./identity";
import * as sbx from "./sbx";

/**
 * A concrete sandbox for this repo: a recipe spec (FR-009) bound to the local identity,
 * with the derived sbx name. The name is `<identity.name>-<spec.key>` — keyed on the
 * local label (never a UUID), so separate copies/worktrees get independent sandboxes.
 * sbx names allow letters, numbers, hyphens, periods, plus and minus signs.
 */
export interface SandboxRef {
  identity: SandboxIdentity;
  spec: SandboxSpec;
  name: string;
}

function sanitize(part: string): string {
  return part.replace(/[^A-Za-z0-9.+-]/g, "-");
}

export function sandboxName(identity: SandboxIdentity, key: string): string {
  return `${sanitize(identity.name)}-${sanitize(key)}`;
}

export function ref(identity: SandboxIdentity, spec: SandboxSpec): SandboxRef {
  return { identity, spec, name: sandboxName(identity, spec.key) };
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
  const specs = config?.sandboxes ?? [defaultSpec()];
  return specs.map((spec) => ref(identity, spec));
}

/** The primary sandbox for the single-action commands (first recipe entry / default). */
export async function primaryRef(
  root: vscode.Uri,
  identity: SandboxIdentity
): Promise<SandboxRef> {
  const all = await refs(root, identity);
  return all[0] ?? ref(identity, defaultSpec());
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
