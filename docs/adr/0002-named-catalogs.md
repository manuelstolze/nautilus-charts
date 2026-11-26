---
status: accepted
---

# Named catalogs have independent Git histories

Charts stores each named catalog in its own Git repository to keep its history separate, with one configured `origin` remote, Git's local name for that remote address. Each machine maps catalog names to local folders and keeps code-repository paths locally; entry IDs stay unique across catalogs, `depends-on` links can cross catalogs, and `system` links stay within one catalog. Charts commits writes locally, syncs all catalogs on due reads and only the changed one after writes with fast-forward updates, never force-pushes or contacts listed code repositories.

## Completion note

On 2026-11-26, the owner confirmed that the move from the root catalog was complete. The root catalog and its `local/paths.toml` mapping were removed. The `migrate` command was removed. Named catalogs are now the only catalog data source.
