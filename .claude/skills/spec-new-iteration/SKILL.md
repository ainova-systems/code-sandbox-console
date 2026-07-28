---
name: spec-new-iteration
description: Start a substantial change by drafting the next append-only iteration spec in docs/specs plus the docs-sync checklist. Use before implementing any substantial change - a new FR, a behaviour change, or an architectural shift (see CLAUDE.md "Documentation model").
---

# spec-new-iteration

Turns a described work item into the next `docs/specs/00N - <Iteration>.md` and a checklist of
canonical-doc updates. This skill only drafts the spec; it never edits `docs/Features.md` or
`docs/Architecture.md` itself - those change together with the implementation, in the same PR.

## Steps

1. Read CLAUDE.md "Documentation model", then the sections of `docs/Features.md` and
   `docs/Architecture.md` the work item touches.
2. **Number**: list `docs/specs/` and take the next `00N`. Specs are append-only and immutable
   once merged - never renumber or edit an existing one.
3. **FR id**: if the item adds or changes behaviour, find the highest `FR-0xx` in
   `docs/Features.md` and reserve the next id for the implementation to use. Never renumber
   existing ids.
4. **Draft** `docs/specs/00N - <Short Title>.md` following the shape of the existing specs
   (open `009 - Read-Only Discovery.md` as the reference):
   - Header blockquote: the "Iteration spec - immutable history" note, then
     `**Period:** <today> · **Base:** \`main\` after spec 00N-1`, then a status line.
     Use `**Status: planned.**` while the work is open; the implementing PR flips it to
     `**Status: shipped with this iteration.**` before merge.
   - `## What & why` - the problem in the product's terms, citing FR ids.
   - `## What changed` - the planned changes (rewritten to past tense as they ship).
5. **Docs-sync checklist**: end your reply with the exact list of canonical-doc updates the
   implementing PR must contain - which `Features.md` sections / FR entries and which
   `Architecture.md` sections change. The canonical docs must never drift from shipped code.

## Hand-off

Implementation follows the `spec-implement` skill, which picks up the spec and the checklist.
