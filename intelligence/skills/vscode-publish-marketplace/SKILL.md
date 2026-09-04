---
name: vscode-publish-marketplace
description: "Ship a VS Code Marketplace release: pre-tag gates, then the tag that triggers the automated release pipeline. Owner-invoked only."
argument-hint: "[version, e.g. 0.6.0]"
disable-model-invocation: true
---

# Publish a Marketplace release

Publishing is automated. Pushing a `vX.Y.Z` tag runs
`.github/workflows/release.yml`, which guards, verifies,
packages, attests, publishes the GitHub Release and then publishes to the Marketplace. **Do not
upload by hand and do not run `vsce publish` locally** — the pipeline owns the upload, and a
manual one races it for a write-once version number.

Marketplace versions are write-once: a failed publish burns the number and forces a bump. The
pipeline runs every gate before its first publish step for exactly that reason. This skill is the
work that happens *before* the tag, plus confirming what the pipeline did after it.

Branching, the release commit, the PR, the tag and the GitHub Release are not described here —
`git-create-release` owns that policy and reads it from the profile (`release_cut: release-pr`,
`version_source: package.json`, `tagger: maintainer`; a person pushes the tag, CI does the rest).
The full runbook, including credential behaviour, is `docs/RELEASING.md`.

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

Run `git-create-release` for the version bump, the CHANGELOG section and the release PR. Three
additions it does not know about:

- The CHANGELOG heading must be `## [X.Y.Z] - YYYY-MM-DD`. The brackets are load-bearing:
  `scripts/changelog-section.mjs` keys off them and the pipeline fails the release rather than
  publishing empty notes. That section becomes the GitHub Release body verbatim.
- CHANGELOG entries are **user language** — no FR ids, no internal jargon — mined from
  `git log v<prev>..HEAD --oneline`, with every user-visible change covered.
- README sanity while you are here: it is version-independent, but check nothing went stale (the
  agent list, the requirements, the "verified against sbx" line if the CLI moved).

## 3. Pre-tag gates — on `main`, after the release PR merges

The pipeline re-runs all of these; running them locally first means a failure costs a fixup
commit rather than a burned tag.

- `npm ci` — the lockfile is in sync; then `npm run verify`, green.
- `npm audit` — report the count. Dev-only findings do not block, but say so explicitly.
- `node scripts/check-package-contents.mjs` — the exact expected list and nothing else. Run it
  after `verify`, which produces the `dist/extension.js` that `vsce ls` needs but does not build
  itself. A failure names the offending file; fix `.vscodeignore` and add the file to the
  script's `EXPECTED` only when it genuinely belongs in the VSIX.
- `node scripts/changelog-section.mjs <x.y.z>` — read the notes as they will appear.
- Listing sanity: no "Not yet published"-class text; README image paths exist in the repo (they
  resolve against `main` at view time); external links absolute.
- Behaviour changed since the last release → acceptance via `vscode-run-local` against a locally
  packaged VSIX, asking the owner only where a human eye is genuinely required.

## 4. Tag, and let the pipeline publish

`git-create-release` finishes the job: the tag on the exact `main` commit that passed the gates.
Pushing it is the publish.

Then watch the run (`gh run watch`, or the Actions tab). Its job summary states, per registry,
whether it published or skipped and why:

- **Marketplace: published** — the happy path.
- **Marketplace: skipped — no `VSCE_PAT` secret** — the pipeline degraded gracefully. The GitHub
  Release exists, verified and attested; only the gallery upload is outstanding. Tell the owner,
  and point them at `gh secret set VSCE_PAT --repo ainova-systems/code-sandbox-console` (it
  prompts hidden) followed by a manual re-run of the **Release** workflow for that tag. **Never
  ask for the token value or accept it in conversation.** Uploading the VSIX from the release
  page through the manage portal is the other way out, but it makes the next release's automation
  the only automated one.

Do not "dry run" the workflow against an already-published tag: the GitHub Release step would
refresh its asset happily, but `vsce publish` fails on a version already in the gallery and the
run goes red for nothing.

## Verify

The workflow run is green; the gallery query from step 1 shows the new version as
`validated, public` (the malware scan takes a few minutes, so it is not instant); the GitHub
Release page shows `sandbox-console-<x.y.z>.vsix` with its provenance attestation; the tag points
at the commit the artifact was built from.

## Scope / hand-off

Not part of this skill: the Open VSX mirror (the pipeline step exists but `OVSX_PAT` is not
configured), README marketplace badges, publisher-profile changes, and credential provisioning
itself — that is the owner's, and `docs/RELEASING.md` describes only its behaviour.
