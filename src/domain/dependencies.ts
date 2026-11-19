import { CatalogIndex } from "./catalog.ts";
import { entryJson, entryName, isString, TICKET_KEY_PATTERN, validDependencies, type Data, type Entry } from "./entry.ts";
import type { LocalPathFacts } from "./validation.ts";

/** Shows an entry. A repository's local path is shown only when its check passed. */
export function resolveTicketKey(
  index: CatalogIndex,
  repository: Entry,
): { key: string | null; source: "repository" | "system" | null } {
  if (repository.kind !== "repository") return { key: null, source: null };
  const repositoryKey = repository.data["ticket-key"];
  if (isString(repositoryKey) && TICKET_KEY_PATTERN.test(repositoryKey)) {
    return { key: repositoryKey, source: "repository" };
  }
  const systemId = repository.data.system;
  if (!isString(systemId)) return { key: null, source: null };
  const system = index.get(systemId);
  if (!system || system.kind !== "system") return { key: null, source: null };
  const systemKey = system.data["ticket-key"];
  if (isString(systemKey) && TICKET_KEY_PATTERN.test(systemKey)) {
    return { key: systemKey, source: "system" };
  }
  return { key: null, source: null };
}

export function showEntry(index: CatalogIndex, entry: Entry, facts: LocalPathFacts): Data {
  const result = entryJson(entry);
  if (entry.kind !== "repository") return result;
  const configured = index.snapshot.localPaths?.[entry.id];
  const fact = facts.get(entry.id);
  if (!isString(configured) || !fact) {
    return { ...result, local_path: null, local_path_status: "not configured" };
  }
  return {
    ...result,
    local_path: fact.error ? null : fact.resolved,
    local_path_status: fact.error ?? "ok",
  };
}

function repositoryDependencies(index: CatalogIndex, repository: Entry): Data[] {
  const result: Data[] = [];
  for (const dependency of validDependencies(repository.data["depends-on"])) {
    const target = index.get(dependency.id);
    const item: Data = { id: dependency.id, type: target?.kind ?? "unknown" };
    if (target) item.name = entryName(target);
    if ("via" in dependency) item.via = dependency.via;
    result.push(item);
  }
  return result;
}

export function dependenciesFor(index: CatalogIndex, entry: Entry): Data {
  if (entry.kind === "repository") {
    return { id: entry.id, type: entry.kind, dependencies: repositoryDependencies(index, entry) };
  }
  const members = index.entriesFor("repository")
    .filter((repository) => repository.data.system === entry.id)
    .sort((left, right) => left.id.localeCompare(right.id));
  const dependencies: Data[] = [];
  for (const repository of members) {
    for (const dependency of repositoryDependencies(index, repository)) {
      dependencies.push({ ...dependency, from: repository.id });
    }
  }

  const systemDependencies: Data[] = [];
  const edges = index.systemEdges().get(entry.id);
  if (edges) {
    for (const [id, repositories] of [...edges.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      systemDependencies.push({ id, type: "system", via_repositories: [...repositories].sort() });
    }
  }
  return {
    id: entry.id,
    type: entry.kind,
    dependencies,
    system_dependencies: systemDependencies,
  };
}

export function reverseDependencies(index: CatalogIndex, entry: Entry): Data {
  let targetIds = new Set([entry.id]);
  if (entry.kind === "system") {
    targetIds = new Set(
      index.entriesFor("repository")
        .filter((repository) => repository.data.system === entry.id)
        .map((repository) => repository.id),
    );
  }

  const direct = new Map<string, Entry>();
  for (const repository of index.entriesFor("repository")) {
    if (validDependencies(repository.data["depends-on"]).some((dependency) => targetIds.has(dependency.id))) {
      direct.set(repository.id, repository);
    }
  }
  const dependents: Data[] = [...direct.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ({ id: item.id, type: item.kind, name: entryName(item) }));

  if (entry.kind === "system") {
    for (const [systemId, targets] of [...index.systemEdges().entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const repositories = targets.get(entry.id);
      if (!repositories) continue;
      const source = index.get(systemId);
      dependents.push({
        id: systemId,
        type: "system",
        name: source ? entryName(source) : systemId,
        via_repositories: [...repositories].sort(),
      });
    }
  }
  return { id: entry.id, type: entry.kind, dependents };
}
