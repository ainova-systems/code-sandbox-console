import * as vscode from "vscode";
import { stringify } from "yaml";
import { CONFIG_DIR, SandboxSpec } from "./config";
import * as sbx from "./sbx";

/**
 * FR-060 lifecycle hooks, carried into the sandbox as an `sbx` **kit**.
 *
 * The recipe declares three lists of shell commands (`setup`, `startup`, `services`); this
 * module renders them into `.sandbox/kits/<key>/spec.yaml` and hands the directory to
 * `sbx create --kit`. sbx then owns the lifecycle: install commands run once at creation,
 * startup commands on every container start — before `sbx run` attaches the agent — and
 * backgrounded ones stay up, which is the restart policy sbx otherwise has no concept of.
 *
 * Why a kit and not `sbx exec` from `ops.ts`: the ordering guarantee (a hook finishes
 * before the agent exists) and the binding (a start from ANY surface — Explorer, the
 * generated CLI, a bare `sbx run` in someone's terminal — replays the hooks) are properties
 * of the sandbox, not of the button that was clicked. See spec 017.
 *
 * The kit is a **build artefact**: gitignored, regenerated from the recipe on every create,
 * never hand-edited. What the user maintains is `config.yaml` and whatever scripts the
 * commands point at.
 *
 * Schema note (spec 017): this targets the schema the installed CLI accepts
 * (`commands.install` / `commands.startup`, verified on v0.31.3), which is NOT the newer
 * `setup.*` shape on docs.docker.com. `sbx kit` is EXPERIMENTAL, so every create validates
 * the generated kit first (`assertValid`) and refuses with the CLI's own message rather
 * than failing inside `create`.
 */

const KITS_DIR = "kits";
const IGNORE_ENTRY = "kits/";

/** The read-only host working tree inside a `mount: clone` sandbox (Architecture §9). */
const CLONE_SOURCE = "/run/sandbox/source";

/** sbx runs hook commands as the unprivileged agent user (UID 1000), like the docs' kits. */
const AGENT_UID = "1000";

/** Does this sandbox declare any hook at all? Nothing below runs when it does not. */
export function hasHooks(spec: SandboxSpec): boolean {
  return (
    spec.setup.length > 0 ||
    spec.startup.length > 0 ||
    spec.services.length > 0
  );
}

/**
 * The environment every hook command sees, so one command line works under both mount
 * modes. `SANDBOX_WORKSPACE` is the workspace inside the sandbox — the bind mount under
 * `direct`, the private clone under `clone`, which sbx creates at the same mirrored host
 * path. `SANDBOX_SOURCE` is the host working tree: read-only at `/run/sandbox/source` under
 * `clone` (the only place the files git does not carry — `.env.local`, generated
 * configuration, data directories — can be read from), and the workspace itself under
 * `direct`, where host and sandbox already see one tree.
 *
 * Verified on v0.31.3: these reach install commands, startup commands AND the agent's own
 * shell, so a script run by hand later sees the same names.
 */
function hookVariables(
  spec: SandboxSpec,
  sandboxName: string,
  workspaceInside: string
): Record<string, string> {
  return {
    SANDBOX_WORKSPACE: workspaceInside,
    SANDBOX_SOURCE: spec.mount === "clone" ? CLONE_SOURCE : workspaceInside,
    SANDBOX_NAME: sandboxName,
    SANDBOX_KEY: spec.key,
  };
}

/**
 * Render the kit document. Pure, so the shape is reviewable in one place.
 *
 * `install` takes its command as a plain string (sbx runs it with `sh -c`), `startup` as an
 * argv array — an asymmetry of the CLI's schema, not a choice here. Startup commands go
 * through `bash -lc` so they get a login shell, matching what the user gets in a sandbox
 * terminal; setup commands are `sh` and this is stated in Features.md, since it is the one
 * place the two phases differ for whoever writes the command.
 */
export function renderKit(opts: {
  spec: SandboxSpec;
  sandboxName: string;
  workspaceInside: string;
}): string {
  const { spec, sandboxName, workspaceInside } = opts;
  const install = spec.setup.map((command, i) => ({
    command,
    user: AGENT_UID,
    description: `setup[${i + 1}] — ${spec.key}`,
  }));
  const startup = [
    ...spec.startup.map((command, i) => ({
      command: ["bash", "-lc", command],
      user: AGENT_UID,
      description: `startup[${i + 1}] — ${spec.key}`,
    })),
    ...spec.services.map((command, i) => ({
      command: ["bash", "-lc", command],
      user: AGENT_UID,
      background: true,
      description: `service[${i + 1}] — ${spec.key}`,
    })),
  ];
  const commands: Record<string, unknown> = {};
  if (install.length > 0) {
    commands.install = install;
  }
  if (startup.length > 0) {
    commands.startup = startup;
  }
  return stringify(
    {
      schemaVersion: "1",
      kind: "mixin",
      name: sandboxName,
      description: `Lifecycle hooks for ${spec.key} (FR-060)`,
      commands,
      environment: {
        variables: hookVariables(spec, sandboxName, workspaceInside),
      },
    },
    // A long command must stay on one line: YAML would fold it correctly, but the file is
    // read by humans debugging a hook, and a wrapped command line reads as two commands.
    { lineWidth: 0 }
  );
}

/**
 * The recipe key becomes a directory name under `.sandbox/kits/`, and `config.yaml` is
 * repo-controlled input — a key like `../../..` would steer a write (and `removeKit`'s
 * recursive delete) outside the project. Same containment rule the form applies to a
 * Dockerfile name (Architecture §9): letters, digits and `._-`, no separators, no leading
 * dot. The generated CLI is contained by construction — its recipe reader only recognises
 * keys of this shape.
 */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function kitDirUri(root: vscode.Uri, key: string): vscode.Uri {
  if (!KEY_RE.test(key)) {
    throw new Error(
      `.sandbox/config.yaml: "${key}" cannot name a sandbox — use only letters, digits and "._-", starting with a letter or digit (no path separators).`
    );
  }
  return vscode.Uri.joinPath(root, CONFIG_DIR, KITS_DIR, key);
}

/**
 * Keep the generated kits out of git. Appends to `.sandbox/.gitignore` (which identity.ts
 * may already have created for `identity.yaml`) instead of replacing it, and is a no-op
 * once the entry is there.
 */
async function ensureIgnored(root: vscode.Uri): Promise<void> {
  const uri = vscode.Uri.joinPath(root, CONFIG_DIR, ".gitignore");
  let text = "";
  try {
    text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    // absent — created below
  }
  if (text.split(/\r?\n/).some((line) => line.trim() === IGNORE_ENTRY)) {
    return;
  }
  const next = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  await vscode.workspace.fs.writeFile(
    uri,
    Buffer.from(`${next}${IGNORE_ENTRY}\n`, "utf8")
  );
}

/**
 * Write the sandbox's kit and return the directory to pass to `sbx create --kit`, or
 * undefined when the sandbox declares no hooks (then nothing is written and no `--kit` is
 * passed — a hookless sandbox behaves exactly as it did before FR-060).
 *
 * The kit is named after the sbx sandbox, which is what makes re-applying it replace its
 * dispatcher entry instead of stacking a second copy (`sbx kit add`, verified on v0.31.3).
 */
export async function ensureKit(
  root: vscode.Uri,
  opts: { spec: SandboxSpec; sandboxName: string; workspaceInside: string }
): Promise<string | undefined> {
  if (!hasHooks(opts.spec)) {
    return undefined;
  }
  const dir = kitDirUri(root, opts.spec.key);
  await vscode.workspace.fs.createDirectory(dir);
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(dir, "spec.yaml"),
    Buffer.from(renderKit(opts), "utf8")
  );
  await ensureIgnored(root);
  return dir.fsPath;
}

/** Drop a sandbox's generated kit — used when its recipe entry is removed. Best-effort. */
export async function removeKit(root: vscode.Uri, key: string): Promise<void> {
  try {
    await vscode.workspace.fs.delete(kitDirUri(root, key), {
      recursive: true,
      useTrash: false,
    });
  } catch {
    // never existed, or already gone
  }
}

/**
 * Refuse before anything is created if the generated kit is not something the installed
 * CLI accepts — the same preflight band as the UNC check (FR-040) and the shallow-repo
 * refusal (FR-058): what it prevents is cheaper to prevent than to explain afterwards. The
 * realistic trigger is not a typo in a command (the schema does not read those) but an sbx
 * release that renames the kit schema, which this turns into one legible sentence.
 */
export async function assertValid(kitDir: string): Promise<void> {
  const { ok, message } = await sbx.kitValidate(kitDir);
  if (ok) {
    return;
  }
  throw new Error(
    `The generated hook kit was rejected by sbx: ${message || "no detail"}\n\n` +
      "`sbx kit` is an experimental command — if this appeared after an sbx upgrade, its " +
      "kit schema has changed. Remove the setup/startup/services entries from " +
      ".sandbox/config.yaml to create this sandbox without hooks."
  );
}
