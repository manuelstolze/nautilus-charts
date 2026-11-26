---
name: charts
description: Use when finding, adding, updating, migrating, or removing Charts entries, managing named catalogs, syncing catalogs, or resolving a local code-repository path.
---

# Charts

Charts stores Systems, Repositories, and Externals as TOML files. Use this skill when you need to search or change those entries, choose a catalog, or resolve a local path.

## Locate Charts

Run `charts --version` or `charts describe --json` from any folder. If `charts` is not found, stop and ask the catalog owner to link the command as the [README](../../../README.md#setup) shows. `charts describe --json` lists each command, option, output field, and error code. With `--json`, a failure prints `{"error": {"code", "message", "details"}}`; act on the code, not the message.

Use a catalog name supplied by the catalog owner. For this setup, store named catalog repositories under `./folio/` from the Charts root, such as `./folio/work/` and `./folio/private/`. Each child directory is a separate catalog Git repository. The `folio/` parent is not a catalog, and the Charts source repository ignores it. If no named catalogs are registered, the legacy root catalog is the default. When named catalogs are registered, scoped reads and writes need `--catalog <name>`. The catalog registry is machine-local. It lives at `${XDG_CONFIG_HOME}/nautilus-charts/catalogs.json`, or at `~/.config/nautilus-charts/catalogs.json` when `XDG_CONFIG_HOME` is not set. Do not guess a catalog name or local folder.

## Create or clone a catalog

A named catalog is an independent Git repository. It has one configured `origin` remote; `origin` is Git's local name for the remote address. Each machine can use its own local folder for that catalog.

Create an empty catalog:

```sh
charts catalog create work --path ./folio/work --remote https://example.com/charts-work.git
```

Clone an existing catalog:

```sh
charts catalog clone private --path ./folio/private --remote https://example.com/charts-private.git
```

Use only a remote that the catalog owner confirms is a Charts catalog. Never clone or sync a code repository listed in Charts. Do not put credentials in a remote URL.

## Find and show entries

1. Search a named catalog with `charts find <text> --catalog <name>`.
2. Add `--system`, `--tag`, `--status`, or `--owner` to narrow the results.
3. Use `charts show <id> --catalog <name>` to read one entry in that catalog.
4. Use `charts deps <id> --catalog <name>` and `charts rdeps <id> --catalog <name>` to inspect links.
5. Use `charts check --catalog <name>` to validate the catalog and its links to other registered catalogs.

A Repository may depend on an entry in another registered catalog. Its `system` field must name a System in the same catalog. Entry IDs are unique across all registered catalogs.

The Bridge may look up a unique ID without a catalog name:

```sh
charts show <id>
charts find <id>
```

These exact-ID lookups search all registered catalogs. For a Repository, they return its checked local code-repository path when that path is valid. For other searches, pass `--catalog`.

Use a local code-repository path only when `local_path_status` is `ok`. A path in `local/paths.toml` belongs to this machine. Do not invent a path when it is missing.

## Add an entry

1. Search all catalogs for the ID first. IDs must be unique across Systems, Repositories, Externals, and catalogs. Use an explicit lowercase kebab-case ID.
2. Use the field names in [the structure guide](../../../docs/structure.md). Pass a JSON object. JSON is a text format for structured data. Include a required `description`. Do not include an `id` field.
3. Add `--catalog <name>` to select the destination catalog. A Repository belongs to one catalog only. Its `system` must name a System in that catalog. Its `depends-on` links can name entries in other registered catalogs.
4. Use tags defined in that catalog's `tags.toml`. If a tag is missing, propose a lowercase kebab-case name and description. Ask the catalog owner to confirm both before passing `--new-tag '<name>=<description>'`.
5. For a Repository, pass `--local-path <path>` only when the owner gives or approves the path. Charts checks the local Git root and any recorded code-repository remote from local Git data. It does not contact the code-repository remote.
6. Run `charts add <type> <id> --catalog <name> --data '<JSON>'`. Charts checks the destination, commits the entry and new tags in that catalog, then syncs only that catalog. If the remote is unavailable, the local commit stays and Charts reports a warning.

Charts does not stage or commit the legacy root catalog's `tags.toml`. That old catalog keeps its existing behavior.

## Update an entry

1. Use `find` and `show` to identify the entry and confirm its type.
2. Pass only the fields the owner requested as a partial JSON object to `charts set <id> --catalog <name>`. Do not include `id` or JSON `null`. Keep all other fields and dependency links unchanged.
3. Use `--local-path` only when the owner requests a path change. Ask the owner before recording a code-repository remote.
4. Ask before using `--replace-key`. Do not change a Repository key that another module uses.
5. Check the command result. Charts validates the catalog, commits the selected entry and any new tags, and syncs only the selected catalog. A failed remote sync warns and keeps local data.

## Migrate a root entry

The legacy root catalog stays available until its owner confirms migration. Migrate one entry at a time:

```sh
charts migrate <id> --catalog <destination>
```

Charts copies the entry, its needed tag definitions, and this machine's local path mapping. It checks and commits the destination locally. It does not change the root or sync the copy. Review the destination entry and validation result. Only after approval, run:

```sh
charts catalog sync <destination>
```

Migration does not delete root entries. Do not clean up the root without a separate owner decision.

## Sync rules

A due read syncs all registered named catalogs every 15 minutes by default. Set `CHARTS_READ_SYNC_INTERVAL_MS` to another number of milliseconds. Set it to `0` to sync on every read. A write syncs only the catalog it changes.

Charts uses fast-forward sync. This means it updates local history only when it can move forward without a merge. Charts never force-pushes. A failed sync produces a warning and keeps local data. Remote Git operations run only against a registered Charts catalog's configured `origin`. Checks of code-repository paths use local Git data only.

## Remove an entry

1. Use `show` and `rdeps <id> --catalog <name>` to identify the entry and its dependents. For a System, also run `find --catalog <name> --system <id>`.
2. Tell the catalog owner which catalog files and links would change. Ask how to handle dependents or Repositories in a System before removing an entry.
3. Remove only the approved TOML entry and its matching local path mapping, if any. Update links only as the owner directs.
4. Never delete a code repository, worktree, or repository file when removing an entry.
5. Run `charts check --catalog <name>` and fix all errors.

Success from `add` and `set` names the entry by type and ID and reports validation. It does not expose a Charts catalog path. Findings name entries or catalog parts, for example:

- `repository shop: tag "unknown" is not defined in the tag list`
- `the local paths are missing; local path checks were skipped`
