import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { agentLabel, agentTemplate } from "./agents";
import {
  CONFIG_DIR,
  CONFIG_FILE,
  readConfig,
  SandboxConfig,
  SandboxSpec,
  writeConfig,
} from "./config";
import { ensureIdentity } from "./identity";
import * as names from "./names";
import * as ops from "./ops";
import * as prereq from "./prereq";
import * as sandbox from "./sandbox";
import * as sbx from "./sbx";
import { ensureProjectScript } from "./script";
import * as secrets from "./secrets";

/**
 * Instance-first New/Edit panel. The user edits a SANDBOX (not a file): Save persists the
 * definition to `.sandbox/config.yaml` (invisible plumbing) AND applies to the instance —
 * secrets/ports live, image/mount via a confirmed Rebuild. A just-generated Dockerfile is
 * NOT auto-built (it has only the agent base, no tooling yet); the user edits it first.
 */

export type FormMode = { kind: "new" } | { kind: "edit"; key: string };

interface SubmitPayload {
  agent: string;
  title: string;
  group: string;
  env: string; // "default" | "dockerfile" | "image"
  image: string;
  dockerfile: string;
  secrets: string[];
  ports: number[];
  mount: string;
  isDefault: boolean;
}

interface InitData {
  mode: "new" | "edit";
  heading: string;
  agents: { id: string; label: string }[];
  agentLocked: boolean;
  services: string[];
  globals: string[];
  agent: string;
  title: string;
  group: string;
  env: string;
  image: string;
  dockerfile: string;
  secrets: string[];
  ports: number[];
  mount: string;
  isDefault: boolean;
  /** FR-059: the host-Docker requirement of the Dockerfile mode; empty when a build can run. */
  dockerNotice: string;
}

export async function openForm(
  context: vscode.ExtensionContext,
  root: vscode.Uri,
  mode: FormMode
): Promise<void> {
  const [agentIds, serviceIds, secretList, dockerNotice] = await Promise.all([
    sbx.listAgents(),
    sbx.listSecretServices(),
    sbx.listSecrets(),
    prereq.dockerNotice(),
  ]);
  let config: SandboxConfig | undefined;
  try {
    config = await readConfig(root); // undefined when absent
  } catch (err) {
    // Malformed recipe (FR-009): refuse the form — Save must never replace the file.
    await showInvalidConfig(root, err);
    return;
  }
  const globals = [
    ...new Set(
      secretList.filter((s) => s.scope === "global").map((s) => s.service)
    ),
  ];
  const customServices = serviceIds.filter((s) => !globals.includes(s));

  const current =
    mode.kind === "edit"
      ? config?.sandboxes.find((s) => s.key === mode.key)
      : undefined;

  const projectName = config?.name ?? folderName(root);
  const env = current
    ? current.dockerfile
      ? "dockerfile"
      : current.image
      ? "image"
      : "default"
    : "default";

  const data: InitData = {
    mode: mode.kind,
    heading:
      mode.kind === "edit"
        ? `Edit ${projectName} · ${mode.key}`
        : `New sandbox in ${projectName}`,
    agents: agentIds.map((id) => ({ id, label: agentLabel(id) })),
    agentLocked: mode.kind === "edit",
    services: customServices,
    globals,
    agent: current?.agent ?? "claude",
    title: current?.title ?? "",
    group: current?.group ?? "",
    env,
    image: current && !current.dockerfile ? current.image ?? "" : "",
    dockerfile: current?.dockerfile ?? "",
    secrets: current?.secrets ?? [],
    ports: current?.ports ?? [],
    mount: current?.mount ?? "direct",
    isDefault: current?.default ?? false,
    dockerNotice: dockerNotice ?? "",
  };

  const panel = vscode.window.createWebviewPanel(
    "sandboxConsoleForm",
    mode.kind === "edit" ? "Edit Sandbox" : "New Sandbox",
    vscode.ViewColumn.Active,
    // retainContextWhenHidden: typed input must survive a tab switch (the form is small).
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = getHtml(data, randomBytes(16).toString("base64"));

  let saving = false; // double-submit guard: Save can block for minutes (image pull/build)
  const pinned: { key?: string } = {}; // key persisted by a partial save — see apply()
  const receiver = panel.webview.onDidReceiveMessage(
    async (msg: { type?: string; payload?: SubmitPayload }) => {
      if (msg?.type === "cancel") {
        panel.dispose();
        return;
      }
      if (msg?.type === "submit" && msg.payload) {
        if (saving) {
          return; // a save is already in flight — ignore the re-entry
        }
        saving = true;
        try {
          const version =
            (context.extension.packageJSON as { version?: string }).version ??
            "0.0.0";
          await apply(root, mode, msg.payload, current, customServices, pinned, version);
          panel.dispose();
          await vscode.commands
            .executeCommand("sandboxConsole.refresh")
            .then(undefined, () => undefined);
        } catch (err) {
          // The panel stays open on failure — hand the form back to the user so the
          // corrected values can be re-submitted (FR-054).
          void panel.webview.postMessage({ type: "idle" });
          if (!(err instanceof ops.HandledError)) {
            vscode.window.showErrorMessage(
              `Sandbox Console: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        } finally {
          saving = false;
        }
      }
    }
  );
  // The handler dies with its panel — collecting it in context.subscriptions instead
  // would leak one closure per opened form for the whole session.
  panel.onDidDispose(() => receiver.dispose(), undefined, context.subscriptions);
}

/** Persist the spec to config.yaml and apply it to the instance. */
async function apply(
  root: vscode.Uri,
  mode: FormMode,
  payload: SubmitPayload,
  oldSpec: SandboxSpec | undefined,
  renderedServices: string[],
  pinned: { key?: string },
  version: string
): Promise<void> {
  const identity = await ensureIdentity(root);
  let existing: SandboxConfig | undefined;
  try {
    existing = await readConfig(root); // undefined when absent
  } catch (err) {
    // Malformed recipe (FR-009): refuse to save — never silently replace the file.
    void showInvalidConfig(root, err);
    throw new HandledError("invalid config");
  }
  const config: SandboxConfig = existing ?? { version: 1, sandboxes: [] };
  const projectName = config.name ?? folderName(root);
  if (mode.kind === "edit") {
    // The panel can sit open for a while — prefer the freshly-read spec over the
    // snapshot taken when the form opened (another save may have landed since).
    oldSpec = config.sandboxes.find((s) => s.key === mode.key) ?? oldSpec;
  }

  let key: string;
  let agent: string;
  if (mode.kind === "edit") {
    key = mode.key;
    agent = oldSpec?.agent ?? payload.agent;
  } else if (
    pinned.key &&
    config.sandboxes.some((s) => s.key === pinned.key) &&
    // FR-057: unless the previous attempt is what taught us the name is unusable — reusing
    // it would fail identically, which is the loop this requirement exists to break.
    !names.isUnusable(sandbox.sandboxName(projectName, pinned.key, identity.id))
  ) {
    // Retry after a failed create: the entry is already persisted — update it
    // in place instead of appending a duplicate "<key>-2".
    key = pinned.key;
    agent = payload.agent;
  } else {
    // FR-057: the key is the stable technical id (sbx name, file names, image tags), so it
    // is seeded ONCE — from the title the user just typed, falling back to the agent id
    // when the title is empty or sanitises away — and frozen from then on: the form locks
    // it in edit mode, so renaming a title never touches a sandbox name, Dockerfile or
    // image tag. The invariant is that the key must not *track* the title; seeding it once
    // does not violate that, and it stops sandbox names reading `<project>-claude-2-<id>`.
    agent = payload.agent;
    const base = keyFromTitle(payload.title) ?? agent;
    const used = new Set(config.sandboxes.map((s) => s.key));
    key = base;
    // Skip keys already in the recipe AND keys whose sbx name is known to be unusable
    // (FR-057): a name freed by a rename/removal used to be handed straight back to the
    // next sandbox, which is how a create walked back into a permanently claimed name.
    for (
      let n = 2;
      used.has(key) ||
      names.isUnusable(sandbox.sandboxName(projectName, key, identity.id));
      n++
    ) {
      key = `${base}-${n}`;
    }
  }

  let image: string | undefined;
  let dockerfile: string | undefined;
  let generatedDockerfile: string | undefined;
  if (payload.env === "dockerfile") {
    dockerfile = payload.dockerfile.trim() || oldSpec?.dockerfile || `${key}.Dockerfile`;
    if (dockerfile === oldSpec?.dockerfile) {
      // Round-trip: a previously accepted file (possibly hand-authored, even in a
      // subfolder) and the image tag the instance was built with survive as-is.
      image = oldSpec.image;
    } else {
      // The typed/derived name becomes a file under .sandbox/ — an untrusted value
      // must never steer the write target (path traversal).
      if (!KEY_RE.test(dockerfile)) {
        throw new Error(
          `"${dockerfile}" cannot name a Dockerfile under .sandbox/ — use only letters, digits and "._-", starting with a letter or digit (no path separators).`
        );
      }
      // The image is a product of the Dockerfile, so tag it `<project>:<file stem>` —
      // sandboxes sharing one Dockerfile share one image (Rebuild refreshes it for all).
      const stem = dockerfile.replace(/\.?dockerfile$/i, "") || key;
      image = `${tagSafe(projectName)}:${tagSafe(stem)}`;
      // Existing file (e.g. shared by another sandbox) is reused as-is — only a
      // missing one is seeded, FROM the agent's own base template.
      const madeUri = await ensureDockerfile(root, dockerfile, agent);
      if (madeUri) {
        generatedDockerfile = dockerfile;
      }
    }
  } else if (payload.env === "image") {
    if (!payload.image) {
      throw new Error("Custom image needs an image reference.");
    }
    image = payload.image;
  }

  // FR-032: the committed secrets list is the recipe's requirement. Global secrets on
  // THIS machine only affect prompting, so requirements the form did not render
  // (globally satisfied here, or unknown services) must survive a save round-trip.
  const carried = (oldSpec?.secrets ?? []).filter(
    (s) => !renderedServices.includes(s)
  );
  const specSecrets = [...new Set([...(payload.secrets ?? []), ...carried])];

  const spec: SandboxSpec = {
    ...oldSpec, // fields the form does not edit (e.g. `context`) survive an edit
    key,
    agent,
    title: payload.title.trim() || undefined,
    group: payload.group.trim() || undefined,
    image,
    dockerfile,
    mount: payload.mount === "clone" ? "clone" : "direct",
    secrets: specSecrets,
    ports: payload.ports ?? [],
    default: payload.isDefault ? true : undefined,
  };

  // Derive (and validate) the sbx ref BEFORE persisting: a name that cannot pass the
  // argv allowlists must fail the save, not poison the committed recipe.
  const ref = sandbox.ref(projectName, spec, identity.id);

  // FR-057: a retry that had to abandon its pinned key (its sbx name turned out to be
  // permanently claimed) drops the dead entry — nothing was ever created under it, so
  // keeping it would only leave the recipe carrying a definition that cannot be built.
  const abandoned =
    mode.kind === "new" && pinned.key && pinned.key !== key
      ? pinned.key
      : undefined;
  const entries = abandoned
    ? config.sandboxes.filter((s) => s.key !== abandoned)
    : config.sandboxes;
  const exists = entries.some((s) => s.key === key);
  let sandboxes = exists
    ? entries.map((s) => (s.key === key ? spec : s))
    : [...entries, spec];
  if (spec.default) {
    // Single default per recipe (FR-050): the other entries lose the flag.
    sandboxes = sandboxes.map((s) =>
      s.key !== key && s.default ? { ...s, default: undefined } : s
    );
  }
  await writeConfig(root, {
    version: config.version || 1,
    name: projectName,
    sandboxes,
  });
  pinned.key = key; // a later create/build failure must not re-append on retry
  // FR-052: the recipe just changed/appeared — make sure the project CLI exists too.
  await ensureProjectScript(root, version).catch(() => undefined);

  if (mode.kind === "new") {
    if (generatedDockerfile) {
      info(
        `Saved. Edit .sandbox/${generatedDockerfile} (add your tooling), then Connect the sandbox to build it.`
      );
    } else {
      // createOrAttach builds the image, prompts secrets, attaches, and publishes ports.
      await ops.createOrAttach(root, ref);
    }
    return;
  }

  // edit
  const state = await safeState(ref);
  if (state === "absent") {
    info("Saved. Create it from the Sandboxes view (Connect).");
    return;
  }
  const envChanged =
    oldSpec?.image !== spec.image ||
    oldSpec?.dockerfile !== spec.dockerfile ||
    (oldSpec?.mount ?? "direct") !== spec.mount;
  if (envChanged) {
    if (generatedDockerfile) {
      info(
        `Saved. Edit .sandbox/${generatedDockerfile}, then Rebuild ${ref.name} to apply.`
      );
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Apply image/mount changes to ${ref.name}? This rebuilds (recreates) the sandbox; the workspace on the host mount is preserved.`,
      { modal: true },
      "Rebuild"
    );
    if (choice === "Rebuild") {
      await ops.rebuildRef(root, ref); // also publishes ports once running
    }
    return;
  }
  // Only secrets/ports changed → apply live.
  await secrets.ensureSecrets(ref);
  await publishPortsSafe(ref.name, spec.ports);
  info(`Applied changes to ${ref.name}.`);
}

function info(message: string): void {
  vscode.window.showInformationMessage(message);
}

/** Thrown after the user was already shown a notification (the panel stays open).
 * Extends the shared sentinel so one `instanceof` covers this and the refusals `ops.ts`
 * reports in a dialog of their own (FR-058). */
class HandledError extends ops.HandledError {}

/** Recipe keys and Dockerfile names become files under `.sandbox/` and docker-tag
 * components. No path separators and no leading "." — that is what makes traversal
 * impossible; uppercase/underscore are fine (image tags are tagSafe()d separately). */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A key derived from a title stays readable in a sandbox name; a pasted sentence does not. */
const KEY_MAX = 40;

/**
 * FR-057: seed a new sandbox's key from its title — `Backend API (v2)` → `backend-api-v2`.
 * The result must satisfy KEY_RE (it names files under `.sandbox/` and feeds image tags
 * and the sbx name), so it is lowercased, disallowed runs become "-", and separators are
 * collapsed/trimmed. Returns undefined when nothing usable is left (empty title, or a
 * fully non-ASCII one) — the caller then falls back to the agent id, as before.
 */
function keyFromTitle(title: string): string | undefined {
  const safe = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/[._-]{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, KEY_MAX)
    .replace(/[._-]+$/, "");
  return KEY_RE.test(safe) ? safe : undefined;
}

/**
 * One component of a derived docker image tag. Docker repository names need [a-z0-9]
 * runs joined by single separators; project/folder names often aren't (spaces, "+", …):
 * lowercase, dash invalid runs, collapse/trim separators, never return empty.
 */
function tagSafe(part: string): string {
  const safe = part
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/[._-]{2,}/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return safe || "sandbox";
}

/** Malformed `.sandbox/config.yaml`: explain + offer to open it; never overwrite it.
 * Shared with extension.ts so palette commands tell the same story as the form. */
export async function showInvalidConfig(
  root: vscode.Uri,
  err: unknown
): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  const choice = await vscode.window.showErrorMessage(
    `Sandbox Console: ${msg} — fix the file, then retry.`,
    "Open config"
  );
  if (choice === "Open config") {
    await vscode.window.showTextDocument(
      vscode.Uri.joinPath(root, CONFIG_DIR, CONFIG_FILE)
    );
  }
}

async function safeState(ref: sandbox.SandboxRef): Promise<sbx.SandboxState> {
  try {
    return await sandbox.state(ref);
  } catch {
    return "absent";
  }
}

async function publishPortsSafe(name: string, ports: number[]): Promise<void> {
  for (const port of ports) {
    try {
      await sbx.publishPort(name, port);
    } catch {
      // best-effort: the sandbox may still be starting, or the port already bound
    }
  }
}

/** Generate `.sandbox/<file>` FROM the agent's base template; undefined if it exists
 * (an existing file is never clobbered — that is what makes sharing one work). */
async function ensureDockerfile(
  root: vscode.Uri,
  file: string,
  agent: string
): Promise<vscode.Uri | undefined> {
  const uri = vscode.Uri.joinPath(root, CONFIG_DIR, file);
  try {
    await vscode.workspace.fs.stat(uri);
    return undefined; // already exists — never clobber
  } catch {
    // create it
  }
  const content =
    [
      `# ${file} — edit freely, then Rebuild/Connect the sandboxes that use it.`,
      "# Must extend a Docker Sandboxes base image (keeps the proxy + agent user intact).",
      `# The base below matches this sandbox's agent (${agent}); -docker flavors bundle a`,
      "# Docker engine (the CLI default). All flavors: `sbx template ls` or",
      "# https://docs.docker.com/ai/sandboxes/customize/templates/",
      `FROM docker/sandbox-templates:${agentTemplate(agent)}`,
      "USER root",
      "# Install your dev tooling here, e.g.:",
      "# RUN apt-get update && apt-get install -y dotnet-sdk-8.0",
      "USER agent",
    ].join("\n") + "\n";
  await vscode.workspace.fs.createDirectory(
    vscode.Uri.joinPath(root, CONFIG_DIR)
  );
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
  return uri;
}

function folderName(root: vscode.Uri): string {
  return root.path.split("/").filter(Boolean).pop() ?? "workspace";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SCRIPT = `(function(){
  var vscode = acquireVsCodeApi();
  var I = INIT;

  var agSel = document.getElementById('agent');
  I.agents.forEach(function(a){ var o=document.createElement('option'); o.value=a.id; o.textContent=a.label+' ('+a.id+')'; agSel.appendChild(o); });
  agSel.value = I.agent;
  if (I.agentLocked){ agSel.disabled = true; }
  document.getElementById('title').value = I.title || '';
  document.getElementById('group').value = I.group || '';
  document.getElementById('isDefault').checked = !!I.isDefault;

  var gBox = document.getElementById('globals');
  if (I.globals && I.globals.length){
    I.globals.forEach(function(svc){ var b=document.createElement('span'); b.className='badge'; b.textContent=svc; gBox.appendChild(b); });
  } else {
    var none=document.createElement('span'); none.className='muted'; none.textContent='none configured'; gBox.appendChild(none);
  }

  var secBox = document.getElementById('secrets');
  I.services.forEach(function(svc){
    var l=document.createElement('label'); l.className='chip';
    var c=document.createElement('input'); c.type='checkbox'; c.value=svc; c.className='c-sec';
    if (I.secrets.indexOf(svc) >= 0) c.checked=true;
    l.appendChild(c); l.appendChild(document.createTextNode(svc));
    secBox.appendChild(l);
  });

  Array.prototype.forEach.call(document.querySelectorAll('input[name=env]'), function(r){ r.checked = (r.value === I.env); });
  document.getElementById('image').value = I.image || '';
  document.getElementById('dockerfile').value = I.dockerfile || '';
  // FR-059: only the Dockerfile mode needs host Docker — the image mode is pulled by sbx
  // itself — so the notice lives in that block and appears exactly when it is chosen.
  if (I.dockerNotice) {
    var dn = document.getElementById('dockerNotice');
    dn.textContent = I.dockerNotice;
    dn.style.display = 'block';
  }
  function syncEnv(){
    var sel = document.querySelector('input[name=env]:checked');
    var v = sel ? sel.value : 'default';
    document.getElementById('imageBlock').style.display = (v === 'image') ? 'block' : 'none';
    document.getElementById('dockerBlock').style.display = (v === 'dockerfile') ? 'block' : 'none';
  }
  Array.prototype.forEach.call(document.querySelectorAll('input[name=env]'), function(r){ r.addEventListener('change', syncEnv); });
  syncEnv();

  var portsBox = document.getElementById('ports');
  function addPort(val){
    var row=document.createElement('div'); row.className='port-row';
    var inp=document.createElement('input'); inp.type='number'; inp.min='1'; inp.className='c-port'; inp.placeholder='port';
    if (val) inp.value=val;
    var del=document.createElement('button'); del.type='button'; del.className='icon'; del.textContent='\\u2715'; del.title='Remove';
    del.addEventListener('click', function(){ portsBox.removeChild(row); });
    row.appendChild(inp); row.appendChild(del); portsBox.appendChild(row);
  }
  (I.ports || []).forEach(function(p){ addPort(String(p)); });
  document.getElementById('addPort').addEventListener('click', function(){ addPort(''); });

  document.getElementById('mount').value = I.mount || 'direct';

  // FR-054 (UI half): a save can block for minutes on an image build, so the form shows
  // that it is working. The host already ignores a re-entrant submit — without this the
  // second click was silently dropped, which reads as "the button doesn't work".
  var saveBtn = document.getElementById('save');
  var cancelBtn = document.getElementById('cancel');
  var statusEl = document.getElementById('status');
  var busyLabel = I.mode === 'edit' ? 'Applying\\u2026' : 'Creating\\u2026';
  function setBusy(on){
    Array.prototype.forEach.call(document.querySelectorAll('input,select,button'), function(el){ el.disabled = on; });
    saveBtn.textContent = on ? busyLabel : 'Save';
    // Cancel is disabled too: closing the panel would not stop the work. The way out is
    // the progress notification's own Cancel (FR-056).
    statusEl.textContent = on
      ? 'Working\\u2026 progress is in the notification; "Sandbox: Show Log" has the details.'
      : '';
    if (!on && I.agentLocked){ agSel.disabled = true; }
  }
  window.addEventListener('message', function(e){
    // Sent when the save failed and the panel stayed open — allow a retry.
    if (e.data && e.data.type === 'idle'){ setBusy(false); }
  });

  cancelBtn.addEventListener('click', function(){ vscode.postMessage({type:'cancel'}); });
  saveBtn.addEventListener('click', function(){
    if (saveBtn.disabled) return;
    var sel = document.querySelector('input[name=env]:checked');
    var env = sel ? sel.value : 'default';
    var secrets=[]; Array.prototype.forEach.call(document.querySelectorAll('.c-sec'), function(c){ if (c.checked) secrets.push(c.value); });
    var ports=[]; Array.prototype.forEach.call(document.querySelectorAll('.c-port'), function(inp){ var n=parseInt(inp.value.trim(),10); if(!isNaN(n)) ports.push(n); });
    vscode.postMessage({type:'submit', payload:{
      agent: document.getElementById('agent').value,
      title: document.getElementById('title').value,
      group: document.getElementById('group').value,
      env: env,
      image: document.getElementById('image').value.trim(),
      dockerfile: document.getElementById('dockerfile').value.trim(),
      secrets: secrets,
      ports: ports,
      mount: document.getElementById('mount').value,
      isDefault: document.getElementById('isDefault').checked
    }});
    setBusy(true); // after reading the fields — disabled inputs still read fine, but order is clearer
  });
})();`;

function getHtml(data: InitData, nonce: string): string {
  const initJson = JSON.stringify(data).replace(/</g, "\\u003c");
  const sub =
    data.mode === "edit"
      ? "Changes apply to this sandbox: secrets &amp; ports live; image/mount ask to rebuild."
      : "Creates the sandbox. You'll be asked for any required secret values.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root{ color-scheme: light dark; }
  body{ font-family:var(--vscode-font-family); font-size:13px; color:var(--vscode-foreground); margin:0; }
  .wrap{ max-width:640px; margin:0 auto; padding:22px 24px 32px; }
  h2{ font-size:18px; font-weight:600; margin:0 0 4px; }
  .sub{ color:var(--vscode-descriptionForeground); font-size:12px; margin:0 0 18px; }
  .card{ background:var(--vscode-editorWidget-background); border:1px solid var(--vscode-widget-border,var(--vscode-panel-border)); border-radius:8px; padding:16px 18px; }
  .field{ margin:0 0 16px; }
  .field:last-child{ margin-bottom:0; }
  .lbl{ display:block; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--vscode-descriptionForeground); margin:0 0 6px; }
  .caption{ color:var(--vscode-descriptionForeground); font-size:11px; margin-top:6px; line-height:1.5; }
  input[type=text],input[type=number],select{ width:100%; box-sizing:border-box; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border,transparent); border-radius:4px; padding:6px 8px; font-family:inherit; font-size:13px; outline:none; }
  select{ height:30px; }
  input:focus,select:focus{ border-color:var(--vscode-focusBorder); }
  .chips{ display:flex; flex-wrap:wrap; gap:6px 14px; }
  .chips.readonly{ gap:6px; }
  .badge{ display:inline-flex; align-items:center; background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); border-radius:10px; padding:1px 9px; font-size:11px; }
  .muted{ color:var(--vscode-descriptionForeground); font-size:12px; }
  label.chip{ display:inline-flex; align-items:center; gap:6px; font-size:13px; cursor:pointer; }
  label.inline{ display:inline-flex; align-items:center; gap:6px; margin:0 16px 8px 0; font-size:13px; cursor:pointer; }
  input[type=checkbox],input[type=radio]{ width:auto; margin:0; accent-color:var(--vscode-focusBorder); }
  .custom{ margin-top:10px; }
  .hint{ color:var(--vscode-descriptionForeground); font-size:11px; margin-top:8px; line-height:1.5; }
  /* FR-059: the host-Docker requirement of the Dockerfile mode, shown with the mode itself. */
  .warn{ color:var(--vscode-inputValidation-warningForeground,var(--vscode-foreground)); background:var(--vscode-inputValidation-warningBackground); border:1px solid var(--vscode-inputValidation-warningBorder); border-radius:4px; padding:8px 10px; font-size:12px; line-height:1.5; margin-bottom:10px; }
  details{ margin-top:16px; border-top:1px solid var(--vscode-widget-border,var(--vscode-panel-border)); padding-top:12px; }
  summary{ cursor:pointer; font-size:12px; font-weight:600; user-select:none; color:var(--vscode-foreground); }
  summary:hover{ color:var(--vscode-textLink-foreground); }
  details > .field{ margin-top:14px; }
  .port-row{ display:flex; gap:8px; align-items:center; margin:0 0 6px; }
  .port-row input{ width:160px; }
  .footer{ display:flex; gap:10px; margin-top:20px; align-items:center; }
  .status{ color:var(--vscode-descriptionForeground); font-size:12px; }
  button:disabled{ opacity:.5; cursor:default; }
  button{ font-family:inherit; font-size:13px; border:none; border-radius:4px; padding:7px 16px; cursor:pointer; }
  button.primary{ background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
  button.primary:hover{ background:var(--vscode-button-hoverBackground); }
  button.secondary{ background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
  button.secondary:hover{ background:var(--vscode-button-secondaryHoverBackground); }
  button.ghost{ background:transparent; color:var(--vscode-textLink-foreground); padding:6px 0; }
  button.ghost:hover{ text-decoration:underline; }
  button.icon{ background:transparent; color:var(--vscode-descriptionForeground); padding:2px 7px; border-radius:4px; }
  button.icon:hover{ background:var(--vscode-toolbar-hoverBackground); color:var(--vscode-foreground); }
</style>
</head>
<body>
<div class="wrap">
  <h2>${escapeHtml(data.heading)}</h2>
  <p class="sub">${sub}</p>
  <div class="card">
    <div class="field">
      <label class="lbl">Title</label>
      <input id="title" type="text" placeholder="display label (optional; names the new sandbox, safe to rename later)" />
    </div>
    <div class="field">
      <label class="lbl">Agent</label>
      <select id="agent"></select>
    </div>
    <div class="field">
      <label class="lbl">Group</label>
      <input id="group" type="text" placeholder="group for organising in the Sandboxes view (optional)" />
    </div>
    <div class="field">
      <label class="chip"><input id="isDefault" type="checkbox" /> Default sandbox — the status bar and palette commands target it</label>
    </div>
    <div class="field">
      <label class="lbl">Global credentials · shared, read-only</label>
      <div id="globals" class="chips readonly"></div>
    </div>
    <div class="field">
      <label class="lbl">Custom credentials · this sandbox</label>
      <div id="secrets" class="chips"></div>
      <div class="caption">Tick what this sandbox needs; you'll be prompted for values (only missing ones) when applied.</div>
    </div>
    <details>
      <summary>Advanced — environment, ports, mount</summary>
      <div class="field">
        <label class="lbl">Environment</label>
        <label class="inline"><input type="radio" name="env" value="default" /> Default agent image</label>
        <label class="inline"><input type="radio" name="env" value="dockerfile" /> Custom: Dockerfile</label>
        <label class="inline"><input type="radio" name="env" value="image" /> Custom: image (pull as-is)</label>
        <div id="dockerBlock" class="custom" style="display:none">
          <div id="dockerNotice" class="warn" style="display:none"></div>
          <label class="lbl">Dockerfile (under .sandbox/)</label>
          <input id="dockerfile" type="text" placeholder="auto: &lt;sandbox name&gt;.Dockerfile" />
          <div class="hint">Created if missing, FROM the selected agent's base image. Enter the same file name in several sandboxes to share one committed Dockerfile. Edit it, then Rebuild/Connect to build.</div>
        </div>
        <div id="imageBlock" class="custom" style="display:none">
          <label class="lbl">Image reference (pulled as-is)</label>
          <input id="image" type="text" placeholder="e.g. docker/sandbox-templates:shell-docker or ghcr.io/org/img:tag" />
        </div>
      </div>
      <div class="field">
        <label class="lbl">Published ports</label>
        <div id="ports"></div>
        <button id="addPort" class="ghost" type="button">+ Add port</button>
      </div>
      <div class="field">
        <label class="lbl">Mount</label>
        <select id="mount"><option value="direct">direct</option><option value="clone">clone</option></select>
      </div>
    </details>
  </div>
  <div class="footer">
    <button id="save" class="primary" type="button">Save</button>
    <button id="cancel" class="secondary" type="button">Cancel</button>
    <span id="status" class="status" aria-live="polite"></span>
  </div>
</div>
<script nonce="${nonce}">const INIT = ${initJson};
${SCRIPT}</script>
</body>
</html>`;
}
