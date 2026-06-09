import * as vscode from "vscode";
import { SandboxRef } from "./sandbox";
import * as sbx from "./sbx";
import { serviceLabel } from "./services";

/**
 * Secret provisioning (FR-032). The recipe lists required service-secret NAMES; this
 * module checks `sbx secret ls`, prompts (password input) only for the ones not already
 * satisfied, and pipes the value to `sbx secret set` — never via argv/shell history,
 * never into the repo.
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
 */
export async function ensureSecrets(ref: SandboxRef): Promise<number> {
  const missing = await missingSecrets(ref);
  let count = 0;
  for (const service of missing) {
    const scopePick = await vscode.window.showQuickPick<ScopePick>(
      [
        { label: `This sandbox`, description: ref.name, scope: ref.name },
        { label: "Global", description: "all sandboxes", scope: "global" },
        { label: "Skip", scope: "" },
      ],
      {
        title: `Secret: ${serviceLabel(service)} (${service})`,
        placeHolder: "Where should this credential be stored?",
        ignoreFocusOut: true,
      }
    );
    if (!scopePick || !scopePick.scope) {
      continue;
    }
    const value = await vscode.window.showInputBox({
      title: `${serviceLabel(service)} token`,
      prompt: `Stored via "sbx secret set" (kept in the OS keychain, never in the repo)`,
      password: true,
      ignoreFocusOut: true,
    });
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
