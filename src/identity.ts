import * as vscode from "vscode";
import { randomUUID } from "crypto";

/**
 * Repository identity (FRD FR-001). Persisted in a committed `.sandbox` file at
 * the repo root so sandboxes are keyed on a stable id, never on the filesystem
 * path or git remote — identity survives renames, moves, and re-clones.
 */
export interface SandboxIdentity {
  /** Stable UUID. The key sandboxes are associated with. */
  id: string;
  /** Human-readable label shown in the UI. */
  name: string;
}

const FILE_NAME = ".sandbox";

function fileUri(root: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(root, FILE_NAME);
}

function deriveName(root: vscode.Uri): string {
  const parts = root.path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "workspace";
}

/** Read `.sandbox` if present and valid; otherwise undefined. */
export async function readIdentity(
  root: vscode.Uri
): Promise<SandboxIdentity | undefined> {
  try {
    const buf = await vscode.workspace.fs.readFile(fileUri(root));
    const json = JSON.parse(Buffer.from(buf).toString("utf8"));
    if (json && typeof json.id === "string") {
      return {
        id: json.id,
        name: typeof json.name === "string" ? json.name : deriveName(root),
      };
    }
  } catch {
    // missing or invalid — treat as no identity yet
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
  const identity: SandboxIdentity = { id: randomUUID(), name: deriveName(root) };
  const content = JSON.stringify(identity, null, 2) + "\n";
  await vscode.workspace.fs.writeFile(
    fileUri(root),
    Buffer.from(content, "utf8")
  );
  return identity;
}
