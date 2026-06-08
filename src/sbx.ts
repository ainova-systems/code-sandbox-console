import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs";

const pexec = promisify(execFile);

let cachedPath: string | undefined;

/**
 * Resolve the `sbx` executable. On Windows the installer puts it under
 * %LOCALAPPDATA%\DockerSandboxes\bin but does NOT add it to PATH, so we look
 * there first and fall back to the bare command name (PATH installs on
 * macOS/Linux). The resolved path is also used as a terminal shellPath.
 */
export function sbxPath(): string {
  if (cachedPath) {
    return cachedPath;
  }
  const candidates: string[] = [];
  const local = process.env.LOCALAPPDATA;
  if (local) {
    candidates.push(path.join(local, "DockerSandboxes", "bin", "sbx.exe"));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      cachedPath = candidate;
      return cachedPath;
    }
  }
  cachedPath = process.platform === "win32" ? "sbx.exe" : "sbx";
  return cachedPath;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(args: string[]): Promise<RunResult> {
  return pexec(sbxPath(), args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
    .then(({ stdout, stderr }) => ({
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      code: 0,
    }))
    .catch((err: NodeJS.ErrnoException & { stdout?: Buffer; stderr?: Buffer }) => ({
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? err.message,
      code: typeof err.code === "number" ? err.code : 1,
    }));
}

/** True if the sbx CLI is invokable (does not imply the user is signed in). */
export async function available(): Promise<boolean> {
  const { code } = await run(["version"]);
  return code === 0;
}

export interface SandboxInfo {
  name: string;
  agent: string;
  /** "running" | "stopped" | other transient states. */
  status: string;
  workspaces: string[];
}

/** Parse `sbx ls --json` (FR-002 discovery). Throws on CLI failure. */
export async function list(): Promise<SandboxInfo[]> {
  const { stdout, stderr, code } = await run(["ls", "--json"]);
  if (code !== 0) {
    throw new Error(stderr.trim() || "sbx ls failed");
  }
  try {
    const parsed = JSON.parse(stdout) as { sandboxes?: SandboxInfo[] };
    return Array.isArray(parsed.sandboxes) ? parsed.sandboxes : [];
  } catch {
    return [];
  }
}

export type SandboxState = "absent" | "running" | "stopped";

export async function stateOf(name: string): Promise<SandboxState> {
  const found = (await list()).find((s) => s.name === name);
  if (!found) {
    return "absent";
  }
  return found.status === "running" ? "running" : "stopped";
}

export interface CreateOpts {
  name: string;
  agent: string;
  /** Host path mounted as the sandbox workspace (FR-040). */
  workspace: string;
  /** --clone: private in-container clone, host repo mounted read-only (FS policy). */
  clone?: boolean;
}

/** Create a sandbox without attaching (FR-003). */
export async function create(opts: CreateOpts): Promise<void> {
  const args = ["create", "--name", opts.name];
  if (opts.clone) {
    args.push("--clone");
  }
  args.push(opts.agent, opts.workspace);
  const { stderr, code } = await run(args);
  if (code !== 0) {
    throw new Error(stderr.trim() || `sbx create failed for ${opts.name}`);
  }
}

/** Stop a sandbox, retaining all state; resume later with `sbx run` (FR-006). */
export async function stop(name: string): Promise<void> {
  const { stderr, code } = await run(["stop", name]);
  if (code !== 0) {
    throw new Error(stderr.trim() || `sbx stop failed for ${name}`);
  }
}

/**
 * Translate a host path to its in-sandbox mount path. On Windows, sbx mounts
 * each host drive at /<drive-letter>, so D:\Repositories\app -> /d/Repositories/app.
 * Non-Windows paths are already POSIX and pass through. Used for `exec -w` to
 * drop a shell into the workspace (FR-040).
 */
export function hostToSandboxPath(hostPath: string): string {
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(hostPath);
  if (win) {
    return `/${win[1].toLowerCase()}/${win[2].replace(/\\/g, "/")}`;
  }
  return hostPath.replace(/\\/g, "/");
}

/** Remove a sandbox and all its state — destructive (FR-007 / Delete). */
export async function remove(name: string): Promise<void> {
  const { stderr, code } = await run(["rm", "--force", name]);
  if (code !== 0) {
    throw new Error(stderr.trim() || `sbx rm failed for ${name}`);
  }
}
