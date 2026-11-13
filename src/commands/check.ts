import type { Finding } from "../domain/entry.ts";
import { validateCatalog } from "../domain/validation.ts";
import { localPathFacts, type Ports } from "./context.ts";

/** Validates the whole catalog, including local paths and ignore rules. */
export function checkCatalog({ store, git }: Ports): Finding {
  const snapshot = store.load();
  return validateCatalog(snapshot, {
    localPaths: localPathFacts(snapshot, git),
    localPathsIgnored: git.isIgnored("local/paths.toml"),
  });
}

export type CheckResult = { finding: Finding; status: number };

export function check(ports: Ports): CheckResult {
  const finding = checkCatalog(ports);
  return { finding, status: finding.errors.length ? 1 : 0 };
}
