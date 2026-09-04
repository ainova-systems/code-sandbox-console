#!/usr/bin/env node
/**
 * Asserts that the VSIX ships exactly the expected files — no more, no less.
 *
 *   node scripts/check-package-contents.mjs
 *
 * `vsce` ignores `.gitignore` whenever a `.vscodeignore` exists, so a new
 * directory added to the repository ships to every user unless `.vscodeignore`
 * lists it. That bites hard here: `.git/info/exclude` hides `RELEASE_PLAN.md`,
 * `.sandbox/`, `.tmp/` and the spec drafts from git, and none of that exclusion
 * reaches `vsce`. This check turns the silent leak into a failing build. When a
 * file is added on purpose, add it to EXPECTED below in the same change.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const EXPECTED = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.txt',
  'dist/extension.js',
  'media/icon.png',
  'package.json',
];

// `vsce ls` does NOT run `vscode:prepublish` (only `package` and `publish` do),
// so an unbundled tree lists no `dist/` file and it reads as "missing" — a
// confusing way to learn you forgot to build.
if (!existsSync('dist/extension.js')) {
  console.error('No build output found. Run `npm run build` before checking the package.');
  process.exit(1);
}

// `shell: true` with a fixed command string is deliberate: on Windows `npx` is
// `npx.cmd`, which Node will not resolve without a shell (spawning it with
// explicit args fails ENOENT), and this script is run locally there as well as
// in CI. There is no injection surface — the command is a literal with no
// interpolated input.
const result = spawnSync('npx vsce ls', { encoding: 'utf8', shell: true });
if (result.status !== 0) {
  console.error(result.stderr || 'vsce ls failed');
  process.exit(1);
}

// Keep only the packaged paths. Every one is a single whitespace-free token, so
// anything containing a space is prose — a vsce warning, say — and npm's `>` and
// node's `(node:...)` prefixes are dropped by the leading-character test.
const actual = result.stdout
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !/\s/.test(line) && !/^[>(]/.test(line))
  .sort();

const expected = [...EXPECTED].sort();
const unexpected = actual.filter((file) => !expected.includes(file));
const missing = expected.filter((file) => !actual.includes(file));

if (unexpected.length > 0 || missing.length > 0) {
  if (unexpected.length > 0) {
    console.error('Unexpected files in the VSIX (add them to .vscodeignore):');
    for (const file of unexpected) {
      console.error(`  + ${file}`);
    }
  }
  if (missing.length > 0) {
    console.error('Files missing from the VSIX:');
    for (const file of missing) {
      console.error(`  - ${file}`);
    }
  }
  process.exit(1);
}

console.log(`VSIX contents verified: ${actual.length} files, exactly as expected.`);
