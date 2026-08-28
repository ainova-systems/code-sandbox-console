---
name: spec-draft
description: "Draft the next append-only iteration spec in docs/specs plus its docs-sync checklist, before implementing a substantial change"
argument-hint: "<what the change is>"
---

# Draft the next iteration spec

Domain note: `spec-` here is this repository's own append-only iteration model — numbered
`00N - <Iteration>.md` files plus two canonical docs. It is not the `@ainova-systems/spec`
package's `NNN-<slug>/` requirements-and-plan model, which this project does not install.

Turns a described work item into the next `docs/specs/00N - <Iteration>.md` and a checklist of
canonical-doc updates. This skill only drafts the spec — it never edits `docs/Features.md` or
`docs/Architecture.md`, which change together with the implementation in the same PR.

Use it for a substantial change: a new FR, a behaviour change, or an architectural shift. A
trivial fix skips the spec.

## Steps

1. Read the sections of `docs/Features.md` and `docs/Architecture.md` the work item touches.
2. **Number it.** List `docs/specs/drafts/` and `docs/specs/completed/` and take the next `00N` —
   numbering is continuous across both folders. Specs are append-only and immutable once merged;
   never renumber or edit an existing one.
3. **Reserve the FR id.** If the item adds or changes behaviour, find the highest `FR-0xx` in
   `docs/Features.md` and reserve the next id for the implementation to use. Never renumber
   existing ids.
4. **Draft** `docs/specs/drafts/00N - <Short Title>.md`, following the shape of the existing
   specs — open `docs/specs/completed/009 - Read-Only Discovery.md` as the reference:
   - Header blockquote: the "Iteration spec — immutable history" note, then
     `**Period:** <today> · **Base:** \`main\` after spec 00N-1`, then the status line
     `**Status: planned.**` The implementing PR flips it to
     `**Status: shipped with this iteration.**` before merge.
   - `## What & why` — the problem in the product's terms, citing FR ids.
   - `## What changed` — the planned changes, rewritten to past tense as they ship.
5. **Settle the open questions here**, in the spec, before any code. The "What & why" and "What
   changed" sections ARE the plan.
6. **End with the docs-sync checklist**: the exact list of canonical-doc updates the implementing
   PR must contain — which `Features.md` sections and FR entries, and which `Architecture.md`
   sections change.

## Verify

The new file is the next continuous number, carries `Status: planned`, cites real FR ids, and the
reply ends with the docs-sync checklist the implementing PR will be held to.

## Scope / hand-off

Implementation is `spec-implement`, which picks up this spec and its checklist.
