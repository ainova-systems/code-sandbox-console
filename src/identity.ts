import * as vscode from "vscode";
import { parse, stringify } from "yaml";
import { CONFIG_DIR } from "./config";

/**
 * Local repository identity (FR-001, v0.2). Just a human label — the sbx sandbox name
 * derives from it (`<name>-<key>`). Persisted at `.sandbox/identity.yaml`, which is
 * gitignored and per-working-tree, so separate clones/copies/worktrees get their own.
 *
 * The v0.1 `id` UUID was dropped: it was never part of the sandbox name, so it
 * disambiguated nothing. `name` is persisted once (folder-derived) so it survives a
 * folder rename; different folders → different `name` → independent sandboxes.
 */
export interface SandboxIdentity {
  name: string;
}

const IDENTITY_FILE = "identity.yaml";
/** v0.1 layout: a single JSON file `.sandbox` holding `{id,name}` (migrated on read). */
const LEGACY_FILE = ".sandbox";

function identityUri(root: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(root, CONFIG_DIR, IDENTITY_FILE);
}

function deriveName(root: vscode.Uri): string {
  const parts = root.path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "workspace";
}

async function readFileText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const buf = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(buf).toString("utf8");
  } catch {
    return undefined; // missing, or a directory (v0.2 `.sandbox/`)
  }
}

/** Read the v0.1 single-file `.sandbox` JSON, if that is what's present. */
async function readLegacy(root: vscode.Uri): Promise<SandboxIdentity | undefined> {
  const text = await readFileText(vscode.Uri.joinPath(root, LEGACY_FILE));
  if (text === undefined) {
    return undefined;
  }
  try {
    const json = JSON.parse(text) as { name?: unknown };
    const name =
      typeof json.name === "string" && json.name.trim() !== ""
        ? json.name
        : deriveName(root);
    return { name };
  } catch {
    return undefined;
  }
}

async function writeIdentity(
  root: vscode.Uri,
  identity: SandboxIdentity
): Promise<void> {
  // A file named `.sandbox` cannot coexist with a `.sandbox/` directory; createDirectory
  // is idempotent and recursive.
  await vscode.workspace.fs.createDirectory(
    vscode.Uri.joinPath(root, CONFIG_DIR)
  );
  await vscode.workspace.fs.writeFile(
    identityUri(root),
    Buffer.from(stringify(identity), "utf8")
  );
}

/** Read the identity, migrating a v0.1 `.sandbox` file if found; undefined if neither. */
export async function readIdentity(
  root: vscode.Uri
): Promise<SandboxIdentity | undefined> {
  const text = await readFileText(identityUri(root));
  if (text !== undefined) {
    try {
      const doc = parse(text) as { name?: unknown } | null;
      if (doc && typeof doc.name === "string" && doc.name.trim() !== "") {
        return { name: doc.name };
      }
    } catch {
      // malformed — fall through to legacy/none
    }
  }
  const legacy = await readLegacy(root);
  if (legacy) {
    // Migrate: remove the old file first so `.sandbox/` can become a directory.
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, LEGACY_FILE), {
        useTrash: false,
      });
    } catch {
      // best-effort
    }
    await writeIdentity(root, legacy);
    return legacy;
  }
  return undefined;
}

/** Return the existing identity, or create and persist a new one (FR-003). */
export async function ensureIdentity(
  root: vscode.Uri
): Promise<SandboxIdentity> {
  const existing = await readIdentity(root);
  if (existing) {
    return existing;
  }
  const identity: SandboxIdentity = { name: deriveName(root) };
  await writeIdentity(root, identity);
  return identity;
}
