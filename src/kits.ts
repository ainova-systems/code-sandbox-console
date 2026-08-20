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

/** Where the runner script records what it did; read back by ops.ts (FR-060). */
export const HOOKS_LOG = "/tmp/sandbox-console-hooks.log";

/** The generated runner, relative to the repository root. */
function runnerPath(key: string): string {
  return `.sandbox/${KITS_DIR}/${key}/startup.sh`;
}

/** Quote a value for single-quoted bash: the only escape inside one is `'\''`. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The one startup command the kit carries (spec 018). sbx binds a startup command when the
 * sandbox is created and replays it verbatim forever, so what it must contain is not the
 * user's commands — those would be frozen with it — but a **bootstrap** that runs the
 * generated script. The script is rewritten from the recipe before every start, which is
 * what makes "edit, restart, applied" true.
 *
 * It is read from `$SANDBOX_SOURCE`, the host working tree: under `mount: clone` that is the
 * read-only mount, the only copy guaranteed to be current (the clone is a snapshot of git
 * history and the kit directory is gitignored anyway).
 *
 * A missing script is a **loud** failure rather than a silent hookless start: the directory
 * is a generated artefact, so a fresh clone legitimately lacks it, and the fix is one action.
 */
function bootstrapCommand(key: string): string[] {
  // The key is interpolated into a shell command that runs inside the sandbox, so hold it to
  // the same containment rule as the directory it names (`kitDirUri`, below). ensureKit
  // already checks it there; this keeps the guarantee if `renderKit` is called on its own.
  assertKey(key);
  const script = `"$SANDBOX_SOURCE"/${runnerPath(key)}`;
  return [
    "bash",
    "-lc",
    `if [ -f ${script} ]; then bash ${script}; else ` +
      `echo "Sandbox Console: ${runnerPath(key)} is missing, so this sandbox started ` +
      `without its lifecycle hooks. Connect it from VS Code (or run .sandbox/scripts/sbx.sh ` +
      `connect ${key}) to regenerate the file, then restart." >&2; exit 1; fi`,
  ];
}

/**
 * Render the kit document. Pure, so the shape is reviewable in one place.
 *
 * `install` takes its command as a plain string (sbx runs it with `sh -c`), `startup` as an
 * argv array — an asymmetry of the CLI's schema, not a choice here. `setup` commands are
 * still baked in literally: install is a creation-time phase, so freezing them changes
 * nothing (a changed `setup` list is what Rebuild is for).
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
  const commands: Record<string, unknown> = {};
  if (install.length > 0) {
    commands.install = install;
  }
  if (spec.startup.length > 0 || spec.services.length > 0) {
    commands.startup = [
      {
        command: bootstrapCommand(spec.key),
        user: AGENT_UID,
        description: `lifecycle hooks — ${spec.key}`,
      },
    ];
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

function assertKey(key: string): string {
  if (!KEY_RE.test(key)) {
    throw new Error(
      `.sandbox/config.yaml: "${key}" cannot name a sandbox — use only letters, digits and "._-", starting with a letter or digit (no path separators).`
    );
  }
  return key;
}

/**
 * The generated runner script: the recipe's `startup` and `services` as bash, rewritten
 * before every start (spec 018) — this file, not the kit, is what a restart picks up.
 *
 * It reproduces the semantics sbx's own dispatcher has, because users were told those:
 * commands run in order, a failure **stops the rest** and is recorded with its exit code,
 * and services are left running in the background. The log is truncated at the top of every
 * run, so whatever is in it always describes the current start and nothing older — which is
 * also what lets `ops.reportStartupHooks` read it without dating anything.
 */
export function renderRunner(spec: SandboxSpec): string {
  const lines = [
    "#!/usr/bin/env bash",
    `# Generated by Sandbox Console for "${spec.key}" (FR-060, spec 018).`,
    "# Rewritten from .sandbox/config.yaml before every start — edits here are lost.",
    "",
    `LOG=${HOOKS_LOG}`,
    ': > "$LOG"',
    "say() { printf '%s\\n' \"$*\" >> \"$LOG\"; }",
    "",
    "run() { # <label> <command> — a failure stops the run, like sbx's own dispatcher",
    '  if bash -lc "$2" >> "$LOG" 2>&1; then',
    '    say "ok $1"',
    "  else",
    "    code=$?",
    '    say "fail $1 exit=$code"',
    '    say "=== hooks end failed"',
    '    exit "$code"',
    "  fi",
    "}",
    "",
    "service() { # <label> <command> <output file> — detached, survives this script",
    "  if command -v setsid >/dev/null 2>&1; then",
    '    setsid bash -lc "$2" > "$3" 2>&1 < /dev/null &',
    "  else",
    '    nohup bash -lc "$2" > "$3" 2>&1 < /dev/null &',
    "  fi",
    "  pid=$!",
    "  # A service that dies on the spot must not be reported as running: give it a moment,",
    "  # then say so with the output that explains why. It does not stop the remaining hooks.",
    "  sleep 1",
    '  if kill -0 "$pid" 2>/dev/null; then',
    '    say "started $1 pid=$pid (output: $3)"',
    "  else",
    '    say "fail $1 exited immediately"',
    '    sed "s/^/    | /" "$3" >> "$LOG" 2>/dev/null',
    "    dead=$((dead + 1))",
    "  fi",
    "}",
    "dead=0",
    "",
    `say "=== hooks begin ${spec.key}"`,
  ];
  spec.startup.forEach((command, i) =>
    lines.push(`run 'startup[${i + 1}]' ${shellQuote(command)}`)
  );
  spec.services.forEach((command, i) =>
    lines.push(
      `service 'service[${i + 1}]' ${shellQuote(command)} '/tmp/sandbox-console-service-${
        i + 1
      }.log'`
    )
  );
  // The end marker is what tells `ops.reportStartupHooks` the run is over; it must not read
  // as a clean bill of health when a service died on the spot.
  lines.push(
    'if [ "$dead" -gt 0 ]; then say "=== hooks end ok, $dead service(s) failed to start"; else say "=== hooks end ok"; fi',
    ""
  );
  return lines.join("\n");
}

function kitDirUri(root: vscode.Uri, key: string): vscode.Uri {
  return vscode.Uri.joinPath(root, CONFIG_DIR, KITS_DIR, assertKey(key));
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
 * Write the sandbox's kit **and its runner script**, returning the directory to pass to
 * `sbx create --kit`, or undefined when the sandbox declares no hooks (then nothing is
 * written and no `--kit` is passed — a hookless sandbox behaves as it did before FR-060).
 *
 * Called before **every** start, not only at creation: the kit is frozen into the sandbox,
 * but the runner it bootstraps is read fresh from the host tree on each start, so rewriting
 * it here is what makes an edited recipe take effect on the next start (spec 018).
 *
 * Note the LF line endings: the script is written on Windows and executed by bash inside a
 * Linux VM, where a CR would end up in the command.
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
  if (opts.spec.startup.length > 0 || opts.spec.services.length > 0) {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(dir, "startup.sh"),
      Buffer.from(renderRunner(opts.spec), "utf8")
    );
  }
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
