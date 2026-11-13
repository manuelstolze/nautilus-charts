# Architecture decisions

This folder holds Charts's architecture decision records (ADRs). An ADR records that a decision was made and why. [CONSTITUTION.md](../../CONSTITUTION.md) holds the mandatory rules; a rule that comes from an ADR names it.

## When to write one

Write an ADR only when a decision is hard to reverse, would surprise a reader without context, and was a real trade-off between alternatives. Skip it when any of the three is missing.

## Format and numbering

Follow [the ADR format](../../.agents/skills/engineering/domain-modeling/ADR-FORMAT.md). Name the file `NNNN-<slug>.md`, with the next free four-digit number.

## Changing a decision

Do not rewrite an accepted ADR. Record a changed decision in a new ADR that names the one it replaces, and add `Superseded by ADR NNNN` at the top of the old one. Fixing typos and broken links is allowed.

When a changed decision affects a constitution rule, change the rule through the `update-constitution` skill and update its ADR reference in the same change.
