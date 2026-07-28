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
- `npm run verify` — **the single verification command**: strict typecheck
  (`tsc --noEmit`) + esbuild bundle. Esbuild bundles without type-checking, so the
  typecheck inside `verify` is the real correctness gate. CI runs this same command.
- `npm run build` — bundle to `dist/extension.js` (esbuild), no typecheck.
- `npm run watch` — rebuild on change.
- `npm run package` — produce a `.vsix` (vsce).

Run/debug: open the folder in VS Code and press **F5** (Extension Development Host).

There is no test runner yet; verification is `npm run verify` + a manual run + direct
`sbx` probing. "Build is green" = `npm run verify` exits 0 — CI enforces it on pushes
and pull requests targeting `main`.

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

## Branches & commits

- Branching follows gitflow: `feature/<slug>`, `bugfix/<slug>`, `hotfix/<slug>`,
  `release/<x.y.z>`. Never commit directly to `main`; every pull request targets `main`.
- Commit messages are one meaningful English sentence with a capital first letter,
  describing what was done — e.g. `Added secret provisioning form for sandbox
  credentials`. No prefixes (`feat:`), no `[]` brackets. Cite `FR-0xx` IDs where relevant.
- No identity trailers in commit messages or PR bodies (no `Co-Authored-By`, no names,
  no e-mail addresses).
- Before you commit, `npx tsc --noEmit` and `npm run build` must both be green.

## Security

Do not report security vulnerabilities in public issues or pull requests. Use the
private reporting channel described in [SECURITY.md](SECURITY.md).

## Licensing

Contributions are accepted under the [MIT License](LICENSE): by opening a pull request
you agree that your contribution is licensed under the same terms as the project.
