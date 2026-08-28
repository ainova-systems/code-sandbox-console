---
name: vscode-publish-marketplace
description: "Ship a VS Code Marketplace release: pre-upload gates, the human upload gate, then the git release. Owner-invoked only."
argument-hint: "[version, e.g. 0.6.0]"
disable-model-invocation: true
---

# Publish a Marketplace release

Marketplace versions are **write-once**: a failed publish burns the number and forces a bump. So
every gate runs BEFORE the upload, and the VSIX that ships is built from `main`, never from a
branch. The agent performs every step itself except the upload in step 4.

Branching, the release commit, the PR, the tag and the GitHub Release are not described here —
`git-create-release` owns that policy and reads it from the profile (`release_cut: release-pr`,
`version_source: package.json`, `tagger: maintainer`). This skill adds only what is specific to
the Marketplace.

## 1. Confirm the target version is free

Query the gallery and check the bump target is genuinely new:

```
POST https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery
Accept: application/json;api-version=3.0-preview.1
{"filters":[{"criteria":[{"filterType":7,"value":"ainova-systems.sandbox-console"}]}],"flags":914}
```

Never reuse or lower a number. Also check `gh pr list --state open` — nothing meant for this
release is still unmerged.

## 2. Cut the release change-set

Run `git-create-release` for the version bump, the CHANGELOG section and the release PR. Two
additions it does not know about:

- CHANGELOG entries are **user language** — no FR ids, no internal jargon — mined from
  `git log v<prev>..HEAD --oneline`, with every user-visible change covered.
- README sanity while you are here: it is version-independent, but check nothing went stale (the
  agent list, the requirements, the "verified against sbx" line if the CLI moved).

## 3. Pre-upload gates — all must pass, on `main`, after the release PR merges

- `npm ci` — the lockfile is in sync; then the profile `verify` command, green.
- `npm audit` — report the count. Dev-only findings do not block, but say so explicitly.
- `npx vsce ls` — the EXACT expected list and nothing else: `THIRD_PARTY_NOTICES.txt`,
  `README.md`, `package.json`, `LICENSE`, `CHANGELOG.md`, `media/icon.png`,
  `dist/extension.js`. Anything extra is a leak. **`vsce` ignores `.gitignore` whenever
  `.vscodeignore` exists**, so a new gitignored directory still ships unless `.vscodeignore`
  lists it — fix `.vscodeignore`, never the file itself.
- Listing sanity: no "Not yet published"-class text; README image paths exist in the repo (they
  resolve against `main` at view time); external links absolute.
- `npx vsce package` — succeeds; only the known bundle-size warning is acceptable.
- Behaviour changed since the last release → acceptance via `vscode-run-local` against the
  packaged VSIX, asking the owner only where a human eye is genuinely required.

The artifact these gates pass is `sandbox-console-<x.y.z>.vsix`, built from `main`. What is in
that file is exactly what ships; there is no staging.

## 4. HUMAN GATE — the upload

Stop and ask the owner to upload, and ask for nothing else: Marketplace manage portal →
`https://marketplace.visualstudio.com/manage/publishers/ainova-systems` → the extension →
**Update** (or **+ New extension** for a first publish) → drag the VSIX. "Verifying" (the malware
scan) takes minutes. Do **not** run `vsce publish` — no PAT is provisioned, by design.

Wait for the owner to confirm the version is live, then re-run the step 1 gallery query to
double-check: the new version, `validated, public`.

## 5. Tag and publish the GitHub Release

Only after the owner confirms. `git-create-release` finishes the job — the tag on the exact
`main` commit the VSIX was built from, and the release object carrying that same
`sandbox-console-<x.y.z>.vsix` as its artifact.

## Verify

The gallery query shows the new version as `validated, public`; the GitHub Release page shows the
VSIX; the tag points at the commit the artifact was built from.

## Scope / hand-off

Not part of this skill: the Open VSX mirror, README marketplace badges, publisher-profile changes.
