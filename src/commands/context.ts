import { CatalogIndex, type NamedCatalogSnapshot, type Snapshot } from "../domain/catalog.ts";
import { localPathTargets, type LocalPathFact } from "../domain/validation.ts";
import type { CatalogStore, GitInspector } from "./ports.ts";

export type RelatedCatalog = NamedCatalogSnapshot & { git: GitInspector };

/** The ports every use case receives. */
export type Ports = {
  store: CatalogStore;
  git: GitInspector;
  catalogName?: string;
  catalogs?: readonly RelatedCatalog[];
};

/** Builds an index for the selected catalog and all other registered catalogs. */
export function catalogIndex(snapshot: Snapshot, ports: Ports): CatalogIndex {
  return new CatalogIndex(snapshot, { catalogName: ports.catalogName, catalogs: ports.catalogs });
}

/** Checks the configured local paths, or only the one for `onlyId`. */
export function localPathFacts(
  index: CatalogIndex,
  git: GitInspector,
  onlyId?: string,
  catalogs: readonly RelatedCatalog[] = [],
): Map<string, LocalPathFact> {
  const facts = new Map<string, LocalPathFact>();
  for (const target of localPathTargets(index)) {
    if (onlyId !== undefined && target.id !== onlyId) continue;
    const pathGit = target.catalogName === undefined || target.catalogName === index.catalogName
      ? git
      : catalogs.find(({ name }) => name === target.catalogName)?.git;
    if (!pathGit) {
      facts.set(target.id, {
        resolved: target.rawPath,
        error: `catalog ${JSON.stringify(target.catalogName)} is not available for local path checks`,
      });
    } else facts.set(target.id, pathGit.inspectLocalPath(target.rawPath, target.remote));
  }
  return facts;
}
