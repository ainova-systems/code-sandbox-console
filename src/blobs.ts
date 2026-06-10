import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

/**
 * Per-project secret cache (FR-051): values encrypted at rest as blob files under
 * `~/.sbx/`, named `<entry>.<service>.dpapi`. The SAME files are read by the generated
 * project CLI (FR-052) — the UI picker and shell automation share one store, which is
 * why this is not VS Code SecretStorage (unreachable from a shell).
 *
 * Windows-only for now: DPAPI via a PowerShell child process — a blob decrypts only for
 * the same OS user on the same machine. Other platforms degrade to "no cache" (prompt
 * every time), matching spec 006. Values flow through stdin/stdout pipes only — never
 * argv, never env vars, never logs.
 */

export interface BlobEntry {
  /** User-chosen entry name (defaults to the project name). */
  entry: string;
  /** Secret service id (github, ...). */
  service: string;
  /** Absolute blob file path. */
  file: string;
}

const SUFFIX = ".dpapi";

/**
 * Entry/service names become file-name components. The set must be a superset of what
 * sandbox-name sanitising can produce (incl. "+"), or project-derived entries written
 * by the extension could not be addressed again — or found by the generated CLI.
 */
const ENTRY_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** UI-side validation hook (input boxes) — the same rule assertEntryName() enforces. */
export function validEntryName(name: string): boolean {
  return ENTRY_RE.test(name);
}

export function assertEntryName(name: string): string {
  if (!ENTRY_RE.test(name)) {
    throw new Error(
      `invalid cache entry name "${name}" (use letters, digits and "._+-", starting with a letter or digit)`
    );
  }
  return name;
}

/**
 * EXACT mirror of sandbox.ts sanitize() (and the generated CLI's sanitize()) — the
 * script resolves the project blob as `sanitize(project_name)`, so any divergence
 * (e.g. "_" kept vs dashed, "+" dropped) would make the extension cache under a name
 * the shell chain never looks up.
 */
export function entrySafe(label: string): string {
  const safe = label
    .replace(/[^A-Za-z0-9.+-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+$/, "");
  return safe || "sandbox";
}

export function cacheSupported(): boolean {
  return process.platform === "win32";
}

function blobDir(): string {
  return path.join(os.homedir(), ".sbx");
}

function blobFile(entry: string, service: string): string {
  return path.join(
    blobDir(),
    `${assertEntryName(entry)}.${assertEntryName(service)}${SUFFIX}`
  );
}

/** All cached entries (names only — values stay encrypted), optionally per service. */
export async function listEntries(service?: string): Promise<BlobEntry[]> {
  if (!cacheSupported()) {
    return [];
  }
  let names: string[];
  try {
    names = await fs.readdir(blobDir());
  } catch {
    return []; // no ~/.sbx yet — empty cache
  }
  const out: BlobEntry[] = [];
  for (const n of names) {
    if (!n.endsWith(SUFFIX)) {
      continue;
    }
    // <entry>.<service>.dpapi — the entry may itself contain dots, so the service is
    // everything after the LAST remaining dot.
    const stem = n.slice(0, -SUFFIX.length);
    const dot = stem.lastIndexOf(".");
    if (dot <= 0 || dot === stem.length - 1) {
      continue;
    }
    const entry = stem.slice(0, dot);
    const svc = stem.slice(dot + 1);
    if (service && svc !== service) {
      continue;
    }
    // Skip foreign/legacy files that read/delete/rename could not address again — a
    // listed entry must always round-trip through blobFile()'s validation.
    if (!ENTRY_RE.test(entry) || !ENTRY_RE.test(svc)) {
      continue;
    }
    out.push({ entry, service: svc, file: path.join(blobDir(), n) });
  }
  return out.sort((a, b) => a.entry.localeCompare(b.entry));
}

interface PsResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run a PowerShell snippet with the blob path passed via the environment (never inside
 * the -Command string — paths with quotes must not be able to alter the script) and the
 * optional secret value piped over stdin.
 */
function runPs(script: string, file: string, input?: string): Promise<PsResult> {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, env: { ...process.env, SBX_BLOB_PATH: file } }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      resolve({ stdout, stderr: stderr || err.message, code: 1 })
    );
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.stdin.on("error", () => undefined);
    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

const PS_DECRYPT = [
  "$ErrorActionPreference='Stop'",
  "$raw=(Get-Content -LiteralPath $env:SBX_BLOB_PATH -Raw).Trim()",
  "$ss=ConvertTo-SecureString -String $raw",
  "$c=New-Object System.Net.NetworkCredential('', $ss)",
  "[Console]::Out.Write($c.Password)",
].join("; ");

const PS_ENCRYPT = [
  "$ErrorActionPreference='Stop'",
  "$v=[Console]::In.ReadToEnd().TrimEnd()",
  "$ss=ConvertTo-SecureString -String $v -AsPlainText -Force",
  "ConvertFrom-SecureString -SecureString $ss | Set-Content -LiteralPath $env:SBX_BLOB_PATH -Encoding ASCII",
].join("; ");

/** Decrypt one cached value, or undefined when absent/undecryptable (other user/machine). */
export async function readBlob(
  entry: string,
  service: string
): Promise<string | undefined> {
  if (!cacheSupported()) {
    return undefined;
  }
  const file = blobFile(entry, service);
  try {
    await fs.access(file);
  } catch {
    return undefined;
  }
  const { stdout, code } = await runPs(PS_DECRYPT, file);
  // PowerShell stdout may carry a BOM and a trailing newline — both would corrupt the
  // piped secret (the proxy then 401s every call), so strip them explicitly.
  const value = stdout.replace(/^\uFEFF/, "").replace(/[\r\n]+$/, "");
  return code === 0 && value ? value : undefined;
}

/** Encrypt and store one value (DPAPI, current OS user). Overwrites an existing entry. */
export async function writeBlob(
  entry: string,
  service: string,
  value: string
): Promise<void> {
  if (!cacheSupported()) {
    throw new Error("The secret cache is only available on Windows for now.");
  }
  const file = blobFile(entry, service);
  await fs.mkdir(blobDir(), { recursive: true });
  const { stderr, code } = await runPs(PS_ENCRYPT, file, value);
  if (code !== 0) {
    throw new Error(`could not store the cached secret: ${stderr.trim() || "PowerShell failed"}`);
  }
}

export async function deleteBlob(entry: string, service: string): Promise<void> {
  await fs.rm(blobFile(entry, service), { force: true });
}

/** DPAPI blobs are not bound to their file name, so a rename is a plain move. */
export async function renameBlob(
  entry: string,
  service: string,
  newEntry: string
): Promise<void> {
  await fs.rename(blobFile(entry, service), blobFile(newEntry, service));
}
