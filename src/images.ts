import { execFile } from "child_process";
import { promisify } from "util";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import { CONFIG_DIR, SandboxSpec } from "./config";
import * as sbx from "./sbx";

/**
 * Custom-image pipeline (FR-008), verified live: a recipe `dockerfile` is built with host
 * docker (FROM an agent base), exported via `docker save`, and loaded into the sbx runtime
 * image store with `sbx template load`. The sbx store is separate from host docker, so the
 * save→load bridge is required; afterwards `sbx run/create -t <image>` uses it.
 */

const pexec = promisify(execFile);

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

let cachedDocker: string | undefined;

/**
 * Resolve the docker executable. Docker Desktop on Windows isn't always on the PATH that
 * execFile sees, so check its default install location first; fall back to the bare name.
 */
function dockerPath(): string {
  if (cachedDocker) {
    return cachedDocker;
  }
  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles;
    const candidate = pf
      ? path.join(pf, "Docker", "Docker", "resources", "bin", "docker.exe")
      : undefined;
    if (candidate && existsSync(candidate)) {
      cachedDocker = candidate;
      return cachedDocker;
    }
  }
  cachedDocker = process.platform === "win32" ? "docker.exe" : "docker";
  return cachedDocker;
}

function docker(args: string[]): Promise<RunResult> {
  return pexec(dockerPath(), args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    .then(({ stdout, stderr }) => ({
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      code: 0,
    }))
    .catch(
      (err: NodeJS.ErrnoException & { stdout?: Buffer; stderr?: Buffer }) => ({
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? err.message,
        code: typeof err.code === "number" ? err.code : 1,
      })
    );
}

/** True if host docker is invokable (required to build custom images). */
export async function dockerAvailable(): Promise<boolean> {
  const { code } = await docker(["--version"]);
  return code === 0;
}

function resolvePaths(
  spec: SandboxSpec,
  repoRoot: string
): { dockerfile: string; context: string } {
  return {
    dockerfile: path.join(repoRoot, CONFIG_DIR, spec.dockerfile as string),
    context: spec.context ? path.join(repoRoot, spec.context) : repoRoot,
  };
}

/** Build the spec's image from its Dockerfile and load it into the sbx store (FR-008). */
export async function buildAndLoad(
  spec: SandboxSpec,
  repoRoot: string
): Promise<void> {
  if (!spec.image || !spec.dockerfile) {
    return;
  }
  const { dockerfile, context } = resolvePaths(spec, repoRoot);
  // Simple lint: a usable Dockerfile must declare a base image.
  const dfText = await fs.readFile(dockerfile, "utf8").catch(() => "");
  if (!/^\s*FROM\s+\S+/im.test(dfText)) {
    throw new Error(
      `${spec.dockerfile} must start with a FROM line (extend a docker/sandbox-templates base image).`
    );
  }
  const build = await docker(["build", "-t", spec.image, "-f", dockerfile, context]);
  if (build.code !== 0) {
    throw new Error(
      `docker build failed for ${spec.image}: ${
        build.stderr.trim() || build.stdout.trim()
      }`
    );
  }
  const safe = spec.image.replace(/[^A-Za-z0-9._-]/g, "_");
  const tar = path.join(os.tmpdir(), `sbx-tmpl-${safe}-${process.pid}.tar`);
  try {
    const save = await docker(["save", spec.image, "-o", tar]);
    if (save.code !== 0) {
      throw new Error(`docker save failed for ${spec.image}: ${save.stderr.trim()}`);
    }
    await sbx.templateLoad(tar);
  } finally {
    await fs.rm(tar, { force: true }).catch(() => undefined);
  }
}

/**
 * Ensure the spec's custom image is in the sbx store, building it if missing (or always
 * when `rebuild`). No-op for the default agent image, or for an `image` without a
 * `dockerfile` (assumed pullable / already present — sbx pulls it on create).
 */
export async function ensureImage(
  spec: SandboxSpec,
  repoRoot: string,
  opts?: { rebuild?: boolean }
): Promise<void> {
  if (!spec.image || !spec.dockerfile) {
    return;
  }
  if (!opts?.rebuild && (await sbx.templateExists(spec.image))) {
    return;
  }
  if (!(await dockerAvailable())) {
    throw new Error(
      "Docker is required to build a custom sandbox image, but `docker` was not found on PATH."
    );
  }
  await buildAndLoad(spec, repoRoot);
}
