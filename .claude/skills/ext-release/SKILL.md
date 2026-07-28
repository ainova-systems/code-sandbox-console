---
name: ext-release
description: Ship a Marketplace release end to end - release branch with version bump and changelog, full pre-release validation (verify, audit, vsce ls, listing sanity), PR to main, final VSIX built from main, a human pause for the Marketplace upload, then git tag and GitHub Release with the same artifact. Use for every release of the extension.
---

# ext-release

The agent performs EVERY step of this skill itself — branching, version bump, changelog,
validations, PR, merge, packaging, tag, GitHub Release. The owner's only action is the
Marketplace upload in step 6 (and confirming it went live); ask for exactly that and
nothing else. Versions are **write-once** on the Marketplace — a failed publish burns the
number and forces a bump, so every gate runs BEFORE the upload.

## 1. Preconditions

- On `main`, pulled, clean tree. `gh pr list --state open` — nothing meant for this
  release is still unmerged.
- Live published version: query the gallery and confirm the bump target is new:
  `POST https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery` with
  `{"filters":[{"criteria":[{"filterType":7,"value":"ainova-systems.sandbox-console"}]}],"flags":914}`
  (header `Accept: application/json;api-version=3.0-preview.1`).

## 2. Release branch: version + changelog

1. Branch `release/<x.y.z>` off `main` (gitflow; x.y.z = the new version).
2. **Version bump** in `package.json` — strict SemVer `major.minor.patch`, no suffixes;
   patch = fixes only, minor = features, major = breaking. Never reuse or lower a number.
3. **CHANGELOG.md**: new `## [x.y.z] - <today>` section on top — user-language release
   notes (no FR ids, no internal jargon), mined from `git log v<prev>..HEAD --oneline`;
   every user-visible change covered. Add the link definition
   `[x.y.z]: https://github.com/ainova-systems/code-sandbox-console/releases/tag/v<x.y.z>`.
4. README sanity while here: version-independent, but check nothing became stale
   (agent list, requirements, "verified against sbx" line if the CLI moved).

## 3. Pre-release validation (all must pass)

- `npm ci` — lockfile in sync; `npm run verify` — green; `npm audit` — report the count
  (dev-only findings do not block, but say so explicitly).
- `npx vsce ls` — the EXACT expected list and nothing else: THIRD_PARTY_NOTICES.txt,
  README.md, package.json, LICENSE, CHANGELOG.md, media/icon.png, dist/extension.js.
  Anything extra is a leak — remember vsce ignores `.gitignore` whenever
  `.vscodeignore` exists; fix `.vscodeignore`, not the file.
- Listing sanity: no "Not yet published"-class text; README image paths exist in the
  repo (they resolve against `main` at view time); external links absolute.
- `npx vsce package` — succeeds; only the known bundle-size warning is acceptable.
- Behaviour changed since last release → acceptance via `ext-run-local`: the agent
  installs the packaged VSIX and drives the touched FR flows itself, asking the owner
  only where a human eye is genuinely required.

## 4. Land it

`git-commit-push` → `git-open-pr` (PR title = release sentence, How to Verify lists the
gates above) → CI green → `git-merge-pr`. Then `git checkout main && git pull`.

## 5. Final artifact — always from main

`npm ci && npm run verify && npx vsce package` → `sandbox-console-<x.y.z>.vsix`.
What is in this file is exactly what ships; there is no staging.

## 6. HUMAN GATE — upload

Stop and ask the owner to upload: Marketplace manage portal →
`https://marketplace.visualstudio.com/manage/publishers/ainova-systems` → the
extension → **Update** (or `+ New extension` for a first publish) → drag the VSIX.
"Verifying" (malware scan) takes minutes. Do NOT run `vsce publish` — no PAT is
provisioned by design. Wait for the owner to confirm the version is live (re-run the
gallery query from step 1 to double-check: version + `validated, public`).

## 7. Tag + GitHub Release (after the owner confirms)

- `git tag v<x.y.z> && git push origin v<x.y.z>` — on the exact `main` commit the VSIX
  was built from.
- `gh release create v<x.y.z> sandbox-console-<x.y.z>.vsix --title "Sandbox Console <x.y.z>"`
  with notes distilled from the CHANGELOG section (identity ban applies — no agent/user
  names). The CHANGELOG link definition from step 2 now resolves.
- Post-check: gallery query shows the new version; the release page shows the artifact.

## Hand-off

Marketplace and GitHub now agree on the version. Follow-ups that are NOT part of this
skill: Open VSX mirror, README marketplace badges, publisher-profile changes.
