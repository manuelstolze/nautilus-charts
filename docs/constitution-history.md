# Constitution history

This file holds the earlier Sync Impact Reports of [CONSTITUTION.md](../CONSTITUTION.md), newest first. The constitution keeps only its newest report. The `update-constitution` skill moves the previous report here when it adds a new one.

Each open follow-up ends with `(open)`, or with `(closed: <change or document>)` naming what closed it. A report with no follow-up has no marker. A later change that resolves an open follow-up marks it closed.

```text
1.2.1 (2026-11-13)
- Version: 1.2.0 → 1.2.1
- Changed rules: rule VI reworded; terminal output is rendered by the CLI
  adapter, not reached through a core port. The meaning is unchanged.
- Affected guidance: none. The "Code structure" section of docs/structure.md
  already matches.
- Open follow-up: none.

1.2.0 (2026-11-13)
- Version: 1.1.0 → 1.2.0
- Changed rules: new rule VI. The core does no I/O; Charts uses lean hexagonal
  architecture (ADR 0001), enforced by an import test.
- Affected guidance: docs/structure.md, CONTRIBUTING.md.
- Open follow-up: the Library, Logbook, and Bridge adopt the same rule after the
  owner's review of this pilot. (closed: nautilus-library ADR 0001, nautilus-logbook
  ADR 0001, nautilus-bridge ADR 0014)

1.1.0 (2026-11-12)
- Version: 1.0.0 → 1.1.0
- Changed rules: new rule V. Other modules reach Charts's data only through its
  commands, with no store paths in its output (nautilus-bridge ADR 0006).
- Affected guidance: none.
- Open follow-up: check the JSON output for paths into the store and remove them. (open)

1.0.0 (2026-11-12)
- Version: unversioned → 1.0.0
- Changed rules: added rules I to IV. They move existing rules here from README.md and
  CONTRIBUTING.md without changing their meaning.
- Affected guidance: README.md, CONTRIBUTING.md.
- Open follow-up: none.
```
