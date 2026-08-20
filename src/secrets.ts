import * as vscode from "vscode";
import * as blobs from "./blobs";
import { SandboxRef } from "./sandbox";
import * as sbx from "./sbx";
import { serviceLabel } from "./services";

/**
 * Secret provisioning (FR-032). The recipe lists required service-secret NAMES; this
 * module checks `sbx secret ls`, prompts (password input) only for the ones not already
 * satisfied, and pipes the value to `sbx secret set` — never via argv/shell history,
 * never into the repo.
 *
 * FR-051: values can come from the per-project cache (`~/.sbx` DPAPI blobs, shared with
 * the generated project CLI). Selection is always explicit — a picker over cached
 * entries (names only, never values) or a fresh manual entry with an offer to cache it.
 */

interface ScopePick extends vscode.QuickPickItem {
  scope: string;
}

/** Names required by the spec that are not already satisfied globally or for this sandbox. */
export async function missingSecrets(ref: SandboxRef): Promise<string[]> {
  if (ref.spec.secrets.length === 0) {
    return [];
  }
  const have = await sbx.listSecrets();
  const satisfied = new Set(
    have
      .filter((s) => s.scope === "global" || s.scope === ref.name)
      .map((s) => s.service)
  );
  return ref.spec.secrets.filter((s) => !satisfied.has(s));
}

/**
 * Prompt for and set any missing secrets for this sandbox. The sandbox must already exist
 * if a per-sandbox scope is chosen. Returns the number provisioned.
 *
 * `beforeCreate` is the FR-060 case: the sandbox does not exist yet, but its lifecycle
 * hooks are about to run inside `sbx create` and may need a credential. `sbx secret set`
 * can only scope to a sandbox that exists, so the per-sandbox choice is withheld rather
 * than offered and then failed — global is the one scope that can be in place before a
 * create. Skipping is fine: the same secrets are re-checked after the create, where the
 * per-sandbox choice is available again.
 */
export async function ensureSecrets(
  ref: SandboxRef,
  opts?: { beforeCreate?: boolean }
): Promise<number> {
  const missing = await missingSecrets(ref);
  let count = 0;
  for (const service of missing) {
    const scopePick = await vscode.window.showQuickPick<ScopePick>(
      opts?.beforeCreate
        ? [
            { label: "Global", description: "all sandboxes", scope: "global" },
            { label: "Skip", description: "hooks run without it", scope: "" },
          ]
        : [
            { label: `This sandbox`, description: ref.name, scope: ref.name },
            { label: "Global", description: "all sandboxes", scope: "global" },
            { label: "Skip", scope: "" },
          ],
      {
        title: `Secret: ${serviceLabel(service)} (${service})`,
        placeHolder: opts?.beforeCreate
          ? `${ref.name} runs setup hooks before it exists — only a global credential can be in place by then`
          : "Where should this credential be stored?",
        ignoreFocusOut: true,
      }
    );
    if (!scopePick || !scopePick.scope) {
      continue;
    }
    const value = await obtainValue(ref, service);
    if (!value) {
      continue;
    }
    await sbx.secretSet({ service, scope: scopePick.scope, value });
    count++;
    if (service === "github") {
      await tryGhLogin(ref, value);
    }
  }
  return count;
}

/**
 * Get the secret value: pick a cached entry for this service (current project's entry
 * first) or enter a new one. With an empty cache the picker is skipped entirely — the
 * flow is the pre-cache input box plus a save offer (FR-051).
 */
async function obtainValue(
  ref: SandboxRef,
  service: string
): Promise<string | undefined> {
  const entries = await blobs.listEntries(service).catch(() => []);
  if (entries.length === 0) {
    return promptAndOfferCache(ref, service);
  }
  const projectEntry = blobs.entrySafe(ref.projectName);
  entries.sort((a, b) =>
    a.entry === projectEntry ? -1 : b.entry === projectEntry ? 1 : 0
  );
  type Item = vscode.QuickPickItem & { entry?: string; manual?: boolean };
  const items: Item[] = entries.map((e) => ({
    label: `$(key) ${e.entry}`,
    description: e.entry === projectEntry ? "this project" : undefined,
    entry: e.entry,
  }));
  items.push({ label: "$(plus) Enter new value…", manual: true });
  const picked = await vscode.window.showQuickPick(items, {
    title: `${serviceLabel(service)} (${service}) — cached on this machine`,
    placeHolder: "Use a cached value or enter a new one (values are never shown)",
    ignoreFocusOut: true,
  });
  if (!picked) {
    return undefined;
  }
  if (picked.manual || !picked.entry) {
    return promptAndOfferCache(ref, service);
  }
  const value = await blobs.readBlob(picked.entry, service);
  if (!value) {
    vscode.window.showWarningMessage(
      `Cached entry "${picked.entry}" could not be decrypted (different user/machine?) — enter the value manually.`
    );
    return promptAndOfferCache(ref, service);
  }
  return value;
}

/** Manual entry, then an explicit offer to cache it for reuse (default: this project). */
async function promptAndOfferCache(
  ref: SandboxRef,
  service: string
): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: `${serviceLabel(service)} token`,
    prompt: `Stored via "sbx secret set" (kept in the OS keychain, never in the repo)`,
    password: true,
    ignoreFocusOut: true,
  });
  if (!value) {
    return undefined;
  }
  if (!blobs.cacheSupported()) {
    return value;
  }
  const projectEntry = blobs.entrySafe(ref.projectName);
  type Item = vscode.QuickPickItem & { action: "project" | "named" | "once" };
  const picked = await vscode.window.showQuickPick<Item>(
    [
      {
        label: `$(save) Cache as "${projectEntry}"`,
        description: "reused for this project's sandboxes and runners",
        action: "project",
      },
      { label: "$(edit) Cache under another name…", action: "named" },
      { label: "Use once, don't cache", action: "once" },
    ],
    {
      title: `Cache this ${service} value? (encrypted for your OS user in ~/.sbx — also used by .sandbox/scripts/sbx.sh)`,
      ignoreFocusOut: true,
    }
  );
  if (picked && picked.action !== "once") {
    let entry = projectEntry;
    if (picked.action === "named") {
      const typed = await vscode.window.showInputBox({
        title: "Cache entry name",
        value: projectEntry,
        prompt: 'Letters, digits and "._+-" (e.g. the project, or "shared" for a cross-project fallback)',
        ignoreFocusOut: true,
        validateInput: (v) =>
          blobs.validEntryName(v)
            ? undefined
            : 'use letters, digits and "._+-", starting with a letter or digit',
      });
      if (!typed) {
        return value; // caching declined — the value itself is still good
      }
      entry = typed;
    }
    try {
      await blobs.writeBlob(entry, service, value);
    } catch (err) {
      vscode.window.showWarningMessage(
        `Sandbox Console: caching failed (${
          err instanceof Error ? err.message : String(err)
        }) — the secret is still being provisioned.`
      );
    }
  }
  return value;
}

/**
 * `Sandbox: Manage Cached Secrets` — list cached entries (names only), delete or rename
 * them (FR-051). Values are never displayed and never leave the encrypted blobs here.
 */
export async function manageCachedSecrets(): Promise<void> {
  if (!blobs.cacheSupported()) {
    vscode.window.showInformationMessage(
      "Sandbox Console: the secret cache is only available on Windows for now."
    );
    return;
  }
  for (;;) {
    const entries = await blobs.listEntries();
    if (entries.length === 0) {
      vscode.window.showInformationMessage(
        "No cached secrets. Values are offered for caching when a sandbox secret is provisioned."
      );
      return;
    }
    type Item = vscode.QuickPickItem & { blob: blobs.BlobEntry };
    const picked = await vscode.window.showQuickPick<Item>(
      entries.map((e) => ({
        label: `$(key) ${e.entry}`,
        description: e.service,
        // Stable hint only — the real absolute path would leak the local username
        // into screenshots, and entry+service already identify the blob.
        detail: `~/.sbx/${e.entry}.${e.service}.dpapi`,
        blob: e,
      })),
      { title: "Cached secrets (~/.sbx, encrypted per OS user)", ignoreFocusOut: true }
    );
    if (!picked) {
      return;
    }
    const action = await vscode.window.showQuickPick(
      [{ label: "$(edit) Rename" }, { label: "$(trash) Delete" }],
      {
        title: `${picked.blob.entry} (${picked.blob.service})`,
        ignoreFocusOut: true,
      }
    );
    if (!action) {
      continue;
    }
    if (action.label.includes("Delete")) {
      const sure = await vscode.window.showWarningMessage(
        `Delete the cached "${picked.blob.entry}" (${picked.blob.service}) value? Sandboxes already provisioned keep working; new provisioning will prompt again.`,
        { modal: true },
        "Delete"
      );
      if (sure === "Delete") {
        await blobs.deleteBlob(picked.blob.entry, picked.blob.service);
      }
      continue;
    }
    const newName = await vscode.window.showInputBox({
      title: `Rename cache entry "${picked.blob.entry}"`,
      value: picked.blob.entry,
      ignoreFocusOut: true,
      validateInput: (v) =>
        blobs.validEntryName(v)
          ? undefined
          : 'use letters, digits and "._+-", starting with a letter or digit',
    });
    if (newName && newName !== picked.blob.entry) {
      await blobs.renameBlob(picked.blob.entry, picked.blob.service, newName);
    }
  }
}

/**
 * Replicate `gh auth login --with-token` inside the sandbox so the `gh` CLI works (the
 * proxy `github` secret only authenticates the wire, not gh's own status). Best-effort:
 * only if the sandbox exists and `gh` is installed; stays silent on failure.
 */
async function tryGhLogin(ref: SandboxRef, token: string): Promise<void> {
  try {
    if ((await sbx.stateOf(ref.name)) === "absent") {
      return; // no instance to log into yet
    }
    if (!(await sbx.sandboxHasCommand(ref.name, "gh"))) {
      return; // gh CLI not present in this sandbox
    }
    await sbx.ghAuthLogin(ref.name, token);
    vscode.window.showInformationMessage(`gh CLI authenticated in ${ref.name}.`);
  } catch {
    // best-effort — stay silent if gh login fails
  }
}
