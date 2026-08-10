import * as log from "./log";

/**
 * Read-only host git probes (FR-058). Git gets its own module for the same reason `sbx`
 * has one: the argv for an external CLI lives in exactly one place. Nothing here mutates
 * a repository — the extension never runs a git command that changes what the user's
 * working copy contains (spec 015, "refuse, don't fix").
 */

/**
 * FR-058: is the repository containing `dir` shallow — i.e. cloned or fetched with
 * `--depth`, so its history is truncated at the commits listed in `.git/shallow`?
 *
 * Matters for `mount: clone` only: sbx builds the sandbox's copy with
 * `git clone --reference <read-only host mount>`, and git refuses a shallow reference
 * (shallowness lives in the repository, not in the object store it would borrow).
 *
 * `-C` rather than a spawn cwd, so the probe resolves the *containing* repository —
 * matching sbx's own precondition, which accepts a workspace **inside** a repository
 * ("--clone requires a Git repository, but <path> is not in a Git repository").
 *
 * Fails open (`false`) on every failure — no git on the host, no repository, an ancient
 * git without `--is-shallow-repository`. A false refusal would be worse than the failure
 * it prevents, and nothing is lost: sbx rejects a non-repository workspace itself, before
 * creating anything. Quiet: this runs on a create path, and the log already brackets the
 * sbx calls around it (FR-055 still records it if it fails).
 */
export async function isShallowRepository(dir: string): Promise<boolean> {
  const { stdout, code } = await log.run(
    "git",
    ["-C", dir, "rev-parse", "--is-shallow-repository"],
    { quiet: true }
  );
  return code === 0 && stdout.trim() === "true";
}
