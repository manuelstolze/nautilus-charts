---
status: accepted
---

# Named catalogs have independent Git histories

Charts stores each named catalog in its own Git repository to keep its history separate, with one configured `origin` remote, Git's local name for that remote address. Each machine maps catalog names to local folders and keeps code-repository paths locally; entry IDs stay unique across catalogs, `depends-on` links can cross catalogs, and `system` links stay within one catalog. Charts commits writes locally, syncs all catalogs on due reads and only the changed one after writes with fast-forward updates, never force-pushes or contacts listed code repositories; migration commits owner-selected copies locally, leaves the root unchanged, and waits for owner review before `charts catalog sync <name>`.
