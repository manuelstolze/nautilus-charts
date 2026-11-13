---
name: charts
description: Find, show, register, update, and remove Nautilus Charts systems, repositories, and external services. Use when managing the Charts catalog or resolving a repository's local path.
---

# Charts

Charts stores system, repository, and external-service entries as TOML files. Use this skill when you need to search or change those entries.

## Locate the catalog

Use the Charts repository root given by the task or project context. If you do not know the root, ask the owner. Do not guess a path on the machine.

Run `npm ci` from the Charts root when dependencies are absent. It replaces `node_modules` with the versions in `package-lock.json`.

Run commands from the Charts root:

```sh
npm run --silent charts -- find
```

Use `--silent` so npm messages do not mix with JSON output. From another directory, call the local TypeScript runner with full paths:

```sh
<charts-root>/node_modules/.bin/tsx <charts-root>/scripts/charts.ts find
```

## Find and show entries

1. Search by ID, name, or description with `find [text]`.
2. Narrow results with `--system`, `--tag`, `--status`, or `--owner`. `--status` applies to all entry types. `--system` matches the system and its repositories, `--tag` matches repositories, and `--owner` matches systems and repositories with that owner.
3. Use `show <id>` to read one entry. For a repository, use its local path only when `local_path_status` is `ok`.
4. Use `deps <id>` to see direct dependencies. For a system, this also shows system dependencies derived from repository dependencies.
5. Use `rdeps <id>` to find entries that depend on the target.
6. Add `--json` when another tool must read the result.

If a result is ambiguous, ask the owner which entry they mean. A path in `local/paths.toml` is specific to this machine. Do not invent a path when it is missing.

## Add an entry

1. Search for the ID and name first. IDs must be unique across systems, repositories, and externals. Use an explicit lowercase kebab-case ID. Charts does not generate IDs or repository keys.
2. Use the field names in [the structure guide](../../../docs/structure.md). Pass a JSON object. JSON is a text format for structured data. Include a required `description`. Do not include an `id` field. Omit optional fields that do not apply.
3. For a repository, add `system` only when it belongs to that system. Use tags listed in `tags.toml`. Record only dependencies you can verify. A dependency can name a repository or an external. Charts derives system dependencies; do not add them by hand. Add a repository `key` only when needed. Search with `find <key>` and ask the owner to choose a unique key; Charts checks that it is unique.
4. Before you record a suggested remote, inspect local Git remote settings and ask the owner to confirm the remote. Never record credentials. Do not connect to a remote, clone, or fetch.
5. Run `charts add` from the Charts root. It uses the matching template, checks the full catalog, and removes its new entry if validation fails:

   ```sh
   npm run --silent charts -- add repository new-repository \
     --data '{"description":"Purpose of this repository."}'
   ```

   Add `--local-path <path>` only for a repository. Charts validates the path and its remote before it records the mapping in ignored `local/paths.toml`. If validation fails, it restores the prior path map. The command does not stage or commit catalog files.
6. Check the command result. Fix errors, then run `npm run --silent charts -- check`.

## Update an entry

1. Use `find` and `show` to identify the entry.
2. Change only the fields the owner requested. Keep other fields and dependency links unchanged.
3. If an ID changes, rename its file and update every reference, including `system`, `depends-on`, and the matching key in `local/paths.toml`.
4. Never change a repository `key` that is already used. To add a missing key, search with `find <key>` first, then choose a unique key with the owner. `find` also matches the key inside other text, so rely on `check` to confirm that the key is unique.
5. Ask the owner before recording a suggested remote. Never add credentials to a remote URL.
6. Run `npm run --silent charts -- check` and fix all errors.

## Remove an entry

1. Use `show` and `rdeps <id>` to identify the entry and its dependents. For a system, also run `find --system <id>` to list its repositories.
2. Tell the owner which catalog files and links would change. Ask how to handle any dependents or repositories in a system before removing the entry.
3. Remove only the approved TOML entry and its matching local path mapping, if any. Update links only as the owner directs.
4. Never delete a repository, worktree, or repository file when removing a catalog entry.
5. Run `npm run --silent charts -- check` and fix all errors.

## Check

Run `npm run --silent charts -- check` after every catalog change and before you report completion. The command checks entry data, references, tags, local paths, configured remotes, and the Git ignore rule for `local/paths.toml`. Errors cause a non-zero exit code. Warnings alone do not.
