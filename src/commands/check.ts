import { CatalogIndex } from "../domain/catalog.ts";
import { LOCAL_PATHS_FILE, type Finding } from "../domain/entry.ts";
import { validateCatalog } from "../domain/validation.ts";
import { localPathFacts, type Ports } from "./context.ts";

/** Validates the whole catalog, including local paths and ignore rules. */
export function checkCatalog({ store, git }: Ports): Finding {
  const index = new CatalogIndex(store.load());
  return validateCatalog(index.snapshot, {
    localPaths: localPathFacts(index, git),
    localPathsIgnored: git.isIgnored(LOCAL_PATHS_FILE),
  });
}

export type CheckResult = { finding: Finding };

export function check(ports: Ports): CheckResult {
  return { finding: checkCatalog(ports) };
}
