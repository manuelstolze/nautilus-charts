import type { CatalogRegistration, CatalogRegistry } from "./ports.ts";

/** Returns the registered catalogs without reading catalog data or contacting remotes. */
export function catalogList(registry: Pick<CatalogRegistry, "list">): CatalogRegistration[] {
  return registry.list();
}
