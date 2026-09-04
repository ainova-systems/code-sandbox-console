#!/usr/bin/env node
/**
 * Prints the body of one CHANGELOG section.
 *
 *   node scripts/changelog-section.mjs 0.5.0
 *
 * The release workflow uses this for the GitHub Release notes, so an unreleased
 * or misspelled version fails the release instead of publishing empty notes.
 * Run it by hand before tagging to see exactly what the release will say.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version) {
  console.error('usage: node scripts/changelog-section.mjs <version>');
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');

// Sections are `## [x.y.z] - date`; the body runs to the next `## [` or EOF.
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const heading = new RegExp(`^## \\[${escaped}\\][^\\n]*$`, 'm');
const match = heading.exec(changelog);
if (!match) {
  console.error(`CHANGELOG.md has no section for ${version}.`);
  process.exit(1);
}

const rest = changelog.slice(match.index + match[0].length);
const next = /^## \[/m.exec(rest);
const body = (next ? rest.slice(0, next.index) : rest).trim();

if (body.length === 0) {
  console.error(`The CHANGELOG section for ${version} is empty.`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
