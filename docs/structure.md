# Charts structure

Charts is the system catalog of Nautilus. It lists repositories, the systems they form, the external services they use, and how they depend on each other. Any coding agent can use it, for example Pi or Claude.

## Terms

[GLOSSARY.md](../GLOSSARY.md) defines System, Repository, External, Dependency, and the other terms used here.

## Layout

```
nautilus-charts/
├── systems/<id>.toml         # git-ignored, legacy root catalog
├── repositories/<id>.toml    # git-ignored, legacy root catalog
├── externals/<id>.toml       # git-ignored, legacy root catalog
├── tags.toml                 # legacy root tags
├── local/paths.toml          # git-ignored, legacy root paths
├── templates/                # entry templates
├── bin/charts.js             # the charts command: Node check, then scripts/charts.ts
├── scripts/charts.ts         # composition root
├── scripts/tag-version.mjs   # tags v<version>; run by .github/workflows/
├── src/
│   ├── domain/               # catalog rules, no I/O
│   ├── commands/             # one use case per command, and the ports
│   └── adapters/             # TOML store, Git, command line
├── tests/                    # TypeScript tests, with fakes in tests/fakes/
├── docs/adr/                 # architecture decisions
├── package.json              # version, command, and dependencies
├── package-lock.json
├── tsconfig.json
└── .agents/skills/charts/SKILL.md
```

One file per entry keeps lookups small. An agent reads only the entries it needs, and edits touch one file each. Named catalog repositories live in owner-selected folders outside this source tree. The registry is at `~/.config/nautilus-charts/catalogs.json`, or `$XDG_CONFIG_HOME/nautilus-charts/catalogs.json` when set.

## Code structure

Charts uses lean hexagonal architecture ([ADR 0001](adr/0001-hexagonal-architecture.md)). [Rule VI of the constitution](../CONSTITUTION.md#vi-the-core-does-no-io) sets the dependency rule, and `tests/architecture.test.ts` enforces it.

- **Core.** `src/domain/` holds catalog rules: entry types, IDs, statuses, fields, validation, and dependencies. `src/commands/` holds use cases for `find`, `show`, `deps`, `rdeps`, `check`, `add`, `set`, and `migrate`. Each use case returns data or a typed error from `src/domain/errors.ts`.
- **Ports.** `src/commands/ports.ts` defines the catalog store, the machine-local catalog registry, catalog Git operations, and a local-only Git inspector for code-repository paths.
- **Adapters.** `src/adapters/` implements the ports with TOML files and Git. Catalog Git operations use only registered Charts catalog roots. The local Git inspector reads code-repository data and never contacts its remotes. The CLI command table drives parsing, help, and `describe`.
- **Composition root.** `scripts/charts.ts` parses the arguments, builds the adapters, runs the use case, and prints its result. It reads the version from `package.json`.
- **Entry point.** `bin/charts.js` is the `charts` command. It is plain JavaScript, so any Node can run it: it checks the Node version before it loads `scripts/charts.ts`.

## IDs

- An ID is lowercase kebab-case, for example `shop-common-lib`.
- The file name is the ID. Files contain no `id` field.
- A repository ID usually equals its Git repository name.
- IDs are unique across systems, repositories, and externals in all registered catalogs, so a dependency ID always names exactly one entry.

## Entries

All files are TOML. Optional fields are omitted when unused.

### System

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | no | Display name when it differs from the ID, for example "Online Shop". |
| `description` | yes | Short purpose. |
| `owner` | no | The system owner: the responsible team or person, as free text. |
| `ticket-key` | no | Ticket key used by Repositories in this System. 2–10 characters: an uppercase letter, then uppercase letters or digits. |
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
| `ticket-key` | no | Ticket key used by this Repository. 2–10 characters: an uppercase letter, then uppercase letters or digits. It is not unique and may equal a Repository's `key`. |
| `system` | no | ID of the system it belongs to. Omitted for independent repositories. |
| `status` | no | See [Status](#status). Default `active`. |
| `owner` | no | The repository owner: the responsible team or person, as free text. |
| `tags` | no | Labels defined in the selected catalog's `tags.toml`. |
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

### Ticket keys

A ticket key identifies a project in an external ticket tracker. It uses 2–10 characters: an uppercase letter, then uppercase letters or digits. It is not unique. Several Systems and Repositories may share one, and it may equal a Repository's `key`.

For a Repository, Charts resolves its own `ticket-key` first. If it has none, Charts uses the `ticket-key` of the System it names, when that System exists and sets one. Otherwise, no ticket key resolves. Charts checks only the form. It does not check the tracker.

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

Each catalog's `tags.toml` holds its allowed repository tags and is tracked in that catalog's Git repository. The legacy root catalog keeps its root `tags.toml`. Charts counts only names written as keys in the selected catalog's file. A repository may use only defined tags.

When adding a Repository, use `--new-tag <name>=<description>` once for each new tag. The name and description must be non-empty. The name must be lowercase kebab-case, must not already be a key in the selected catalog's `tags.toml`, and must appear in the Repository's `tags` list. Charts rejects a tag that the entry does not use. Existing tag descriptions are not changed.

```toml
utility = "Shared tools, configuration, or helper code."
library = "Code consumed by other repositories."
service = "A deployable service."
```

### Local paths

Each catalog's `local/paths.toml` maps repository IDs to local code-repository folders on this machine. Paths starting with `~/` are relative to the user's home directory. Git ignores this file. It may be missing on a new machine. The named-catalog registry separately maps catalog names to local catalog folders and is also machine-local.

```toml
nautilus-bridge = "~/code/nautilus/nautilus-bridge"
shop-common-lib = "~/code/shop/shop-common-lib"
```

### Named catalogs

Each named catalog, such as `work` or `personal`, is an independent Git repository with one configured `origin` remote. `origin` is Git's local name for the remote address. Each machine maps catalog names to local folders in `~/.config/nautilus-charts/catalogs.json`, or in `$XDG_CONFIG_HOME/nautilus-charts/catalogs.json` when `XDG_CONFIG_HOME` is set. Catalog names, local folders, and code-repository paths are not synced. Entry IDs are unique across registered catalogs. A Repository's `depends-on` links can name entries in another registered catalog, but its `system` link must name a System in the same catalog.

Charts contacts only registered catalog repositories. It never contacts listed code repositories. A due read syncs all registered catalogs every 15 minutes by default. `CHARTS_READ_SYNC_INTERVAL_MS` sets the interval in milliseconds; `0` syncs on every read. A write commits its entry and any new tags, then syncs only the changed catalog. `charts catalog sync <name>` syncs one catalog on request. Sync uses fast-forward updates, which move local history forward without a merge. Charts never force-pushes. A remote failure warns and keeps local data.

`charts catalog create <name> --path <folder> --remote <url>` makes an empty local catalog. `charts catalog clone <name> --path <folder> --remote <url>` clones a catalog. Both register the selected folder and its one remote in this machine's registry. A `--catalog <name>` option selects a catalog for scoped commands. If no named catalogs are registered, commands without `--catalog` use the legacy root. When named catalogs are registered, `add`, `set`, `deps`, `rdeps`, `check`, and general text search need `--catalog`. Without it, `show <id>` and exact-ID `find <id>` search named catalogs only.

The legacy root catalog remains available until its owner chooses migration. `charts migrate <id> --catalog <name>` copies one root entry, its needed tag definitions, and this machine's local path mapping into the selected catalog. It checks and commits the copy locally, but does not sync or change the root. The owner reviews the copy, then starts sync with `charts catalog sync <name>`.

## The `charts` command

The `charts` command, `bin/charts.js`, is the entry point. It is plain JavaScript: it checks the running Node version against `engines` in `package.json` and fails with the error code `unsupported-runtime` below it, before it loads `scripts/charts.ts`, which runs the code in `src/`. Charts needs Node.js 26 or newer, which runs the TypeScript files directly by stripping their types. The `smol-toml` package reads TOML files. Run `npm ci` from the Charts root to install the locked packages, and link the command into `~/.local/bin` once ([README](../README.md#setup)). Then run `charts <command>` from any folder. Commands print compact text with one line per entry by default. `--json` prints JSON for other modules.

| Command | Purpose |
| --- | --- |
| `find [text] --catalog <name>` | Search one catalog. Filters: `--system`, `--tag`, `--status`, `--owner`. `--status` applies to all entry types. Without `--catalog`, `find <id>` looks up one exact ID across registered catalogs. |
| `show <id> [--catalog <name>]` | Show one entry and, for a Repository, its checked local path. Without `--catalog`, it looks up the ID across registered catalogs. |
| `deps <id> --catalog <name>` | Show dependencies for an entry in one catalog. A Repository may depend on an entry in another registered catalog. |
| `rdeps <id> --catalog <name>` | Show entries that depend on the target. |
| `check --catalog <name>` | Validate one catalog and its links to registered catalogs. |
| `add <system|repository|external> <id> --catalog <name> --data '<JSON>' [--local-path <path>] [--new-tag <name>=<description>]... [--json]` | Create an entry, check it, commit the entry and new tags, and sync only the selected catalog. |
| `set <id> --catalog <name> [--data '<JSON>'] [--local-path <path>] [--new-tag <name>=<description>]... [--replace-key] [--json]` | Update an entry, check it, commit the entry and new tags, and sync only the selected catalog. |
| `migrate <id> --catalog <name>` | Copy one legacy root entry, its needed tags, and local path into a named catalog. It commits locally but does not sync. |
| `catalog create <name> --path <folder> --remote <url>` | Make and register an empty catalog with one remote. |
| `catalog clone <name> --path <folder> --remote <url>` | Clone and register a catalog. |
| `catalog sync <name>` | Sync one catalog on request. Use it after reviewing a migration copy. |
| `describe` | Describe the module, its error codes, and its commands. With `--json`, it prints them in the format of `logbook describe --json`. |
| `--version` | Print `charts <version>`; with `--json`, print `{"module": "charts", "version": "<version>"}`. |

Without a command, or with `--help`, `charts` prints the help text.

For Repository `show --json`, Charts adds `resolved_ticket_key` and `ticket_key_source`. Both are `null` when no ticket key resolves. Text `show` lists the recorded `ticket-key` when set and lists both resolved fields when a value resolves. Systems and Externals have no resolved fields. An exact-ID `find` without `--catalog` searches registered catalogs. For a Repository, it also returns its checked local path and path status.

`check` reports:

- Files that are not valid TOML or have unknown or missing fields.
- IDs that are not kebab-case or that repeat across entry types or registered catalogs.
- Repository keys with an invalid form or used by more than one repository.
- `ticket-key` values that do not match the stated form, with the entry label and rule.
- `system` and `depends-on` IDs that name no entry, and repositories that depend on themselves.
- Tags missing from the selected catalog's `tags.toml` and invalid status values.
- Local paths that are missing or not Git repositories, and local paths whose local Git remotes do not match `remote`.
- `local/paths.toml` not ignored by Git.
- `depends-on` links that do not resolve in a registered catalog, and `system` links that cross catalog boundaries.
- New dependencies on `deprecated` or `archived` entries, as warnings.

`check` with errors exits with code 3. Its report stays its output: text lines or `{"ok": false, "errors", "warnings"}`, not an error object.

The local Git inspector checks code-repository paths and remotes from local Git data only. Catalog sync uses the configured `origin` of registered Charts catalog repositories. It never contacts or changes code repositories listed in a catalog. Remote failures produce warnings and keep local catalog data.

### Errors and exit codes

Every failure has an error code. Callers branch on the code, never on the message (nautilus-bridge ADR 0017). With `--json`, a failed command prints one object on standard output and nothing else, in the shared format of the Logbook ([nautilus-logbook docs/structure.md](https://github.com/manuelstolze/nautilus-logbook/blob/main/docs/structure.md#errors-and-exit-codes)):

```json
{"error": {"code": "entry-not-found", "message": "unknown entry ID: shop-api", "details": {"id": "shop-api"}}}
```

Without `--json`, it prints `ERROR: <message>` on standard error. For `add` and `set`, the text output lists the validation errors and warnings first. Each code belongs to a category, and the category sets the exit code. A case that callers decide on has its own code; every other failure has its category's code. An unexpected error is `external`.

| Code | Category | Exit | When | `details` |
| --- | --- | --- | --- | --- |
| `usage` | usage | 1 | An unknown command, a missing or invalid argument or option, `--data` that does not fit the entry, or `deps` on an external entry. | `id` for `deps` on an external entry |
| `not-found` | not found | 2 | Something other than an entry does not exist. | — |
| `entry-not-found` | not found | 2 | No entry has the ID, for `show`, `deps`, `rdeps`, `set`, or `migrate`. The message is `unknown entry ID: <id>`. | `id` |
| `refused` | refused | 3 | A rule of Charts refuses the command, for example catalog files have uncommitted changes. | `errors`, `warnings` |
| `invalid-entry` | refused | 3 | `add`, `set`, or `migrate` fails validation; the attempted write is rolled back. | `errors`, `warnings` |
| `external` | external | 4 | Git or a file failed, for example a catalog commit or rollback. | `errors`, `warnings` for writes |
| `unsupported-runtime` | external | 4 | The running Node is below `engines` in `package.json`. | `required`, `running` |

### The `describe` format

`charts describe --json` prints the contract in one object, read from the same command table as the argument parser and the help text. It has the format of `logbook describe --json`: `module` and `version`; `errors`, every error code with its `category`, `exit_code`, and `meaning`; and `commands`, every command with its `name`, `usage`, `summary`, `arguments` and `options` as JSON Schema, `output` fields, and `errors`. `--json`, `--help`, and `--version` are global and appear in no command's options.

### Versions

The version in `package.json` is the version of this contract. [CONTRIBUTING.md](../CONTRIBUTING.md#versions) states when it changes and the tag step after the merge.

## Adding entries

Pass the entry type and explicit ID as positional values. Pass a JSON object with `--data`. JSON is a text format for structured data. The object contains the fields listed above, but not `id`. `description` is required. Unknown fields and values that fail the catalog rules are rejected. Charts does not generate IDs or repository keys.

For example, add an entry to the selected catalog:

```bash
charts add repository shop-api --catalog work \
  --data '{"description":"The shop API.","system":"shop"}'
```

Charts reads the selected catalog's matching template to set field order. It writes only supplied values. A Repository can omit `--local-path`; when supplied, Charts stores the path in that catalog's ignored `local/paths.toml`. Charts checks the local Git root and remote setting without contacting the code-repository remote. It appends new path mappings without changing prior text. It replaces a stale single-line mapping for the same ID with a warning. It refuses to write when it cannot update the map safely. A Repository's local path is stored as an absolute path in the selected catalog so migration preserves the same folder.

For a missing Repository tag, propose a lowercase kebab-case name and a description. Ask the catalog owner to confirm both before passing `--new-tag`. The Repository must use every new tag. Charts appends the new definitions to the selected catalog's `tags.toml` and keeps prior text unchanged.

After writing, Charts validates the selected catalog and its links to registered catalogs. If a write or validation fails, it restores the entry, `local/paths.toml`, and `tags.toml`. It refuses to write when the entry or tag files have uncommitted changes. A successful named-catalog write commits the entry and tags in that catalog, then syncs only that catalog. A failed remote sync warns and keeps the local commit. The path map stays ignored. The Charts skill asks the catalog owner to confirm a proposed code-repository remote before it records the remote.

Use `--json` for machine-readable results. Success reports the type, ID, and validation result. It does not report a Charts store path. When new tags are added, it also reports `new_tags` in option order. Catalog findings name an entry or catalog part, for example `repository shop: tag "unknown" is not defined in the tag list` or `the local paths are missing; local path checks were skipped`. Failure prints an error object, `invalid-entry` with the validation errors and warnings in `details` when validation fails ([Errors and exit codes](#errors-and-exit-codes)).

## Updating and removing entries

Use `charts set <id> --catalog <name>` to add or replace fields on an existing entry in a named catalog. There is no type argument because IDs are unique across entry types and catalogs.

Pass a partial JSON object with `--data`. Do not include `id` or JSON `null`. A named field is added when missing or replaces its full old value, including lists. Fields that are not named stay unchanged. Charts validates the entry and catalog links. If validation fails after writing, Charts restores the entry, `local/paths.toml`, and `tags.toml`. It commits the changed entry and tags in the selected catalog, then syncs only that catalog.

Charts changes only the lines of the named fields. It keeps comments, blank lines, and all other field text. It refuses to write when a named field appears more than once, uses a dotted key, or the file has a table section. If the requested values are already set and the local path is unchanged, the command succeeds without writing.

Use `--local-path` only for a Repository. Charts applies the same safe mapping rules as `add` and checks the updated path against the entry's remote. Use `--new-tag <name>=<description>` only for a Repository. The tag must be new, and its name must appear in the `tags` value passed through `--data`. Charts commits new tags in the selected catalog.

A repository key may be added when missing. Do not change a key that another module uses. Changing an existing key requires `--replace-key`; first check that the key is not in use, then ask the catalog owner before using the option. Charts does not check other modules for key use.

Use hand edits only to rename an ID or remove an entry. When renaming an ID, rename the file and update every reference, including `system`, `depends-on`, and the matching key in `local/paths.toml`. When removing an entry, check its dependents first and change only the approved entry and references. Removing an entry never deletes the repository or its files.

## Catalog data

The legacy root entries remain Git-ignored until the owner migrates them. Named catalog entries, templates, and tags are tracked in that catalog's Git repository. The machine-local registry and each catalog's `local/paths.toml` stay outside remote sync. Charts contacts only a catalog's configured `origin`; it never contacts code-repository remotes.

## Out of scope

- Cloning, fetching, or changing listed code repositories.
- Importing directly from a Git hosting service.
- A graphical user interface.
- Sub-systems.
- Dependency kinds other than `depends-on`.

## Open points

None.
