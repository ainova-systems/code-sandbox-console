import * as vscode from "vscode";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as path from "path";

/**
 * FR-055: the operation log. Every `sbx` / `docker` child process the extension runs is
 * bracketed here — a `$ <exe> <args…>` header, the child's own output streamed through
 * verbatim, then `→ exit <code> (<duration>)` — so a multi-minute build is readable while
 * it runs instead of only after it ends.
 *
 * Deliberately a plain OutputChannel, not a LogOutputChannel: level prefixes and
 * per-line timestamps are right for a trace and wrong for `docker build` output, which
 * users read as build output.
 *
 * Two containment rules this module must keep:
 * - It owns process plumbing only. CLI *strings* stay in `sbx.ts` / `images.ts`
 *   (CLAUDE.md "Backend model") — nothing here knows what an sbx subcommand is.
 * - Secret values never reach the channel. `sbx.runWithStdin` (FR-032) logs its header
 *   through `header()` and pipes the value itself outside this runner.
 */

let channel: vscode.OutputChannel | undefined;

function out(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Sandbox Console");
  }
  return channel;
}

/** Reveal the log without stealing focus from the editor. */
export function show(): void {
  out().show(true);
}

export function dispose(): void {
  channel?.dispose();
  channel = undefined;
}

/**
 * Invocations are numbered because they interleave: operations on *different* sandboxes
 * run in parallel by design (FR-054 only serialises one sandbox), so without a tag a
 * concurrent `stop`'s header lands between another command's header and its exit line and
 * the log stops being readable. Every line of one invocation carries the same `[n]`.
 */
let seq = 0;

function tag(id: number): string {
  return `[${id}] `;
}

/**
 * Log a command that must NOT stream — the secret path (FR-032): the header is recorded so
 * the log shows that it ran, the piped value and the child's output never are. Returns the
 * closer that writes the exit line under the same tag.
 */
export function opaqueCommand(
  exe: string,
  args: string[]
): (code: number) => void {
  const id = ++seq;
  out().appendLine(`${tag(id)}$ ${path.basename(exe)} ${args.join(" ")}`.trimEnd());
  return (code) => out().appendLine(`${tag(id)}→ exit ${code}`);
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * What a long operation passes down so the CLI wrappers can report into its progress
 * notification and stop when it is cancelled. Optional everywhere: a call made outside a
 * progress box (discovery, probes) simply omits it.
 */
export interface OpContext {
  /** FR-056: cancelling kills the running child. */
  token?: vscode.CancellationToken;
  /** FR-055: every complete output line, newest wins in the notification message. */
  onLine?: (line: string) => void;
}

export interface RunOptions extends OpContext {
  /**
   * Discovery/probe calls (`ls --json`, `template ls`, `--help`) run on focus change and
   * tree render; streaming them would bury the operations. Quiet calls are logged only
   * when they fail — which is a gain, since several of those callers swallow the error.
   */
  quiet?: boolean;
  /**
   * Whether cancelling may kill this child (default true). `false` means "let it finish,
   * the caller undoes it afterwards" — the only safe option for a command whose partial
   * state its own tooling cannot clean up. See `sbx.run` for why every sbx call sets it.
   */
  killOnCancel?: boolean;
}

/**
 * Retained output per stream. The child is never killed for exceeding it — only the buffer
 * stops growing, and the **tail** is what survives, which is where a failing command's
 * error text lives.
 *
 * This lowers the ceiling for `docker` (the old execFile runner allowed 64 MB) and keeps
 * it for `sbx` (4 MB). Deliberate: nothing parses docker output — it only feeds error
 * messages, which want the end — while every parsed output (`ls --json`, `template ls`,
 * `--help`) is orders of magnitude below the cap. Retaining 64 MB per build in the
 * extension host to preserve the head of a build log nobody reads is the worse trade.
 */
const MAX_RETAINED = 4 * 1024 * 1024;

function appendCapped(buffer: string, chunk: string): string {
  const next = buffer + chunk;
  return next.length > MAX_RETAINED ? next.slice(next.length - MAX_RETAINED) : next;
}

/** Kill the child. On Windows `child.kill()` leaves grandchildren (docker's own workers)
 * running, so take the whole tree. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
      }).on("error", () => undefined);
    } catch {
      // best effort — the operation is being abandoned either way
    }
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Run a child process, streaming its output to the log and to `onLine`, and resolve with
 * the accumulated text — never rejecting, so callers keep their `code`-based error
 * handling. A cancelled call kills the child and resolves like any other failure: the
 * caller's stage boundary is what turns that into a clean "cancelled" outcome (FR-056),
 * so no error path here has to know about cancellation.
 */
export function run(
  exe: string,
  args: string[],
  opts: RunOptions = {}
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const started = Date.now();
    const mark = tag(++seq);
    const head = `${mark}$ ${path.basename(exe)} ${args.join(" ")}`.trimEnd();
    if (!opts.quiet) {
      out().appendLine(head);
    }
    // Every exit goes through this, so the header + lines + exit bracketing holds on all
    // paths — including a spawn that throws before there is a child to listen to.
    const writeTail = (code: number): void =>
      out().appendLine(
        `${mark}→ exit ${code} (${formatDuration(Date.now() - started)})`
      );
    let stdout = "";
    let stderr = "";
    // Carry incomplete lines between chunks so a line split across reads is emitted once.
    let pending = "";
    const emit = (chunk: string, final = false): void => {
      pending += chunk;
      // \r as well as \n: progress-style writers redraw in place, and each redraw is a
      // meaningful "what is happening now" line for the notification.
      const parts = pending.split(/\r\n|\r|\n/);
      pending = final ? "" : (parts.pop() ?? "");
      for (const line of parts) {
        if (!line.trim()) {
          continue;
        }
        if (!opts.quiet) {
          out().appendLine(`${mark}  ${line}`);
        }
        opts.onLine?.(line);
      }
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(exe, args, { windowsHide: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (opts.quiet) {
        out().appendLine(head); // quiet calls log only on failure — this is one
      }
      out().appendLine(`${mark}  ${message}`);
      writeTail(1);
      resolve({ stdout: "", stderr: message, code: 1 });
      return;
    }

    const mayKill = opts.killOnCancel ?? true;
    const cancel = opts.token?.onCancellationRequested(() => {
      if (!opts.quiet) {
        out().appendLine(
          mayKill
            ? `${mark}  … cancelled, terminating`
            : `${mark}  … cancel requested — letting this finish so it can be undone cleanly`
        );
      }
      if (mayKill) {
        killTree(child.pid);
      }
    });
    if (mayKill && opts.token?.isCancellationRequested) {
      killTree(child.pid); // cancelled between the check above and the spawn
    }

    child.stdout?.on("data", (d: Buffer) => {
      const text = d.toString();
      stdout = appendCapped(stdout, text);
      emit(text);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr = appendCapped(stderr, text);
      emit(text);
    });

    // A failed spawn emits "error" and then "close"; settle on whichever comes first.
    let settled = false;
    const finish = (code: number, message?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      cancel?.dispose();
      emit(message ? `${message}\n` : "", true);
      if (opts.quiet) {
        // A quiet call that failed is worth the three lines: several callers turn a
        // non-zero exit into a silent `false`/`[]`, so this is the only trace of it.
        if (code !== 0) {
          out().appendLine(head);
          // `message` (a spawn failure such as ENOENT) never reached the stream handlers,
          // and the quiet `emit` above dropped it — include it, or "sbx not installed"
          // would show as a bare non-zero exit.
          const text = (stderr || stdout || message || "").trim();
          if (text) {
            out().appendLine(`${mark}  ${text.replace(/\r?\n/g, `\n${mark}  `)}`);
          }
          writeTail(code);
        }
      } else {
        writeTail(code);
      }
      resolve({ stdout, stderr: stderr || message || "", code });
    };

    child.on("error", (err) => finish(1, err.message));
    child.on("close", (code) => finish(code ?? 1));
  });
}
