# 010 — Marketplace Release

> **Iteration spec — immutable history.** Describes what changed in this iteration and
> why. The current truth lives in [`../Architecture.md`](../Architecture.md) and
> [`../Features.md`](../Features.md); where this spec disagrees with them, they win.
>
> **Period:** 2026-07-28 · **Base:** `main` after spec 009
>
> **Status: shipped with this iteration.** No runtime behaviour changed — this is the
> packaging, storefront, and legal surface of the first public release
> (`ainova-systems.sandbox-console` v0.2.0, published as a stable release by
> MB Ainova Systems).

## What & why

Everything up to spec 009 was built as if the extension were already public, but it had
never actually been published. A pre-release audit of the storefront surface found that
the artefacts a Marketplace visitor sees first were still written for the internal
audience:

- **No icon.** `package.json` had no `icon`, so both the Marketplace tile and the
  Extensions view would render the grey placeholder — the single most visible signal
  that a listing is unfinished.
- **The README was internal documentation, not a listing.** The Marketplace renders
  `README.md` as the entire listing body, and that body opened with dense architectural
  prose, stated *"Not yet published to the VS Code Marketplace"* (on the page that would
  prove otherwise), carried no screenshot and no command reference, and understated the
  Docker prerequisite, Workspace Trust, and the Windows-only parts of the credential
  cache.
- **The CHANGELOG was internal history.** The Changelog tab is public from day one, but
  the 0.2.0 entry was dated for a pre-release, missed two shipped iterations (008, 009),
  and explained a rebrand from a name (*Ainoflow Sandbox Terminal*) that no user has ever
  seen, alongside command-id detail that means nothing outside the repo.
- **The LICENSE named a trading name**, not the legal entity that owns the copyright and
  the publisher account.
- **The production bundle shipped a sourcemap** (`sourcemap: true` unconditionally in
  `esbuild.js`), roughly doubling the VSIX payload with a debug artefact.
- **Repository hygiene** — topics, private vulnerability reporting, and a reporting
  policy that pointed at a feature that was not switched on — did not match what the
  SECURITY.md text promised.

None of this touches the sandbox model; it is entirely about being publishable and
honest on the storefront.

## What changed

- **Marketplace manifest metadata (`package.json`).** Added `icon` pointing at the new
  `media/icon.png`, `preview: true` (a 0.x first release: the listing says so instead of
  the README apologising for it), `pricing: "Free"`, a `qna` pointing at the repository's
  GitHub issues, and a `galleryBanner` so the listing header is themed rather than
  default-grey. Publisher stays `ainova-systems`; the display name shown on the
  Marketplace is **MB Ainova Systems**.
- **Icon asset.** `media/icon.png` is the first image asset in the repo. It lives in
  `media/`, *not* `docs/`, because `.vscodeignore` excludes `docs/**` from the VSIX — the
  icon must ship inside the package, screenshots must not.
- **README rewritten as a storefront page.** It now opens with what the extension does
  and who it is for, reserves a hero-imagery slot ahead of the prose, states the real
  prerequisites (the Docker Sandboxes `sbx` CLI — Docker Desktop only for the
  custom-Dockerfile mode — Workspace Trust, the files written into `.sandbox/` and
  when), documents the commands and the Windows-specific behaviour of the credential
  cache, and carries the trademark/affiliation disclaimer for the Docker and Anthropic
  marks. Screenshots referenced from the README belong in `docs/media/` (captured as a
  release-runbook step) and are therefore repo-only, not VSIX payload.
- **CHANGELOG turned into public release notes.** 0.2.0 is dated `2026-07-28` and no
  longer marked pre-release; the two iterations shipped after it was first drafted are
  folded into it (lifecycle progress notifications from spec 008, quiet and read-only
  startup discovery from spec 009). Internal vocabulary is gone — no rebrand-from-an-
  unreleased-name bullet, no command-id namespaces, no `FR-0xx` citations (those stay in
  the code, commits, and these specs). The never-published 0.1.0 entry is kept but
  compressed and explicitly labelled an internal proof of concept, and version headings
  no longer use bracket link syntax without link definitions: 0.2.0 links to its release
  tag, 0.1.0 (which has no release) is plain text.
- **LICENSE copyright holder corrected** to `MB Ainova Systems` — the legal entity behind
  the publisher account — instead of the trading name.
- **Sourcemap removed from production builds.** `esbuild.js` emits a sourcemap only in
  watch/development mode, so the published VSIX carries the bundle alone.
- **Security and contribution policy match reality.** SECURITY.md now names GitHub
  private vulnerability reporting as the *only* channel (with a direct advisory-form
  link, the information a report must contain, and acknowledgement/fix targets) and
  states a supported-versions policy; enabling the corresponding repository features and
  topics on GitHub itself is a required release-runbook step, since the reporting link
  is dead until private vulnerability reporting is switched on. CONTRIBUTING.md gained
  the branch/commit rules, the
  "never report vulnerabilities in public" pointer, and the inbound-license statement.
- **One documentation drift fixed.** Architecture §8 claimed secret values never travel
  through environment variables. That is true of the extension, but the generated project
  CLI (§13) resolves its GitHub PAT *project blob → shared blob → `GITHUB_SANDBOX_PAT`*
  for CI/automation. §8 now carries that carve-out explicitly, so the section a
  security-minded reader will quote matches the shipped code.

## Decisions

- **Stable release, not a pre-release channel.** v0.2.0 is published as a normal stable
  release; `preview: true` communicates early-stage maturity on the listing itself. A
  separate pre-release channel would split the audience for a first publish with no users
  to split.
- **`preview` on the listing, not disclaimers in the README.** Maturity is expressed once,
  in the manifest, where the Marketplace renders it as a badge. The README sells the
  product; it does not apologise for it.
- **The changelog is a user document, not a traceability record.** `FR-0xx` IDs remain
  mandatory in code, commit messages, and iteration specs, and are deliberately absent
  from CHANGELOG.md — the traceability chain runs commit → spec → Features.md, none of
  which the Marketplace renders.
- **Ship the icon, never the screenshots.** `.vscodeignore` already drops `docs/**`, so
  image assets are split by destination: package assets in `media/`, listing/README
  imagery in `docs/media/`. This keeps the VSIX small without a second ignore rule.
- **GitHub private vulnerability reporting is the only security channel.** No e-mail
  address is published: an address on a public policy page is a permanent, unrotatable
  contact surface, and the advisory form already gives reporters a private, tracked
  channel.
- **No new FR, no behaviour change.** Nothing under `src/` changes semantics in this
  iteration; Features.md is untouched and Architecture.md changes only by the §8
  clarification above.
