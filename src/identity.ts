import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { parse, stringify } from "yaml";
import { CONFIG_DIR } from "./config";

/**
 * Local, per-working-copy identity (FR-001). Just a short random `id` appended to every
 * sandbox name (`<name>-<key>-<id>`) so two clones/copies/worktrees of the same repo on one
 * host never collide. Stored at `.sandbox/identity.yaml`, which is gitignored — the
 * extension also writes `.sandbox/.gitignore` so it stays ignored even without a root
 * .gitignore entry. The shared project `name` lives in config.yaml (committed), not here.
 */
export interface SandboxIdentity {
  id: string;
}

const IDENTITY_FILE = "identity.yaml";

function identityUri(root: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(root, CONFIG_DIR, IDENTITY_FILE);
}

function randomId(): string {
  return randomBytes(4).toString("hex").slice(0, 5); // 5 hex chars, sbx-name-safe
}

/** Read the local identity, or undefined if absent/malformed. */
export async function readIdentity(
  root: vscode.Uri
): Promise<SandboxIdentity | undefined> {
  try {
    const buf = await vscode.workspace.fs.readFile(identityUri(root));
    const doc = parse(Buffer.from(buf).toString("utf8")) as
      | { id?: unknown }
      | null;
    if (doc && typeof doc.id === "string" && doc.id.trim() !== "") {
      return { id: doc.id };
    }
  } catch {
    // missing / malformed → no identity yet
  }
  return undefined;
}

/** Return the existing identity, or create one (random id) and ensure it stays gitignored. */
export async function ensureIdentity(
  root: vscode.Uri
): Promise<SandboxIdentity> {
  const existing = await readIdentity(root);
  if (existing) {
    return existing;
  }
  const identity: SandboxIdentity = { id: randomId() };
  const dir = vscode.Uri.joinPath(root, CONFIG_DIR);
  await vscode.workspace.fs.createDirectory(dir);
  await vscode.workspace.fs.writeFile(
    identityUri(root),
    Buffer.from(stringify(identity), "utf8")
  );
  // Self-contained ignore so the local id is never committed, even without a root entry.
  const gitignore = vscode.Uri.joinPath(dir, ".gitignore");
  try {
    await vscode.workspace.fs.stat(gitignore);
  } catch {
    await vscode.workspace.fs.writeFile(
      gitignore,
      Buffer.from("identity.yaml\n", "utf8")
    );
  }
  return identity;
}
