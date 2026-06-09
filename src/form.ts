import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { agentLabel } from "./agents";
import {
  CONFIG_DIR,
  readConfig,
  SandboxConfig,
  SandboxSpec,
  writeConfig,
} from "./config";
import { ensureIdentity, readIdentity } from "./identity";
import * as ops from "./ops";
import * as sandbox from "./sandbox";
import * as sbx from "./sbx";
import * as secrets from "./secrets";

/**
 * Instance-first New/Edit panel. The user edits a SANDBOX (not a file): Save persists the
 * definition to `.sandbox/config.yaml` (invisible plumbing) AND applies to the instance —
 * secrets/ports live, image/mount via a confirmed Rebuild. A just-generated Dockerfile is
 * NOT auto-built (it would have only the default shell base); the user edits it first.
 */

export type FormMode = { kind: "new" } | { kind: "edit"; key: string };

interface SubmitPayload {
  agent: string;
  title: string;
  group: string;
  env: string; // "default" | "dockerfile" | "image"
  image: string;
  secrets: string[];
  ports: number[];
  mount: string;
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
  secrets: string[];
  ports: number[];
  mount: string;
}

export async function openForm(
  context: vscode.ExtensionContext,
  root: vscode.Uri,
  mode: FormMode
): Promise<void> {
  const [agentIds, serviceIds, secretList, config, identity] = await Promise.all([
    sbx.listAgents(),
    sbx.listSecretServices(),
    sbx.listSecrets(),
    readConfig(root).catch(() => undefined),
    readIdentity(root),
  ]);
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

  const name = identity?.name ?? folderName(root);
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
        ? `Edit ${name}-${mode.kind === "edit" ? mode.key : ""}`
        : `New sandbox in ${name}`,
    agents: agentIds.map((id) => ({ id, label: agentLabel(id) })),
    agentLocked: mode.kind === "edit",
    services: customServices,
    globals,
    agent: current?.agent ?? "claude",
    title: current?.title ?? "",
    group: current?.group ?? "",
    env,
    image: current && !current.dockerfile ? current.image ?? "" : "",
    secrets: current?.secrets ?? [],
    ports: current?.ports ?? [],
    mount: current?.mount ?? "direct",
  };

  const panel = vscode.window.createWebviewPanel(
    "ainoflowSandboxForm",
    mode.kind === "edit" ? "Edit Sandbox" : "New Sandbox",
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );
  panel.webview.html = getHtml(data, randomBytes(16).toString("base64"));

  panel.webview.onDidReceiveMessage(
    async (msg: { type?: string; payload?: SubmitPayload }) => {
      if (msg?.type === "cancel") {
        panel.dispose();
        return;
      }
      if (msg?.type === "submit" && msg.payload) {
        try {
          await apply(root, mode, msg.payload, current);
          panel.dispose();
          await vscode.commands
            .executeCommand("ainoflowSandbox.refresh")
            .then(undefined, () => undefined);
        } catch (err) {
          vscode.window.showErrorMessage(
            `Sandbox: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    },
    undefined,
    context.subscriptions
  );
}

/** Persist the spec to config.yaml and apply it to the instance. */
async function apply(
  root: vscode.Uri,
  mode: FormMode,
  payload: SubmitPayload,
  oldSpec: SandboxSpec | undefined
): Promise<void> {
  const identity = await ensureIdentity(root);
  const config: SandboxConfig = (await readConfig(root).catch(() => undefined)) ?? {
    version: 1,
    sandboxes: [],
  };

  let key: string;
  let agent: string;
  if (mode.kind === "edit") {
    key = mode.key;
    agent = oldSpec?.agent ?? payload.agent;
  } else {
    agent = payload.agent;
    const slug = payload.title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9.+-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const base = slug || agent;
    key = base;
    const used = new Set(config.sandboxes.map((s) => s.key));
    for (let n = 2; used.has(key); n++) {
      key = `${base}-${n}`;
    }
  }

  let image: string | undefined;
  let dockerfile: string | undefined;
  let generatedDockerfile: string | undefined;
  if (payload.env === "dockerfile") {
    image = `${identity.name.toLowerCase()}-${key}:latest`;
    dockerfile = `${key}.Dockerfile`;
    const madeUri = await ensureDockerfile(root, key);
    if (madeUri) {
      generatedDockerfile = `${key}.Dockerfile`;
    }
  } else if (payload.env === "image") {
    if (!payload.image) {
      throw new Error("Custom image needs an image reference.");
    }
    image = payload.image;
  }

  const spec: SandboxSpec = {
    key,
    agent,
    title: payload.title.trim() || undefined,
    group: payload.group.trim() || undefined,
    image,
    dockerfile,
    mount: payload.mount === "clone" ? "clone" : "direct",
    secrets: payload.secrets ?? [],
    ports: payload.ports ?? [],
  };

  const exists = config.sandboxes.some((s) => s.key === key);
  const sandboxes = exists
    ? config.sandboxes.map((s) => (s.key === key ? spec : s))
    : [...config.sandboxes, spec];
  await writeConfig(root, { version: config.version || 1, sandboxes });

  const ref = sandbox.ref(identity, spec);

  if (mode.kind === "new") {
    if (generatedDockerfile) {
      info(
        `Saved. Edit .sandbox/${generatedDockerfile} (set FROM + tools), then Attach the sandbox to build it.`
      );
    } else {
      await ops.createOrAttach(root, ref); // builds image, prompts secrets, attaches
      await publishPortsSafe(ref.name, spec.ports);
    }
    return;
  }

  // edit
  const state = await safeState(ref);
  if (state === "absent") {
    info("Saved. Create it from the Sandboxes view (Attach).");
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
      await ops.rebuildRef(root, ref);
      await publishPortsSafe(ref.name, spec.ports);
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

/** Generate `.sandbox/<key>.Dockerfile` with a shell-base default; undefined if it exists. */
async function ensureDockerfile(
  root: vscode.Uri,
  key: string
): Promise<vscode.Uri | undefined> {
  const uri = vscode.Uri.joinPath(root, CONFIG_DIR, `${key}.Dockerfile`);
  try {
    await vscode.workspace.fs.stat(uri);
    return undefined; // already exists — never clobber
  } catch {
    // create it
  }
  const content =
    [
      `# Dockerfile for the "${key}" sandbox — edit freely, then Rebuild.`,
      "# Must extend a Docker Sandboxes base image (keeps the proxy + agent user intact).",
      "# Available base images — set FROM to one of:",
      "#   docker/sandbox-templates:shell         generic shell (default below)",
      "#   docker/sandbox-templates:shell-docker  shell + Docker engine",
      "#   docker/sandbox-templates:claude-code   Claude Code agent",
      "#   docker/sandbox-templates:codex         Codex agent",
      "#   docker/sandbox-templates:gemini        Gemini agent",
      "#   (run `sbx template ls` to list what's installed locally)",
      "FROM docker/sandbox-templates:shell",
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
  function syncEnv(){
    var sel = document.querySelector('input[name=env]:checked');
    var v = sel ? sel.value : 'default';
    document.getElementById('imageBlock').style.display = (v === 'image') ? 'block' : 'none';
    document.getElementById('dockerHint').style.display = (v === 'dockerfile') ? 'block' : 'none';
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

  document.getElementById('cancel').addEventListener('click', function(){ vscode.postMessage({type:'cancel'}); });
  document.getElementById('save').addEventListener('click', function(){
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
      secrets: secrets,
      ports: ports,
      mount: document.getElementById('mount').value
    }});
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
  details{ margin-top:16px; border-top:1px solid var(--vscode-widget-border,var(--vscode-panel-border)); padding-top:12px; }
  summary{ cursor:pointer; font-size:12px; font-weight:600; user-select:none; color:var(--vscode-foreground); }
  summary:hover{ color:var(--vscode-textLink-foreground); }
  details > .field{ margin-top:14px; }
  .port-row{ display:flex; gap:8px; align-items:center; margin:0 0 6px; }
  .port-row input{ width:160px; }
  .footer{ display:flex; gap:10px; margin-top:20px; }
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
      <input id="title" type="text" placeholder="display name (optional)" />
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
        <div id="dockerHint" class="hint" style="display:none">A <code>.sandbox/&lt;agent&gt;.Dockerfile</code> is created (FROM the shell base; all bases listed in comments). Edit it, then Rebuild/Attach to build.</div>
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
  </div>
</div>
<script nonce="${nonce}">const INIT = ${initJson};
${SCRIPT}</script>
</body>
</html>`;
}
