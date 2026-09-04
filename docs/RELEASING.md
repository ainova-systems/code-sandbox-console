# Releasing

A release is one tag push. Everything after it is automated by
[`.github/workflows/release.yml`](../.github/workflows/release.yml).

```text
tag vX.Y.Z  →  guard  →  verify  →  contents  →  package  →  attest  →  GitHub Release
                                                                        ├─ Marketplace  (VSCE_PAT)
                                                                        └─ Open VSX     (OVSX_PAT)
```

## Cut a release

1. **Land everything first.** `main` is green and holds every change that ships.

2. **Write the changelog section.** Promote `## [Unreleased]` in
   [`CHANGELOG.md`](../CHANGELOG.md) into `## [X.Y.Z] - YYYY-MM-DD` — the brackets matter, the
   extractor keys off them. Write it in user language: what changed for someone using the
   extension, not which files moved and no `FR-0xx` ids. This text becomes the GitHub Release
   notes verbatim, so read it as a stranger would.

3. **Bump `version` in `package.json`** to the same `X.Y.Z`. Semantic versioning: a removed
   command or setting, or a `.sandbox/config.yaml` schema change that breaks existing recipes,
   is breaking; new commands, settings or recipe keys are a minor; everything else is a patch.

4. **Check what the release will say and ship:**

   ```bash
   npm ci
   npm run verify                              # strict tsc --noEmit + the esbuild bundle
   node scripts/check-package-contents.mjs     # exactly the 7 expected files
   node scripts/changelog-section.mjs X.Y.Z    # the release notes, as they will appear
   ```

   The contents check needs `dist/extension.js` to exist, because `vsce ls` does not run
   `vscode:prepublish`. `verify` bundles it, so run the check after `verify` — on its own, in a
   tree that was never built, it tells you to run `npm run build` first.

5. **Merge to `main`** (the release commit goes through a PR like any other change), then tag
   the merge commit and push the tag:

   ```bash
   git checkout main && git pull --ff-only
   git tag -a vX.Y.Z -m "Sandbox Console X.Y.Z"
   git push origin vX.Y.Z
   ```

6. **Watch the run.** The job summary states, per registry, whether it published or skipped and
   why.

Never move or re-cut a published tag. A pipeline failure after publishing ships as the next
patch release, not as a rewrite of the failed one — Marketplace versions are **write-once**, so
a burned number cannot be reused.

## What the pipeline enforces

Before anything is published:

- the tag, `package.json` and `CHANGELOG.md` all name the same version;
- `npm run verify` is green — strict `tsc --noEmit` plus a successful esbuild bundle. esbuild
  does not type-check, so the typecheck inside `verify` is what actually checks the code;
- the VSIX contains exactly the expected files, so a new directory cannot leak to users. This
  matters more here than the file count suggests: `vsce` honours `.vscodeignore` only, and this
  repository keeps several local paths out of git through `.git/info/exclude`, which `vsce` does
  not read at all;
- the VSIX carries a signed build-provenance attestation tying it to this workflow run and this
  commit.

## Publishing credentials

Both registry steps are skipped when their secret is absent, so the pipeline is useful before
either is configured: it still produces a verified, attested GitHub Release, and the job summary
tells you to upload the VSIX by hand.

| Secret | Registry | Effect when absent |
| --- | --- | --- |
| `VSCE_PAT` | [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=ainova-systems.sandbox-console) | The Marketplace step is skipped; upload the VSIX from the release page yourself. |
| `OVSX_PAT` | [Open VSX](https://open-vsx.org) | The Open VSX step is skipped. Not configured, and not currently mirrored there. |

Set one with the CLI, which prompts for the value hidden rather than putting it in your shell
history:

```bash
gh secret set VSCE_PAT --repo ainova-systems/code-sandbox-console
```

They are per-repository secrets, not organization-wide: a smaller blast radius, at the cost of
renewing in more than one place. The GitHub UI equivalent is **Settings → Secrets and variables
→ Actions**.

To publish a tag that was released before the secret existed, run the **Release** workflow
manually from the Actions tab and give it that tag — the GitHub Release is refreshed in place
rather than duplicated. This only works for a version not yet in the gallery: `vsce publish`
fails on a version that is already published, so re-running an already-published tag turns the
run red for nothing.

A publish step failing with a 401 usually means the token lapsed, not that the release is
broken. Rotate by revoking at the provider first, then replacing the secret and re-running the
workflow for that tag.

### Adding a manual approval gate

If you later want a human to confirm each Marketplace upload, create a GitHub Environment (say
`marketplace`) with yourself as a required reviewer, move the two publish steps into their own
job, and give that job `environment: marketplace`. The build and the GitHub Release still
complete unattended; only the registry upload waits. This is deliberately **not** configured —
the automated path is the current policy.

## Verify a release landed

The extension is already published, so there is no portal step for a new version — `vsce publish`
updates the existing listing. The Marketplace runs a malware scan that takes a few minutes and
ends at `verified`; the version is live only after it does.

```bash
curl -s -X POST https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery \
  -H 'Accept: application/json;api-version=3.0-preview.1' \
  -H 'Content-Type: application/json' \
  -d '{"filters":[{"criteria":[{"filterType":7,"value":"ainova-systems.sandbox-console"}]}],"flags":914}'
```

Look for the new version with the gallery flags `validated, public`.
