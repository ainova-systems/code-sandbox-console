import * as vscode from "vscode";
import { parse, stringify } from "yaml";

/**
 * The committed, shared sandbox recipe (FR-009). Lives at `.sandbox/config.yaml`,
 * compose-like and YAML, so it travels with the repo (clones/copies). Identity (the
 * local label) is kept separately and gitignored — see identity.ts.
 *
 * This module only models and parses the recipe. Mapping it to `sbx` lives in sbx.ts /
 * sandbox.ts (the only CLI shapers).
 */

/** Filesystem policy for a sandbox (ARCHITECTURE §9). */
export type MountMode = "direct" | "clone";

/**
 * One sandbox entry in the recipe. Compose-like: `image` is the tag to run with
 * (`sbx ... -t <image>`); if `dockerfile` is also set, the extension builds that
 * Dockerfile (resolved under `.sandbox/`) and tags it as `image` before use (FR-008).
 */
export interface SandboxSpec {
  /** Logical key in the recipe; also the sandbox-name suffix (`<name>-<key>`). */
  key: string;
  /** sbx agent id: claude / shell / codex / opencode / ... */
  agent: string;
  /** Optional display name shown in the Explorer (falls back to key). */
  title?: string;
  /** Optional group label for organising sandboxes in the Explorer. */
  group?: string;
  /** Optional custom image tag. Required when `dockerfile` is set. */
  image?: string;
  /** Optional Dockerfile path relative to `.sandbox/`; set → build `image` from it. */
  dockerfile?: string;
  /** Optional docker build context, relative to the repo root. Default: repo root. */
  context?: string;
  /** Filesystem policy. Default "direct". */
  mount: MountMode;
  /** Service-secret names to provision (values via `sbx secret set`, never here). */
  secrets: string[];
  /** Ports to publish from the sandbox. */
  ports: number[];
}

/** The parsed `.sandbox/config.yaml` recipe. */
export interface SandboxConfig {
  version: number;
  /** Shared project label; the sbx sandbox name is `<name>-<key>-<id>` (id is local). */
  name?: string;
  /** Sandbox specs in the order they appear in the YAML map. */
  sandboxes: SandboxSpec[];
}

export const CONFIG_DIR = ".sandbox";
export const CONFIG_FILE = "config.yaml";

/** Raised for malformed recipes; readConfig() rewraps it with the file path. */
class ConfigError extends Error {}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${what} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${what} must be a non-empty string`);
  }
  return value;
}

function optString(value: unknown, what: string): string | undefined {
  return value === undefined ? undefined : asString(value, what);
}

function asStringArray(value: unknown, what: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ConfigError(`${what} must be a list of strings`);
  }
  return value as string[];
}

function asNumberArray(value: unknown, what: string): number[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== "number")) {
    throw new ConfigError(`${what} must be a list of numbers`);
  }
  return value as number[];
}

function parseMount(value: unknown, what: string): MountMode {
  if (value === undefined || value === "direct") {
    return "direct";
  }
  if (value === "clone") {
    return "clone";
  }
  throw new ConfigError(`${what} must be "direct" or "clone"`);
}

function parseSpec(key: string, raw: unknown): SandboxSpec {
  const at = `sandboxes.${key}`;
  const obj = asRecord(raw, at);
  const image = optString(obj.image, `${at}.image`);
  const dockerfile = optString(obj.dockerfile, `${at}.dockerfile`);
  if (dockerfile && !image) {
    throw new ConfigError(
      `${at}: "image" (the tag to build) is required when "dockerfile" is set`
    );
  }
  return {
    key,
    agent: asString(obj.agent, `${at}.agent`),
    title: optString(obj.title, `${at}.title`),
    group: optString(obj.group, `${at}.group`),
    image,
    dockerfile,
    context: optString(obj.context, `${at}.context`),
    mount: parseMount(obj.mount, `${at}.mount`),
    secrets: asStringArray(obj.secrets, `${at}.secrets`),
    ports: asNumberArray(obj.ports, `${at}.ports`),
  };
}

/** Parse recipe text. Throws ConfigError with a descriptive message on malformed input. */
export function parseConfig(text: string): SandboxConfig {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new ConfigError(
      `invalid YAML: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (doc === null || doc === undefined) {
    throw new ConfigError("empty config");
  }
  const root = asRecord(doc, "config");
  const version = typeof root.version === "number" ? root.version : 1;
  const name = typeof root.name === "string" ? root.name : undefined;
  const sandboxesRaw = asRecord(root.sandboxes ?? {}, "sandboxes");
  const sandboxes = Object.keys(sandboxesRaw).map((key) =>
    parseSpec(key, sandboxesRaw[key])
  );
  if (sandboxes.length === 0) {
    throw new ConfigError("no sandboxes defined");
  }
  return { version, name, sandboxes };
}

function configUri(root: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(root, CONFIG_DIR, CONFIG_FILE);
}

/**
 * Read `.sandbox/config.yaml` if present. Returns undefined when the file is absent
 * (callers fall back to the default single-Claude behaviour). Throws a descriptive
 * Error when the file exists but is malformed.
 */
export async function readConfig(
  root: vscode.Uri
): Promise<SandboxConfig | undefined> {
  let buf: Uint8Array;
  try {
    buf = await vscode.workspace.fs.readFile(configUri(root));
  } catch {
    return undefined; // absent — not an error
  }
  try {
    return parseConfig(Buffer.from(buf).toString("utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`.sandbox/config.yaml: ${msg}`);
  }
}

/** Serialise the recipe back to `.sandbox/config.yaml` (compose-like map form). FR-009. */
export async function writeConfig(
  root: vscode.Uri,
  config: SandboxConfig
): Promise<void> {
  const sandboxes: Record<string, Record<string, unknown>> = {};
  for (const s of config.sandboxes) {
    const entry: Record<string, unknown> = { agent: s.agent };
    if (s.title) {
      entry.title = s.title;
    }
    if (s.group) {
      entry.group = s.group;
    }
    if (s.image) {
      entry.image = s.image;
    }
    if (s.dockerfile) {
      entry.dockerfile = s.dockerfile;
    }
    if (s.context) {
      entry.context = s.context;
    }
    if (s.mount !== "direct") {
      entry.mount = s.mount;
    }
    if (s.secrets.length > 0) {
      entry.secrets = s.secrets;
    }
    if (s.ports.length > 0) {
      entry.ports = s.ports;
    }
    sandboxes[s.key] = entry;
  }
  const doc: Record<string, unknown> = { version: config.version || 1 };
  if (config.name) {
    doc.name = config.name;
  }
  doc.sandboxes = sandboxes;
  const text = stringify(doc);
  await vscode.workspace.fs.createDirectory(
    vscode.Uri.joinPath(root, CONFIG_DIR)
  );
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(root, CONFIG_DIR, CONFIG_FILE),
    Buffer.from(text, "utf8")
  );
}

/** Remove one sandbox from the recipe; delete config.yaml entirely if it becomes empty. */
export async function removeFromConfig(
  root: vscode.Uri,
  key: string
): Promise<void> {
  const config = await readConfig(root).catch(() => undefined);
  if (!config) {
    return;
  }
  const sandboxes = config.sandboxes.filter((s) => s.key !== key);
  if (sandboxes.length === 0) {
    try {
      await vscode.workspace.fs.delete(configUri(root));
    } catch {
      // already gone
    }
    return;
  }
  await writeConfig(root, {
    version: config.version || 1,
    name: config.name,
    sandboxes,
  });
}
