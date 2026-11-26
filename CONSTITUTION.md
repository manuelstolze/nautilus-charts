<!--
Sync Impact Report

2.0.0 (2026-11-26)
- Version: 1.2.1 → 2.0.0
- Changed rules: I allows named catalog data in separate Git repositories and
  sync to owner-configured remotes; III allows remote Git only for named
  catalogs, not listed code repositories; IV adds catalog management and sync.
- Affected guidance: README.md, CONTRIBUTING.md, docs/structure.md,
  GLOSSARY.md, .agents/skills/charts/SKILL.md, docs/adr/README.md, and
  docs/adr/0002-named-catalogs.md.
- Open follow-up: implement named catalogs and remote sync in Charts. (open)
-->

# nautilus-charts Constitution

Version 2.0.0

These are the mandatory rules for Charts. They bind every change to this repository and every agent that runs its skills. Other guidance in this repository links to these rules instead of repeating them. Conventions, such as branch names, commit messages, and checks, are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Rules

### I. Catalog data stays owner-controlled

Entries in `systems/`, `repositories/`, and `externals/` in the Charts source repository remain each user's own. Git ignores them because they can name private systems, internal hosts, and remotes. Named catalogs store their entries in separate Git repositories. Charts may sync a named catalog only to remotes configured by its owner. The mapping from catalog names to local folders, and paths to code repositories, stay on each machine and are not synced. Remote links never contain credentials.

Examples in documentation, templates, and tests use neutral names such as `shop` or `example.com`, never a real company, internal host, or private repository.

### II. Charts knows no other module

Charts keeps only its own data. It calls no other module, reads no other module's files, and does not check IDs that other modules use. The Bridge resolves those IDs against Charts (nautilus-bridge ADR 0002).

### III. Charts syncs only its own catalogs

Charts may contact remote servers only to clone or sync named catalog repositories with remotes configured by their owner. It never contacts, clones, fetches, or pushes code repositories listed in a catalog. Removing an entry never deletes the listed repository or its files.

### IV. Charts stays within its responsibilities

Charts is responsible for:

- Registering, selecting, and syncing named catalogs to their configured remotes.
- Registering, finding, updating, and removing systems, repositories, and externals.
- Recording dependencies between repositories and on external services.
- Deriving dependencies between systems. They are never recorded by hand.
- Resolving a repository's local path on this machine.
- Validating entries, references, tags, local paths, and remotes.

Charts is not responsible for:

- Knowledge about systems, such as how-tos or spike results. That belongs in `nautilus-library`.
- Specifications, plans, and task lists for changes. They belong in `nautilus-logbook`.
- Checking IDs that other modules use.
- Cloning, fetching, or pushing code repositories listed in a catalog.

Work that belongs to another module goes to that module.

### V. Charts is reached only through its commands

Other modules reach Charts's data only through its commands, with text in and out: arguments, standard input, and `--json`. Its output carries content, never a path into its own store. Paths to the change owner's repositories are data, not store paths (nautilus-bridge ADR 0006).

### VI. The core does no I/O

Charts uses lean hexagonal architecture (ADR 0001). The core, in `src/domain/` and `src/commands/`, imports only other core files and does not use `console` or `process`. Files and Git are reached only through ports that the core defines, implemented by adapters in `src/adapters/`. The CLI adapter renders the data that use cases return; the core never writes output. Add a port only at a real boundary. `scripts/charts.ts` wires the adapters to the commands. A test enforces this rule.

## Governance

- This file is the only source of Charts's mandatory rules. Other documents and skills link to a rule instead of copying it.
- A rule that comes from an architecture decision names its ADR. The ADR keeps the reasons and the rejected options.
- Change these rules only through the `update-constitution` skill and with the repository owner's explicit approval. That skill sets the version and adds a Sync Impact Report at the top of this file.
