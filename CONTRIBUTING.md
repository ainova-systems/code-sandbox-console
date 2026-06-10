# Contributing

Thanks for helping improve Sandbox Console. The codebase is small and the workflow
is simple, but a few conventions are load-bearing — please read this before opening a PR.

## Prerequisites

- Node.js 20+
- VS Code 1.90+
- [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) (`sbx`) installed and
  signed in — required for manual testing; the extension is a thin orchestration
  layer over the `sbx` CLI.

## Build & check

- `npm install` — dependencies.
- `npm run build` — bundle to `dist/extension.js` (esbuild).
- `npm run watch` — rebuild on change.
- `npx tsc --noEmit` — typecheck (strict). **This is the real correctness gate** —
  esbuild bundles without type-checking, so always run `tsc` too.
- `npm run package` — produce a `.vsix` (vsce).

Run/debug: open the folder in VS Code and press **F5** (Extension Development Host).

There is no test runner yet; verification is `tsc --noEmit` + a manual run + direct
`sbx` probing. "Build is green" = `tsc --noEmit` clean AND `npm run build` succeeds —
CI enforces both on pushes and pull requests targeting `main`.

## Pull requests

- `docs/Features.md` is authoritative for behaviour — cite `FR-0xx` IDs in code and
  commit messages for traceability.
- Read `docs/Architecture.md` before changing backend behaviour, and verify any
  `sbx` CLI assumption against the upstream
  [Docker Sandboxes docs](https://docs.docker.com/ai/sandboxes/).
- Substantial changes follow the documentation model (see `CLAUDE.md`): add the next
  `docs/specs/00N - <Iteration>.md` spec describing what/why, and update
  `Features.md`/`Architecture.md` to match in the same PR — the canonical docs must
  never drift from shipped code. Specs are immutable once merged.
- Keep `sbx` CLI strings in `src/sbx.ts` (all child-process invocations) and
  `src/terminal.ts` (the interactive `sbx run`/`exec` shellArgs) — those two
  modules only. One deliberate carve-out: the bash template in `src/script.ts`
  *renders* sbx calls into the generated `.sandbox/scripts/sbx.sh` (FR-052) for
  external shells — the extension itself never executes them; keep that template
  mirroring `sbx.ts`/`ops.ts` when CLI shapes change.
- Keep changes minimal and focused; match the existing code style.
