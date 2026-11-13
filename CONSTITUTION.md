<!--
Sync Impact Report

1.2.1 (2026-11-13)
- Version: 1.2.0 → 1.2.1
- Changed rules: rule VI reworded. Terminal output is rendered by the CLI
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
  owner's review of this pilot.

1.1.0 (2026-11-12)
- Version: 1.0.0 → 1.1.0
- Changed rules: new rule V. Other modules reach Charts's data only through its
  commands, with no store paths in its output (nautilus-bridge ADR 0006).
- Affected guidance: none.
- Open follow-up: check the JSON output for paths into the store and remove them.

1.0.0 (2026-11-12)
- Version: unversioned → 1.0.0
- Changed rules: added rules I to IV. They move existing rules here from README.md and
  CONTRIBUTING.md without changing their meaning.
- Affected guidance: README.md, CONTRIBUTING.md.
- Open follow-up: none.
-->

# nautilus-charts Constitution

Version 1.2.1

These are the mandatory rules for Charts. They bind every change to this repository and every agent that runs its skills. Other guidance in this repository links to these rules instead of repeating them. Conventions, such as branch names, commit messages, and checks, are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Rules

### I. The catalog stays private

Catalog entries in `systems/`, `repositories/`, and `externals/`, and `local/paths.toml`, are each user's own. Git ignores them because they can name private systems, internal hosts, and remotes. Never commit them, and never force-add them with `git add -f`. Remote links never contain credentials.

Examples in documentation, templates, and tests use neutral names such as `shop` or `example.com`, never a real company, internal host, or private repository.

### II. Charts knows no other module

Charts keeps only its own data. It calls no other module, reads no other module's files, and does not check IDs that other modules use. The Bridge resolves those IDs against Charts (nautilus-bridge ADR 0002).

### III. Charts works locally and never touches repositories

The `charts` script uses local Git data only. It never contacts remote servers, clones, or fetches. Removing an entry never deletes the repository or its files.

### IV. Charts stays within its responsibilities

Charts is responsible for:

- Registering, finding, updating, and removing systems, repositories, and externals.
- Recording dependencies between repositories and on external services.
- Deriving dependencies between systems. They are never recorded by hand.
- Resolving a repository's local path on this machine.
- Validating entries, references, tags, local paths, and remotes.

Charts is not responsible for:

- Knowledge about systems, such as how-tos or spike results. That belongs in `nautilus-library`.
- Specifications, plans, and task lists for changes. They belong in `nautilus-logbook`.
- Checking IDs that other modules use.
- Cloning or fetching repositories.

Work that belongs to another module goes to that module.

### V. Charts is reached only through its commands

Other modules reach Charts's data only through its commands, with text in and out: arguments, standard input, and `--json`. Its output carries content, never a path into its own store. Paths to the change owner's repositories are data, not store paths (nautilus-bridge ADR 0006).

### VI. The core does no I/O

Charts uses lean hexagonal architecture (ADR 0001). The core, in `src/domain/` and `src/commands/`, imports only other core files and does not use `console` or `process`. Files and Git are reached only through ports that the core defines, implemented by adapters in `src/adapters/`. The CLI adapter renders the data that use cases return; the core never writes output. Add a port only at a real boundary. `scripts/charts.ts` wires the adapters to the commands. A test enforces this rule.

## Governance

- This file is the only source of Charts's mandatory rules. Other documents and skills link to a rule instead of copying it.
- A rule that comes from an architecture decision names its ADR. The ADR keeps the reasons and the rejected options.
- Change these rules only through the `update-constitution` skill and with the repository owner's explicit approval. That skill sets the version and adds a Sync Impact Report at the top of this file.
