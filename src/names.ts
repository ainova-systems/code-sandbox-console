import * as vscode from "vscode";

/**
 * FR-057: the sbx names this machine can no longer create.
 *
 * When `sbx create` fails because the name is still claimed by leaked runtime state
 * (Architecture §14, upstream docker/sbx-releases#129), that name is dead until
 * `sbx reset` — and nothing in the CLI can report it: `sbx ls` does not list it and
 * `sbx rm` answers "not found". The observed failure is the only signal there is, so it
 * is recorded here and key derivation skips any candidate that would produce a recorded
 * name (form.ts) instead of walking straight back into the fault.
 *
 * State is per working copy (`workspaceState`) because it describes THIS machine's sbx
 * runtime, not the project: it must never reach the committed recipe. The record is
 * self-limiting — it only stores names, never removes sandboxes, and a `sbx reset` simply
 * makes it irrelevant.
 */

const KEY = "sandboxConsole.unusableNames";

/** Keep the record bounded; the useful entries are the recent ones. */
const LIMIT = 50;

let store: vscode.Memento | undefined;

/** Wire the workspace store (extension activation). Before this every query is empty. */
export function init(memento: vscode.Memento): void {
  store = memento;
}

function all(): string[] {
  return store?.get<string[]>(KEY) ?? [];
}

/** True when creating this sbx name is known to fail on this machine. */
export function isUnusable(name: string): boolean {
  return all().includes(name);
}

/** Record a name whose `sbx create` failed with the leaked-state error. */
export async function remember(name: string): Promise<void> {
  if (!store || all().includes(name)) {
    return;
  }
  await store.update(KEY, [...all(), name].slice(-LIMIT));
}
