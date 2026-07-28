import { execFile, spawn } from "child_process";
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

/**
 * Argv allowlists: sandbox names, agent ids, image tags and secret services originate in
 * the committed `.sandbox/config.yaml` (FR-009), so a malicious repo controls them. All
 * CLI calls use execFile/spawn (no shell), which leaves option injection as the smuggling
 * vector — every such value must match a conservative pattern and must never start with
 * "-". Throw a descriptive error; never sanitize silently.
 */
const SANDBOX_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IMAGE_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
const SECRET_SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Validate a sandbox name before it enters argv; returns it for chaining. */
export function assertSandboxName(name: string): string {
  if (!SANDBOX_NAME_RE.test(name)) {
    throw new Error(
      `invalid sandbox name "${name}" (must start with a letter or digit; then letters, digits, "._+-")`
    );
  }
  return name;
}

/** Validate an agent id (claude, codex, ...) before it enters argv. */
export function assertAgentId(agent: string): string {
  if (!AGENT_ID_RE.test(agent)) {
    throw new Error(
      `invalid agent id "${agent}" (must start with a letter or digit; then letters, digits, "._-")`
    );
  }
  return agent;
}

/** Validate an image tag/ref before it enters argv. */
export function assertImageTag(image: string): string {
  if (!IMAGE_TAG_RE.test(image)) {
    throw new Error(
      `invalid image tag "${image}" (must start with a letter or digit; then letters, digits, "._:/@-")`
    );
  }
  return image;
}

/** Validate a secret service id (anthropic, github, ...) before it enters argv. */
export function assertSecretService(service: string): string {
  if (!SECRET_SERVICE_RE.test(service)) {
    throw new Error(
      `invalid secret service "${service}" (must start with a letter or digit; then letters, digits, "._-")`
    );
  }
  return service;
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
  /** -t custom image tag (FR-008). Must already be in the sbx store (build/load first). */
  image?: string;
}

/** Create a sandbox without attaching (FR-003). */
export async function create(opts: CreateOpts): Promise<void> {
  const args = ["create", "--name", assertSandboxName(opts.name)];
  if (opts.clone) {
    args.push("--clone");
  }
  if (opts.image) {
    args.push("-t", assertImageTag(opts.image));
  }
  args.push(assertAgentId(opts.agent), opts.workspace);
  const { stderr, code } = await run(args);
  if (code !== 0) {
    throw new Error(stderr.trim() || `sbx create failed for ${opts.name}`);
  }
}

/** Stop a sandbox, retaining all state; resume later with `sbx run` (FR-006). */
export async function stop(name: string): Promise<void> {
  const { stderr, code } = await run(["stop", assertSandboxName(name)]);
  if (code !== 0) {
    throw new Error(stderr.trim() || `sbx stop failed for ${name}`);
  }
}

/**
 * Translate a host path to its in-sandbox mount path. On Windows, sbx mounts
 * each host drive at /<drive-letter>, so D:\Repositories\app -> /d/Repositories/app.
 * Non-Windows paths are already POSIX and pass through. Used for `exec -w` to
 * drop a shell into the workspace (FR-040). Throws for UNC / \\wsl$ paths, which
 * have no drive-letter mount inside the sandbox.
 */
export function hostToSandboxPath(hostPath: string): string {
  // UNC and \\wsl$ paths have no drive-letter mount; converting them blindly yields a
  // plausible-looking but nonexistent in-sandbox path, so fail loudly instead.
  if (/^[\\/]{2}/.test(hostPath)) {
    throw new Error(
      `Workspaces on network/WSL paths are not supported by Docker Sandboxes: ${hostPath} — open the folder from a local drive.`
    );
  }
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(hostPath);
  if (win) {
    return `/${win[1].toLowerCase()}/${win[2].replace(/\\/g, "/")}`;
  }
  return hostPath.replace(/\\/g, "/");
}

/** Remove a sandbox and all its state — destructive (FR-007 / Delete). */
export async function remove(name: string): Promise<void> {
  const { stderr, code } = await run(["rm", "--force", assertSandboxName(name)]);
  if (code !== 0) {
    throw new Error(stderr.trim() || `sbx rm failed for ${name}`);
  }
}

/** Agents available out of the box (fallback if live discovery fails). */
const STATIC_AGENTS = [
  "claude", "codex", "copilot", "cursor", "docker-agent",
  "droid", "gemini", "kiro", "opencode", "shell",
];

/** Secret services supported out of the box (fallback if live discovery fails). */
const STATIC_SECRET_SERVICES = [
  "anthropic", "aws", "bedrock", "cursor", "droid", "github",
  "google", "groq", "mistral", "nebius", "openai", "xai",
];

/** Extract a "Label: a, b, c" list out of CLI --help text. */
function parseHelpList(label: string, text: string): string[] {
  const needle = label.toLowerCase() + ":";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.toLowerCase().startsWith(needle)) {
      return line
        .slice(label.length + 1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [];
}

/**
 * Agents the installed sbx supports, discovered from `sbx run --help` so the create form
 * always matches the local version; falls back to the static list if discovery fails.
 */
export async function listAgents(): Promise<string[]> {
  const { stdout, stderr, code } = await run(["run", "--help"]);
  if (code === 0) {
    const found = parseHelpList("Available agents", stdout + "\n" + stderr);
    if (found.length > 0) {
      return found;
    }
  }
  return [...STATIC_AGENTS];
}

/**
 * Secret services the installed sbx supports, discovered from `sbx secret set --help`;
 * falls back to the static list if discovery fails. Drives the Secrets tab (FR-032).
 */
export async function listSecretServices(): Promise<string[]> {
  const { stdout, stderr, code } = await run(["secret", "set", "--help"]);
  if (code === 0) {
    const found = parseHelpList("Available services", stdout + "\n" + stderr);
    if (found.length > 0) {
      return found;
    }
  }
  return [...STATIC_SECRET_SERVICES];
}

/** Load a template image tar into the sbx runtime image store (FR-008). */
export async function templateLoad(tarPath: string): Promise<void> {
  const { stderr, code } = await run(["template", "load", tarPath]);
  if (code !== 0) {
    throw new Error(stderr.trim() || `sbx template load failed for ${tarPath}`);
  }
}

/** True if a template tagged <repo>:<tag> is present in the sbx store. */
export async function templateExists(imageTag: string): Promise<boolean> {
  const { stdout, code } = await run(["template", "ls"]);
  if (code !== 0) {
    return false;
  }
  // Image refs are [host[:port]/]repo[:tag][@digest]: drop any digest, then treat the
  // last ':' as the tag separator only when it follows the last '/' (a registry port
  // like localhost:5000/img must not be mistaken for a tag).
  const at = imageTag.indexOf("@");
  const base = at >= 0 ? imageTag.slice(0, at) : imageTag;
  const colon = base.lastIndexOf(":");
  const hasTag = colon > base.lastIndexOf("/");
  const repo = hasTag ? base.slice(0, colon) : base;
  const tag = hasTag ? base.slice(colon + 1) : "latest";
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] === repo && cols[1] === tag) {
      return true;
    }
  }
  return false;
}

export interface TemplateInfo {
  repository: string;
  tag: string;
  flavor: string;
}

/**
 * Parse `sbx template ls` (FR-053). Columns: REPOSITORY, TAG, IMAGE ID, FLAVOR, CREATED;
 * duplicate repo:tag rows can appear (superseded image ids). Returns null on CLI
 * failure so callers can tell "store is empty" from "listing failed".
 */
export async function templateList(): Promise<TemplateInfo[] | null> {
  const { stdout, code } = await run(["template", "ls"]);
  if (code !== 0) {
    return null;
  }
  const rows: TemplateInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[0] === "REPOSITORY") {
      continue;
    }
    rows.push({ repository: cols[0], tag: cols[1], flavor: cols[3] });
  }
  return rows;
}

/**
 * Remove a template image from the sbx store so the next create re-pulls it (FR-053).
 * Only for registry-pullable images (the docker/sandbox-templates defaults) — removing a
 * local-only template would be unrecoverable.
 */
export async function templateRemove(tag: string): Promise<void> {
  const { stderr, code } = await run(["template", "rm", assertImageTag(tag)]);
  if (code !== 0) {
    throw new Error(stderr.trim() || `sbx template rm failed for ${tag}`);
  }
}

export interface SecretEntry {
  /** "global" or a sandbox name. */
  scope: string;
  /** Service id (anthropic, github, ...). */
  service: string;
}

/** Parse `sbx secret ls` to learn which secrets exist and at what scope (FR-032). */
export async function listSecrets(): Promise<SecretEntry[]> {
  const { stdout, code } = await run(["secret", "ls"]);
  if (code !== 0) {
    return [];
  }
  const entries: SecretEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3 || cols[0] === "SCOPE") {
      continue;
    }
    entries.push({
      scope: cols[0] === "(global)" ? "global" : cols[0],
      service: cols[2],
    });
  }
  return entries;
}

/** Run sbx with a value piped on stdin (keeps secrets out of argv/shell history). */
function runWithStdin(args: string[], input: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(sbxPath(), args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) =>
      resolve({ stdout, stderr: stderr || err.message, code: 1 })
    );
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.stdin.on("error", () => undefined); // ignore EPIPE if the process exits early
    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Provision a service secret via stdin: `sbx secret set [-g | <sandbox>] <service>`
 * (the value is piped, never in argv). Scope "global" → all sandboxes; otherwise a
 * specific sandbox name (which must already exist). FR-032.
 */
export async function secretSet(opts: {
  service: string;
  scope: "global" | string;
  value: string;
}): Promise<void> {
  const args = ["secret", "set"];
  if (opts.scope === "global") {
    args.push("-g");
  } else {
    args.push(assertSandboxName(opts.scope));
  }
  args.push(assertSecretService(opts.service));
  const { stderr, code } = await runWithStdin(args, opts.value);
  if (code !== 0) {
    throw new Error(stderr.trim() || `sbx secret set ${opts.service} failed`);
  }
}

/** Publish a sandbox port to the host (host:sandbox 1:1). Sandbox must be running. */
export async function publishPort(name: string, port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port ${port} (must be an integer in 1-65535)`);
  }
  const { stderr, code } = await run([
    "ports",
    assertSandboxName(name),
    "--publish",
    `${port}:${port}`,
  ]);
  if (code !== 0) {
    throw new Error(stderr.trim() || `sbx ports failed for ${name}`);
  }
}

/** Run `sbx exec -i <name> <command...>` with `input` piped to the command's stdin. */
function execWithStdin(
  name: string,
  command: string[],
  input: string
): Promise<RunResult> {
  return runWithStdin(["exec", "-i", assertSandboxName(name), ...command], input);
}

/** Best-effort: does a command exist inside the sandbox? (auto-starts it if stopped). */
export async function sandboxHasCommand(
  name: string,
  cmd: string
): Promise<boolean> {
  // `cmd` is interpolated into a `bash -lc` string — the one shell-interpreted slot in
  // this module — so hold it to the same allowlist as the other argv values.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cmd)) {
    throw new Error(`invalid command name "${cmd}"`);
  }
  const { code } = await run([
    "exec",
    assertSandboxName(name),
    "bash",
    "-lc",
    `command -v ${cmd}`,
  ]);
  return code === 0;
}

/**
 * Log the `gh` CLI into the sandbox with a token piped over stdin (token never in argv) —
 * replicates `gh auth login --with-token`. Throws on failure; callers treat it as
 * best-effort. This puts the token inside the sandbox (gh's own config), unlike the
 * proxy-managed `github` service secret which keeps it host-side.
 */
export async function ghAuthLogin(name: string, token: string): Promise<void> {
  const { stderr, code } = await execWithStdin(
    name,
    ["bash", "-lc", "gh auth login --with-token"],
    token
  );
  if (code !== 0) {
    throw new Error(stderr.trim() || "gh auth login failed");
  }
}
