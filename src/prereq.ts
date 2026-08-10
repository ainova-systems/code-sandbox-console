import * as vscode from "vscode";
import * as images from "./images";
import * as sbx from "./sbx";

/**
 * FR-059: host prerequisites — is the machine able to run a sandbox at all, and (separately)
 * to build a custom image. One module because the answer is needed by three surfaces that
 * cannot import each other: the status bar and the New Sandbox command (`extension.ts`), the
 * Sandboxes view (`tree.ts`) and the New/Edit form (`form.ts`).
 *
 * The two prerequisites are deliberately NOT merged. `sbx` is required by everything, so its
 * absence blocks and is reported passively wherever state is shown. Host Docker is required
 * only by the custom-image path (FR-008/FR-053) — upstream is explicit that "Docker Desktop
 * is not required to use sbx" — so it is reported at the choice that needs it and nowhere
 * else. Saying otherwise would assert a requirement the product does not have.
 *
 * Probe results are not cached: readiness is exactly the thing that changes under the
 * extension (an install, a `sbx login`, a Docker Desktop start), and a cached "broken" would
 * outlive the fix — the same trap the executable-path caches used to have.
 */

const DOCS = "https://docs.docker.com/ai/sandboxes/";

export type SbxProblem = {
  ok: false;
  /** `missing` — no runnable CLI; `signed-out` — no Docker sign-in; `unhealthy` — the rest. */
  kind: "missing" | "signed-out" | "unhealthy";
  /** One line: the status-bar tooltip's first line and the dialog's message. */
  summary: string;
  /** The remedy — the CLI's own wording when `sbx diagnose` supplied one. */
  detail: string;
};

export type SbxReadiness = { ok: true } | SbxProblem;

function notFound(): SbxProblem {
  const looked = sbx.sbxCandidates();
  return {
    kind: "missing",
    ok: false,
    summary: "Docker Sandboxes (sbx) was not found.",
    detail:
      (looked.length > 0
        ? `Looked for it at ${looked.join(", ")} and on PATH.`
        : "Looked for it on PATH.") +
      "\n\nInstall Docker Sandboxes, then sign in with `sbx login`. It runs its own " +
      "runtime — Docker Desktop is not required.",
  };
}

/** Compose a failed check into the remedy text, preferring the CLI's own hint. */
function fromCheck(check: sbx.DiagnosticCheck): string {
  return [check.message, check.detail, check.hint]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

/**
 * Can this machine run sandboxes? Answered by `sbx diagnose -o json` (the CLI's own
 * readiness report) rather than by inferring from a failed `ls`: it names which precondition
 * broke and costs the same as the `sbx version` probe it replaces.
 *
 * An sbx too old to know `diagnose` still answers `version`, and is treated as ready — this
 * check exists to explain a broken install, never to add a version requirement of its own.
 */
export async function sbxReadiness(): Promise<SbxReadiness> {
  const checks = await sbx.diagnose();
  if (checks === undefined) {
    return (await sbx.available()) ? { ok: true } : notFound();
  }
  // Only `fail` blocks. A `warn` is the CLI flagging something suboptimal that it can still
  // work through, and turning those into a refusal would block installs that work.
  const failed = checks.filter((c) => c.status?.toLowerCase() === "fail");
  if (failed.length === 0) {
    return { ok: true };
  }
  const binary = failed.find((c) => /binary|cli/i.test(c.name));
  if (binary) {
    return notFound();
  }
  const auth = failed.find((c) => /auth/i.test(c.name));
  if (auth) {
    return {
      ok: false,
      kind: "signed-out",
      summary: "Docker Sandboxes (sbx) is installed but not signed in.",
      detail:
        fromCheck(auth) ||
        "Run `sbx login` in a terminal to sign in to Docker, then retry.",
    };
  }
  // Anything else is reported in the CLI's own words rather than guessed at — the check
  // names are Docker's, and a version that adds a new one must not become "unknown error".
  const first = failed[0];
  return {
    ok: false,
    kind: "unhealthy",
    summary: `Docker Sandboxes (sbx) is not ready: ${first.name} — ${
      first.message || "check failed"
    }.`,
    detail:
      [fromCheck(first)]
        .concat(
          failed.slice(1).map((c) => `${c.name}: ${c.message || "check failed"}`)
        )
        .filter(Boolean)
        .join("\n\n") || "Run `sbx diagnose` for the full report.",
  };
}

/** The status-bar tooltip: what is missing, then what to do about it (FR-059). */
export function tooltip(problem: SbxProblem): string {
  return `${problem.summary}\n\n${problem.detail}\n\nClick for details.`;
}

/**
 * Explain a missing prerequisite and end the action. Modal, not a notification: it refuses
 * something the user just asked for and the explanation does not fit one line — the same
 * rule as the FR-058 mount refusal. A notification here auto-dismissed, leaving a button
 * that did nothing and no way back to the reason.
 */
export async function showSbxProblem(problem: SbxProblem): Promise<void> {
  const action = problem.kind === "missing" ? "Install instructions" : "Troubleshooting";
  const choice = await vscode.window.showErrorMessage(
    `Sandbox Console: ${problem.summary}`,
    { modal: true, detail: problem.detail },
    action
  );
  if (choice === action) {
    await vscode.env.openExternal(vscode.Uri.parse(DOCS));
  }
}

/**
 * Gate an action on a usable sbx, explaining and refusing when there is none. Returns
 * whether the caller may proceed.
 */
export async function requireSbx(): Promise<boolean> {
  const readiness = await sbxReadiness();
  if (readiness.ok) {
    return true;
  }
  await showSbxProblem(readiness);
  return false;
}

/**
 * The host-Docker requirement for the custom-image modes, or undefined when a build could
 * run now (FR-059). Advisory by design: it is shown where the mode is chosen so the
 * requirement is known before the form is filled in, while the build itself stays the gate —
 * Docker Desktop may well have been started in between.
 */
export async function dockerNotice(): Promise<string | undefined> {
  const state = await images.dockerState();
  return state === "ready" ? undefined : images.dockerRequirement(state);
}
