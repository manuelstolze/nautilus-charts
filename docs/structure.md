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
├── scripts/charts.ts         # find, show, deps, rdeps, check
├── tests/                    # TypeScript tests
├── package.json              # commands and dependencies
├── package-lock.json
├── tsconfig.json
└── .agents/skills/charts/SKILL.md
```

One file per entry keeps lookups small. An agent reads only the entries it needs, and edits touch one file each.

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
| `owner` | no | Responsible team or person, as free text. |
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
| `owner` | no | Responsible team or person, as free text. |
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

`tags.toml` holds the allowed tags. A repository may use only these.

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

`charts.ts` uses Node.js 20 or newer and TypeScript. Node.js is the JavaScript runtime. The `smol-toml` package reads TOML files, and `tsx` runs the TypeScript script. Run `npm ci` from the Charts root to install the locked packages. Use `npm run --silent charts -- <command>` from the Charts root. The `--silent` option keeps npm messages out of JSON output. Commands print compact text with one line per entry by default. `--json` prints JSON for other modules.

| Command | Purpose |
| --- | --- |
| `find [text]` | Find entries by text. Filters: `--system`, `--tag`, `--status`, `--owner`. |
| `show <id>` | Show one entry and, for a repository, its checked local path. |
| `deps <id>` | Show what a repository or system depends on. For a system, also the derived system dependencies. |
| `rdeps <id>` | Show what depends on a repository, external, or system. |
| `check` | Validate all entries and the local paths. |

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

## Changing entries

Agents edit the TOML files directly, using `templates/`, and run `npm run --silent charts -- check` afterwards. Run tests with `npm test` and type checks with `npm run typecheck`. The skill in `.agents/skills/charts/` describes how to find, register, update, and remove entries. Removing an entry never deletes the repository or its files.

## Catalog data

Git ignores the entries in `systems/`, `repositories/`, and `externals/`. Each user keeps their own catalog on their machine, so it can name private systems and remotes without publishing them. Only `templates/` and `tags.toml` are shared.

## Not in version 1

- Cloning or fetching repositories.
- Importing from GitLab or GitHub.
- A user interface.
- Sub-systems.
- Dependency kinds other than `depends-on`.
- Script commands that write entries.

## Open points

- How agents in other modules find Charts and load its skill.
- Whether `owner` becomes a reference to owner entries when a team uses Charts.
