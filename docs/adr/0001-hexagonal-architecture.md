---
status: accepted
---

# Charts uses lean hexagonal architecture

Every Nautilus module uses lean hexagonal architecture: the core does no I/O, ports exist only at real boundaries, code is organised per command, and each script has one composition root. The modules share this one rule; only the number of ports differs. Each module records the decision in its own ADR, and this is Charts's. Charts is the pilot: after it, the owner reviews the result before the Library, Logbook, and Bridge follow.

The reasons are that implementation agents write most of the code, so the boundary must be one that a test can check; that the rules that cross modules need one shape in every module; and that the Bridge needs workflows that can be tested even when they interleave I/O, such as asking Charts for a path, creating a worktree, and starting an agent.

In Charts, the core is `src/domain/` (the catalog rules) and `src/commands/` (one use case per command and the port interfaces). The core defines exactly two ports: a store port for entry files, `tags.toml`, the templates, and `local/paths.toml`, which keeps `add` atomic with its rollback; and a Git port for repository roots, remotes, and ignore checks. Adapters in `src/adapters/` implement them and handle the terminal. `scripts/charts.ts` is the composition root.

## Considered options

- **Functional core and imperative shell.** Rejected: it fits Charts well, but the Bridge's decisions depend on intermediate I/O results, so its shell would grow into a thick, untested script.
- **Classic layers.** Rejected: use cases import the real store and Git directly, so they stay tied to I/O and still need temporary folders to test.
- **Full hexagonal**, with interfaces inside the core as well. Rejected as ceremony: ports only at real boundaries give the same testability.
- **Vertical slices only.** Rejected: slices decide where files go but set no I/O boundary, so rules and I/O can mix again. The use cases are still organised per command.
- **A pattern chosen per module.** Rejected: without one shared rule there is no shared check, and agents would have to learn each module's shape.

## Consequences

- [Constitution rule VI](../../CONSTITUTION.md#vi-the-core-does-no-io) states the rule, and `tests/architecture.test.ts` enforces it with an allowlist: core files import only other core files and do not use `console` or `process`.
- Use cases are tested against an in-memory store and a fake Git adapter. Nothing yet checks that the fakes behave like the real adapters; whether they need shared contract tests is an open question.
- Storage can change behind the store port without touching the rules.
