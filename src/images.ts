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

/**
 * Resolve a config-relative path and require it to stay inside the repo. The recipe is
 * committed (FR-009), so a malicious config.yaml must not be able to point `docker build`
 * at arbitrary host paths via absolute paths or `..` escapes.
 */
function resolveInsideRepo(
  repoRoot: string,
  base: string,
  rel: string,
  what: string
): string {
  if (path.isAbsolute(rel)) {
    throw new Error(
      `.sandbox/config.yaml: ${what} must be a relative path inside the repository, got "${rel}"`
    );
  }
  const abs = path.resolve(base, rel);
  const root = path.resolve(repoRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(
      `.sandbox/config.yaml: ${what} "${rel}" resolves outside the repository`
    );
  }
  return abs;
}

function resolvePaths(
  spec: SandboxSpec,
  repoRoot: string
): { dockerfile: string; context: string } {
  return {
    dockerfile: resolveInsideRepo(
      repoRoot,
      path.join(repoRoot, CONFIG_DIR),
      spec.dockerfile as string,
      "dockerfile"
    ),
    context: spec.context
      ? resolveInsideRepo(repoRoot, repoRoot, spec.context, "context")
      : repoRoot,
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
  sbx.assertImageTag(spec.image); // committed config → docker argv (FR-009)
  const { dockerfile, context } = resolvePaths(spec, repoRoot);
  const dfText = await fs
    .readFile(dockerfile, "utf8")
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        throw new Error(`Dockerfile not found: ${dockerfile}`);
      }
      throw err;
    });
  // Simple lint: a usable Dockerfile must declare a base image.
  if (!/^\s*FROM\s+\S+/im.test(dfText)) {
    throw new Error(
      `${spec.dockerfile} must start with a FROM line (extend a docker/sandbox-templates base image).`
    );
  }
  // --pull: re-fetch the FROM agent base so a rebuild never bakes onto a stale cached
  // base image (FR-053). A failed pull fails the build — same hard gate as the build.
  const build = await docker([
    "build",
    "--pull",
    "-t",
    spec.image,
    "-f",
    dockerfile,
    context,
  ]);
  if (build.code !== 0) {
    throw new Error(
      `docker build failed for ${spec.image}: ${
        build.stderr.trim() || build.stdout.trim()
      }`
    );
  }
  await saveAndLoad(spec.image);
}

/** `docker save` an image and `sbx template load` it into the sbx store (FR-008/FR-053). */
async function saveAndLoad(image: string): Promise<void> {
  const safe = image.replace(/[^A-Za-z0-9._-]/g, "_");
  const tar = path.join(os.tmpdir(), `sbx-tmpl-${safe}-${process.pid}.tar`);
  try {
    const save = await docker(["save", image, "-o", tar]);
    if (save.code !== 0) {
      throw new Error(`docker save failed for ${image}: ${save.stderr.trim()}`);
    }
    await sbx.templateLoad(tar);
  } finally {
    await fs.rm(tar, { force: true }).catch(() => undefined);
  }
}

/**
 * FR-053: make a rebuild start from the freshest obtainable image. Returns true when the
 * recreate that follows will use a fresh (or freshly-fetchable) image, false when the
 * refresh could not happen and the cached image remains — the caller warns, never fails:
 * a rebuild that still works offline beats one that refuses.
 *
 * - `dockerfile` set → nothing to do here; `buildAndLoad` pulls the base via `--pull`.
 * - `image` only → `docker pull` + reload into the store. The stored template is never
 *   removed: a local-only image (loaded by hand) would be unrecoverable after `rm`.
 * - default agent image → remove the matching `docker/sandbox-templates` entries
 *   (flavor prefixed by the agent id) so the next create re-pulls; these are registry
 *   images by definition, so removal is safe.
 */
export async function refreshForRebuild(spec: SandboxSpec): Promise<boolean> {
  try {
    if (spec.dockerfile) {
      return true;
    }
    if (spec.image) {
      if (!(await dockerAvailable())) {
        return false;
      }
      sbx.assertImageTag(spec.image);
      if ((await docker(["pull", spec.image])).code !== 0) {
        return false;
      }
      await saveAndLoad(spec.image);
      return true;
    }
    const listed = await sbx.templateList();
    if (listed === null) {
      return false; // listing failed — the cache state is unknown, so report no refresh
    }
    const targets = new Set(
      listed
        .filter(
          (t) =>
            // Prefix, not equality: one agent ships several flavors (e.g. versioned
            // variants of its base), all starting with the agent id.
            t.repository === "docker/sandbox-templates" &&
            t.flavor.startsWith(spec.agent)
        )
        .map((t) => `${t.repository}:${t.tag}`)
        // A row that fails the argv allowlist (e.g. a dangling "<none>" tag) is not
        // removable anyway — skip it instead of reporting a failed refresh.
        .filter((tag) => {
          try {
            sbx.assertImageTag(tag);
            return true;
          } catch {
            return false;
          }
        })
    );
    if (targets.size === 0) {
      return true; // nothing cached — the create pulls the current image anyway
    }
    let ok = true;
    for (const tag of targets) {
      try {
        await sbx.templateRemove(tag);
      } catch {
        ok = false; // stays cached; the create reuses it
      }
    }
    return ok;
  } catch {
    return false;
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
