---
status: accepted
---

# Named catalogs have independent Git histories

Charts stores each named catalog, such as `work` or `personal`, in its own Git repository. Commands name the catalog they use, each machine maps that name to a local folder, and each code repository belongs to one catalog. Catalog owners may configure one or more Git remotes and share catalog data through them. Charts syncs only its own catalogs; it never contacts or changes the code repositories listed in them. This keeps catalog data separate while local paths remain machine-specific.
