import * as vscode from "vscode";
import { AgentDef } from "./agents";
import { SandboxIdentity } from "./identity";
import * as sbx from "./sbx";

/**
 * sbx sandbox name = repo identity + agent (FR-001). Derived from the persisted
 * `.sandbox` name (a folder-derived slug, stable across renames once written),
 * so the same repo always maps to the same sandbox. sbx names allow letters,
 * numbers, hyphens, periods, plus and minus signs.
 */
export function sandboxName(identity: SandboxIdentity, agent: AgentDef): string {
  const base = identity.name.replace(/[^A-Za-z0-9.+-]/g, "-");
  return `${base}-${agent.id}`;
}

export interface SandboxRef {
  identity: SandboxIdentity;
  agent: AgentDef;
  name: string;
}

export function ref(identity: SandboxIdentity, agent: AgentDef): SandboxRef {
  return { identity, agent, name: sandboxName(identity, agent) };
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
    agent: sandbox.agent.id,
    workspace,
  });
}

export function workspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}
