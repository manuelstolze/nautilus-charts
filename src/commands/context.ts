import type { CatalogIndex } from "../domain/catalog.ts";
import { localPathTargets, type LocalPathFact } from "../domain/validation.ts";
import type { CatalogStore, GitInspector } from "./ports.ts";

/** The ports every use case receives. */
export type Ports = { store: CatalogStore; git: GitInspector };

/** Checks the configured local paths, or only the one for `onlyId`. */
export function localPathFacts(index: CatalogIndex, git: GitInspector, onlyId?: string): Map<string, LocalPathFact> {
  const facts = new Map<string, LocalPathFact>();
  for (const target of localPathTargets(index)) {
    if (onlyId === undefined || target.id === onlyId) {
      facts.set(target.id, git.inspectLocalPath(target.rawPath, target.remote));
    }
  }
  return facts;
}
