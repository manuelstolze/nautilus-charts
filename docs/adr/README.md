# Architecture decisions

This folder holds Charts's architecture decision records (ADRs). An ADR records that a decision was made and why. [CONSTITUTION.md](../../CONSTITUTION.md) holds the mandatory rules; a rule that comes from an ADR names it.

## When to write one

Write an ADR only when a decision is hard to reverse, would surprise a reader without context, and was a real trade-off between alternatives. Skip it when any of the three is missing.

## Format and numbering

Follow [the ADR format](../../.agents/skills/engineering/domain-modeling/ADR-FORMAT.md). Name the file `NNNN-<slug>.md`, with the next free four-digit number.

## Changing a decision

Do not rewrite an accepted ADR. Record a changed decision in a new ADR that names the one it replaces. In the same change, set the old ADR's `status:` to `superseded by ADR NNNN`, or to `partly superseded by ADR NNNN` when the new ADR replaces only part of it, and update its status in [Records](#records). The status is metadata, so it may change in an accepted ADR. Fixing typos and broken links is allowed.

When a changed decision affects a constitution rule, change the rule through the `update-constitution` skill and update its ADR reference in the same change.

## Records

Each ADR with its status, as its frontmatter holds it:

- [ADR 0001: Charts uses lean hexagonal architecture](0001-hexagonal-architecture.md) (accepted). [nautilus-bridge ADR 0014](https://github.com/manuelstolze/nautilus-bridge/blob/main/docs/adr/0014-the-bridge-applies-the-shared-style-at-its-boundaries.md) describes how the Bridge applies the shared style.
- [ADR 0002: Named catalogs have independent Git histories](0002-named-catalogs.md) (accepted).
