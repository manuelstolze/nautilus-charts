# Getting started

This guide takes a new [Catalog owner](../GLOSSARY.md#people) from a fresh install to a checked [Named catalog](../GLOSSARY.md#catalog-entries) with a first entry. It covers the first machine and every further machine that uses the same catalog.

The examples use the catalog name `work`, the System `shop`, the Repository `shop-storefront`, and the remote `https://example.com/charts-work.git`. Replace them with your own names.

## Before you start

You need:

- **Node 26 or later.** `package.json` requires it in `engines`. With an older Node, `charts` stops with the error code `unsupported-runtime`.
- **Git** on `PATH`.
- **An empty Git remote for the catalog**, for example a new repository on your Git host with no README and no first commit. Charts pushes the catalog's first commit there with your first write. Do not put credentials in the remote URL; use your usual Git credential setup.
- **A local clone of a code repository** to record, for example `~/code/shop/shop-storefront`. Charts reads its Git data locally and never contacts its remote.

Charts keeps two things on each machine and never syncs them:

- **The catalog registry** maps catalog names to local folders and remotes. It lives at `${XDG_CONFIG_HOME:-~/.config}/nautilus-charts/catalogs.json`.
- **The local path map** of each catalog maps Repository IDs to folders on this machine. It lives at `local/paths.toml` inside the catalog folder, and the catalog's own `.gitignore` keeps it out of Git.

Each machine therefore registers its catalogs and records its own local paths. Only the catalog entries and `tags.toml` travel through the remote.

## Set up Charts

Install Charts and link the `charts` command as the [README Setup](../README.md#setup) shows. Then check it:

```bash
charts --version
```

Run the commands below from the Charts root, the folder where you cloned `nautilus-charts`.

## First machine

Charts recommends keeping catalog repositories in the [Folio](../GLOSSARY.md#machine): the `./folio/` folder in the Charts root, with one child folder per catalog, such as `./folio/work/`. The Charts source repository ignores `./folio/`. Any other folder works too; pass it as `--path`.

1. Create the catalog. Charts makes an empty catalog repository in `./folio/work`, sets its `origin` remote, and registers it on this machine:

   ```bash
   charts catalog create work --path ./folio/work --remote https://example.com/charts-work.git
   ```

   Charts prints `Created catalog work`.

2. Confirm the registration and check the empty catalog:

   ```bash
   charts catalog list
   charts check --catalog work
   ```

   `catalog list` prints the name, local path, and remote. `check` prints `check: ok`. Until you record a local path, it also warns `the local paths are missing; local path checks were skipped`.

3. Add a first System:

   ```bash
   charts add system shop --catalog work --data '{"description":"Online shop system."}'
   ```

   Charts prints `Created system shop; validation ok`, commits the entry in the catalog, and pushes it to the remote. This first push fills the empty remote. The local-path warning from step 2 can appear again; it goes away once step 4 records a path.

4. Add a first Repository in that System and record where it is on this machine:

   ```bash
   charts add repository shop-storefront --catalog work \
     --data '{"description":"Storefront web app.","system":"shop"}' \
     --local-path ~/code/shop/shop-storefront
   ```

   The local path must be the root of a Git repository. Charts writes it to the catalog's local path map, not to the entry.

5. Check the catalog and find the entries again:

   ```bash
   charts check --catalog work
   charts find storefront --catalog work
   charts show shop-storefront
   ```

   `check` prints `check: ok`. `find` lists `repository shop-storefront`. `show` prints the entry with `local_path=…` and `local_path_status=ok`.

## Further machine

On every further machine, clone the catalog from its remote instead of creating it. Install and link Charts first, as in [Set up Charts](#set-up-charts).

1. Clone the catalog into the Folio and register it on this machine:

   ```bash
   charts catalog clone work --path ./folio/work --remote https://example.com/charts-work.git
   ```

2. The entries arrived with the clone, but this machine has no local paths yet. `charts show shop-storefront` reports `local_path_status=missing`. Record the path of this machine's clone:

   ```bash
   charts set shop-storefront --catalog work --local-path ~/code/shop/shop-storefront
   ```

3. Check the result:

   ```bash
   charts show shop-storefront
   charts check --catalog work
   ```

   `show` now prints this machine's `local_path` with `local_path_status=ok`.

## Next steps

- Ask an agent to find or change entries. The [charts skill](../.agents/skills/charts/SKILL.md) tells it how.
- Read [docs/structure.md](structure.md) for entry fields, IDs, tags, sync rules, and every `charts` command.
- Run `charts describe --json` for the full command contract.
