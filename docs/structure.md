# Charts structure

Charts is the system catalog of Nautilus. It lists repositories, the systems they form, the external services they use, and how they depend on each other. Any coding agent can use it, for example Pi or Claude.

## Terms

[GLOSSARY.md](../GLOSSARY.md) defines System, Repository, External, Dependency, and the other terms used here.

## Layout

```
nautilus-charts/
├── systems/<id>.toml         # git-ignored, your catalog
├── repositories/<id>.toml    # git-ignored, your catalog
├── externals/<id>.toml       # git-ignored, your catalog
├── tags.toml
├── local/paths.toml          # git-ignored, one per machine
├── templates/                # entry templates
├── scripts/charts.ts         # entry point and composition root
├── src/
│   ├── domain/               # catalog rules, no I/O
│   ├── commands/             # one use case per command, and the ports
│   └── adapters/             # TOML store, Git, command line
├── tests/                    # TypeScript tests, with fakes in tests/fakes/
├── docs/adr/                 # architecture decisions
├── package.json              # commands and dependencies
├── package-lock.json
├── tsconfig.json
└── .agents/skills/charts/SKILL.md
```

One file per entry keeps lookups small. An agent reads only the entries it needs, and edits touch one file each.

## Code structure

Charts uses lean hexagonal architecture ([ADR 0001](adr/0001-hexagonal-architecture.md)). [Rule VI of the constitution](../CONSTITUTION.md#vi-the-core-does-no-io) sets the dependency rule, and `tests/architecture.test.ts` enforces it.

- **Core.** `src/domain/` holds the catalog rules: entry types, IDs and keys, statuses, fields, validation, and dependencies. `src/commands/` holds one use case per command (`find`, `show`, `deps` and `rdeps`, `check`, `add`, `set`). Each use case returns data and an exit status.
- **Ports.** `src/commands/ports.ts` defines the two boundaries: the catalog store (entry files, `tags.toml`, the templates, and `local/paths.toml`) and Git (repository roots, remotes, and ignore checks).
- **Adapters.** `src/adapters/` implements the ports with TOML files and local Git, and holds the command-line adapter that parses arguments and prints text or JSON. The tests use in-memory fakes from `tests/fakes/` instead.
- **Composition root.** `scripts/charts.ts` parses the arguments, builds the adapters, runs the use case, and prints its result.

## IDs

- An ID is lowercase kebab-case, for example `shop-common-lib`.
- The file name is the ID. Files contain no `id` field.
- A repository ID usually equals its Git repository name.
- IDs are unique across systems, repositories, and externals, so a dependency ID always names exactly one entry.

## Entries

All files are TOML. Optional fields are omitted when unused.

### System

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | no | Display name when it differs from the ID, for example "Online Shop". |
| `description` | yes | Short purpose. |
| `owner` | no | The system owner: the responsible team or person, as free text. |
| `status` | no | See [Status](#status). Default `active`. |

```toml
# systems/shop.toml
name = "Online Shop"
description = "Storefront, checkout, and the libraries they share."
```

### Repository

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | no | Display name when it differs from the ID. |
| `description` | yes | Short purpose. |
| `key` | no | Short uppercase code that starts the IDs of changes to this repository, for example `NBR`. 2–5 characters: an uppercase letter, then uppercase letters or digits. Unique across repositories. Do not change it once used. |
| `system` | no | ID of the system it belongs to. Omitted for independent repositories. |
| `status` | no | See [Status](#status). Default `active`. |
| `owner` | no | The repository owner: the responsible team or person, as free text. |
| `tags` | no | Labels from `tags.toml`. |
| `remote` | no | Remote Git link. Never contains credentials. |
| `default-branch` | no | Default `main`. |
| `depends-on` | no | List of dependencies. Each has an `id` of a repository or external and an optional free-text `via`, for example "REST", "events", or "npm". Only list entries the repository uses in order to work. Mentioning another entry's ID is not a dependency. |

```toml
# repositories/billing-api-service.toml
description = "Public API for billing."
system = "billing"
owner = "Team Billing"
tags = ["service"]
remote = "ssh://git@gitlab.example/billing/billing-api-service.git"
depends-on = [
  { id = "shop-common-lib", via = "npm" },
  { id = "amazon-s3", via = "SDK" },
]
```

From this entry, Charts derives that system `billing` depends on system `shop`.

### External

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | no | Display name, for example "Amazon S3". |
| `description` | yes | Short purpose. |
| `provider` | no | Groups related externals, for example `aws`. |
| `kind` | no | Free text, for example `cloud-service` or `saas`. |
| `status` | no | See [Status](#status). Default `active`. |

Externals name a specific service, not only a provider.

```toml
# externals/amazon-s3.toml
name = "Amazon S3"
description = "Object storage in AWS."
provider = "aws"
kind = "cloud-service"
```

### Status

| Value | Meaning |
| --- | --- |
| `planned` | Does not exist yet. |
| `active` | In use. This is the default. |
| `deprecated` | Still running but being phased out. Do not add new dependencies on it. |
| `archived` | No longer used. Kept so it stays findable. |

### Tags

`tags.toml` holds the allowed repository tags. It is shared and tracked by Git. Charts counts only names written as keys in this file. A repository may use only defined tags.

When adding a repository, use `--new-tag <name>=<description>` once for each new tag. The name and description must be non-empty. The name must be lowercase kebab-case, must not already be a key in `tags.toml`, and must appear in the repository's `tags` list. Charts rejects a tag that the entry does not use. Existing tag descriptions are not changed.

```toml
utility = "Shared tools, configuration, or helper code."
library = "Code consumed by other repositories."
service = "A deployable service."
```

### Local paths

`local/paths.toml` maps each repository ID to its local path: the one folder on this machine where Charts finds the repository. Paths starting with `~/` are relative to the user's home directory. Git ignores this file, and it may be missing on a new machine.

```toml
nautilus-bridge = "~/code/nautilus/nautilus-bridge"
shop-common-lib = "~/code/shop/shop-common-lib"
```

## The `charts` script

`charts.ts` uses Node.js 26 or newer and TypeScript. Node.js is the JavaScript runtime. The `smol-toml` package reads TOML files, and `tsx` runs the TypeScript script. Run `npm ci` from the Charts root to install the locked packages. Use `npm run --silent charts -- <command>` from the Charts root. The `--silent` option keeps npm messages out of JSON output. Commands print compact text with one line per entry by default. `--json` prints JSON for other modules.

| Command | Purpose |
| --- | --- |
| `find [text]` | Find entries by text. Filters: `--system`, `--tag`, `--status`, `--owner`. `--status` applies to all entry types. |
| `show <id>` | Show one entry and, for a repository, its checked local path. |
| `deps <id>` | Show what a repository or system depends on. For a system, also the derived system dependencies. |
| `rdeps <id>` | Show what depends on a repository, external, or system. |
| `check` | Validate all entries and the local paths. |
| `add <system|repository|external> <id> --data '<JSON>' [--local-path <path>] [--new-tag <name>=<description>]... [--json]` | Create one entry from its template and validate the catalog. `--local-path` is for repositories only. `--new-tag` is for repository entries only. |
| `set <id> [--data '<JSON>'] [--local-path <path>] [--new-tag <name>=<description>]... [--replace-key] [--json]` | Add or replace fields on an existing entry. `--local-path` is for repositories only. `--new-tag` is for repository entries only. |

`check` reports:

- Files that are not valid TOML or have unknown or missing fields.
- IDs that are not kebab-case or that repeat across entry types.
- Repository keys with an invalid form or used by more than one repository.
- `system` and `depends-on` IDs that name no entry, and repositories that depend on themselves.
- Tags missing from `tags.toml` and invalid status values.
- Local paths that are missing or not Git repositories, and local paths whose Git remotes do not match `remote`.
- `local/paths.toml` not ignored by Git.
- New dependencies on `deprecated` or `archived` entries, as warnings.

The script uses local Git data only. It never contacts remote servers, clones, or fetches.

## Adding entries

Pass the entry type and explicit ID as positional values. Pass a JSON object with `--data`. JSON is a text format for structured data. The object contains the fields listed above, but not `id`. `description` is required. Unknown fields and values that fail the catalog rules are rejected. Charts does not generate IDs or repository keys.

For example:

```bash
npm run --silent charts -- add repository shop-api \
  --data '{"description":"The shop API.","system":"shop"}'
```

Charts reads the matching file in `templates/` to set the field order. It writes only supplied values, so optional template examples do not appear in the new entry. A repository can omit `--local-path`; when supplied, the path is added to ignored `local/paths.toml`. Charts checks that it is a Git repository root and that its local remote matches the entry's `remote`, if set. It uses local Git data only and does not connect to remote servers. When adding a local path, Charts appends new mappings without changing the rest of `local/paths.toml`, replaces one stale mapping written on a single line for the same ID with a warning, and fails without writing when it cannot replace that mapping safely. Charts refuses to append a path when `local/paths.toml` contains a TOML table section, because a new line at the end would belong to that section.

For a missing repository tag, propose a lowercase kebab-case name and a description. Ask the catalog owner to confirm both before passing `--new-tag`. The entry must use each new tag. Charts appends new tags to `tags.toml` and keeps all prior text unchanged.

After writing, Charts validates the full catalog. If a write or validation fails, it removes the new entry and restores `local/paths.toml` and `tags.toml` to their prior contents. It does not overwrite a file that changed after Charts wrote it; it reports a rollback error instead. `tags.toml` is shared and tracked by Git. A successful add leaves it uncommitted. Charts never stages or commits it; the catalog owner decides whether to commit it. Entry and path files stay ignored by Git. The Charts skill asks the catalog owner to confirm a proposed remote before adding it.

Use `--json` for machine-readable results. Success reports the type, ID, path, and validation result. When new tags are added, it also reports `new_tags` in option order. Text output names the tags and says that the shared tag list has uncommitted changes. Failure reports the errors and returns a non-zero status.

## Updating and removing entries

Use `charts set <id>` to add or replace fields on an existing system, repository, or external entry. There is no type argument because IDs are unique across all entry types.

Pass a partial JSON object with `--data`. Do not include `id` or JSON `null`. A named field is added when missing or replaces its full old value, including lists. Fields that are not named stay unchanged. Charts validates the merged entry and the full catalog. If validation fails after writing, it restores the entry, `local/paths.toml`, and `tags.toml`, unless one of those files changed after the write.

Charts changes only the lines of the named fields. It keeps comments, blank lines, and all other field text. It refuses to write when a named field appears more than once, uses a dotted key, or the file has a table section. If the requested values are already set and the local path is unchanged, the command succeeds without writing.

Use `--local-path` only for a repository. Charts applies the same safe mapping rules as `add` and checks the updated path against the entry's remote. Use `--new-tag <name>=<description>` only for a repository. The tag must be new, and its name must appear in the `tags` value passed through `--data`. Charts appends new tags to `tags.toml`; a successful change remains uncommitted.

A repository key may be added when missing. Do not change a key that another module uses. Changing an existing key requires `--replace-key`; first check that the key is not in use, then ask the catalog owner before using the option. Charts does not check other modules for key use.

Use hand edits only to rename an ID or remove an entry. When renaming an ID, rename the file and update every reference, including `system`, `depends-on`, and the matching key in `local/paths.toml`. When removing an entry, check its dependents first and change only the approved entry and references. Removing an entry never deletes the repository or its files.

## Catalog data

Git ignores the entries in `systems/`, `repositories/`, and `externals/`. Each catalog owner keeps their own catalog on their machine, so it can name private systems and remotes without publishing them. Only `templates/` and the tracked `tags.toml` are shared. Charts never stages or commits `tags.toml`; the catalog owner decides whether to commit changes.

## Not in version 1

- Cloning or fetching repositories.
- Importing from GitLab or GitHub.
- A user interface.
- Sub-systems.
- Dependency kinds other than `depends-on`.

## Open points

None.
