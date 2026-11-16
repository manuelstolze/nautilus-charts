import { CatalogIndex, type Snapshot } from "./catalog.ts";
import {
  entryStatus,
  FIELDS,
  ID_PATTERN,
  isRecord,
  isString,
  KEY_PATTERN,
  STATUSES,
  type Data,
  type Entry,
  type Finding,
} from "./entry.ts";

/** The result of checking one configured local path. `resolved` is the absolute path. */
export type LocalPathFact = { resolved: string; error: string | null };
export type NewTag = { name: string; description: string };
/** Local path facts per repository ID. */
export type LocalPathFacts = ReadonlyMap<string, LocalPathFact>;
export type IgnoreCheck = { ignored: boolean } | { error: string };
/** Facts about the machine that catalog validation needs. */
export type CatalogFacts = { localPaths: LocalPathFacts; localPathsIgnored: IgnoreCheck };
/** A configured local path that needs a check, with the remote it must match. */
export type LocalPathTarget = { id: string; rawPath: string; remote: unknown };

export function remoteHasCredentials(remote: string): boolean {
  if (!remote.includes("://")) return false;
  try {
    const url = new URL(remote);
    if (url.password || ((url.protocol === "http:" || url.protocol === "https:") && url.username)) return true;
    const sensitive = ["token", "password", "secret", "credential", "api_key", "apikey", "auth"];
    for (const key of url.searchParams.keys()) {
      if (sensitive.some((word) => key.toLowerCase().includes(word))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function validateNewTags(tags: Data, newTags: readonly NewTag[], entryTags: unknown): string[] {
  const errors: string[] = [];
  for (const { name } of newTags) {
    if (!ID_PATTERN.test(name)) errors.push(`new tag ${JSON.stringify(name)} must be lowercase kebab-case`);
    if (Object.hasOwn(tags, name)) errors.push(`tag ${JSON.stringify(name)} is already defined in tags.toml`);
    if (!Array.isArray(entryTags) || !entryTags.includes(name)) {
      errors.push(`new tag ${JSON.stringify(name)} is not used by the entry`);
    }
  }
  return errors;
}

export function validateEntryData(
  index: CatalogIndex,
  entry: Entry,
  seen: Map<string, Entry>,
  keys: Map<string, Entry>,
): Finding {
  const errors: string[] = [];
  const warnings: string[] = [];
  const file = entry.file;
  if (!ID_PATTERN.test(entry.id)) errors.push(`${file}: ID ${JSON.stringify(entry.id)} is not lowercase kebab-case`);
  const prior = seen.get(entry.id);
  if (prior) errors.push(`${file}: duplicate ID ${JSON.stringify(entry.id)}; also used by ${prior.file}`);
  else seen.set(entry.id, entry);

  const unknown = Object.keys(entry.data).filter((field) => !FIELDS[entry.kind].has(field)).sort();
  if (unknown.length) errors.push(`${file}: unknown field(s): ${unknown.join(", ")}`);
  if (!("description" in entry.data)) errors.push(`${file}: missing required field: description`);
  else if (!isString(entry.data.description)) errors.push(`${file}: description must be a string`);

  for (const field of ["name", "owner", "remote", "default-branch"]) {
    if (field in entry.data && !isString(entry.data[field])) errors.push(`${file}: ${field} must be a string`);
  }
  if (entry.kind === "external") {
    for (const field of ["provider", "kind"]) {
      if (field in entry.data && !isString(entry.data[field])) errors.push(`${file}: ${field} must be a string`);
    }
  }

  const status = entryStatus(entry);
  if (!isString(status) || !STATUSES.has(status)) errors.push(`${file}: invalid status ${JSON.stringify(status)}`);
  if (isString(entry.data.remote) && remoteHasCredentials(entry.data.remote)) {
    errors.push(`${file}: remote must not contain credentials`);
  }

  if (entry.kind !== "repository") return { errors, warnings };
  const key = entry.data.key;
  if (key !== undefined && (!isString(key) || !KEY_PATTERN.test(key))) {
    errors.push(`${file}: key must be 2–5 characters: an uppercase letter, then uppercase letters or digits`);
  } else if (isString(key)) {
    const priorKey = keys.get(key);
    if (priorKey) errors.push(`${file}: duplicate key ${JSON.stringify(key)}; also used by ${priorKey.file}`);
    else keys.set(key, entry);
  }

  const systemId = entry.data.system;
  if (systemId !== undefined && !isString(systemId)) {
    errors.push(`${file}: system must be a string`);
  } else if (isString(systemId)) {
    const target = index.get(systemId);
    if (!target || target.kind !== "system") errors.push(`${file}: system ${JSON.stringify(systemId)} does not name a system`);
  }

  const tags = entry.data.tags ?? [];
  if (!Array.isArray(tags) || tags.some((tag) => !isString(tag))) {
    errors.push(`${file}: tags must be a list of strings`);
  } else {
    for (const tag of tags) {
      if (!Object.hasOwn(index.snapshot.tags, tag)) errors.push(`${file}: tag ${JSON.stringify(tag)} is not defined in tags.toml`);
    }
  }

  const rawDependencies = entry.data["depends-on"] ?? [];
  if (!Array.isArray(rawDependencies)) {
    errors.push(`${file}: depends-on must be a list`);
    return { errors, warnings };
  }
  for (const [position, rawDependency] of rawDependencies.entries()) {
    const label = `${file}: depends-on[${position}]`;
    if (!isRecord(rawDependency)) {
      errors.push(`${label} must be a table`);
      continue;
    }
    const extra = Object.keys(rawDependency).filter((field) => !["id", "via"].includes(field)).sort();
    if (extra.length) errors.push(`${label} has unknown field(s): ${extra.join(", ")}`);
    const dependencyId = rawDependency.id;
    if (!isString(dependencyId)) {
      errors.push(`${label} requires a string id`);
      continue;
    }
    if (dependencyId === entry.id) errors.push(`${label} cannot point to the same repository`);
    const target = index.get(dependencyId);
    if (!target) errors.push(`${label} ID ${JSON.stringify(dependencyId)} does not exist`);
    else if (target.kind !== "repository" && target.kind !== "external") {
      errors.push(`${label} ID ${JSON.stringify(dependencyId)} is not a repository or external`);
    }
    if ("via" in rawDependency && !isString(rawDependency.via)) errors.push(`${label} via must be a string`);
    const dependencyStatus = target ? entryStatus(target) : "active";
    if (target && (dependencyStatus === "deprecated" || dependencyStatus === "archived")) {
      warnings.push(`${label} points to ${dependencyStatus} entry ${JSON.stringify(dependencyId)}`);
    }
  }
  return { errors, warnings };
}

/** The IDs and keys already taken, for checking a new entry against the catalog. */
export function validationMaps(index: CatalogIndex): { seen: Map<string, Entry>; keys: Map<string, Entry> } {
  const seen = new Map<string, Entry>();
  const keys = new Map<string, Entry>();
  for (const entry of index.entries) {
    if (!seen.has(entry.id)) seen.set(entry.id, entry);
    const key = entry.kind === "repository" ? entry.data.key : undefined;
    if (isString(key) && KEY_PATTERN.test(key) && !keys.has(key)) keys.set(key, entry);
  }
  return { seen, keys };
}

/** The configured local paths that name a repository and so need a check on this machine. */
export function localPathTargets(index: CatalogIndex): LocalPathTarget[] {
  const targets: LocalPathTarget[] = [];
  for (const [id, rawPath] of Object.entries(index.snapshot.localPaths ?? {})) {
    const target = index.get(id);
    if (isString(rawPath) && target?.kind === "repository") targets.push({ id, rawPath, remote: target.data.remote });
  }
  return targets;
}

export function validateCatalog(snapshot: Snapshot, facts: CatalogFacts): Finding {
  const index = new CatalogIndex(snapshot);
  const errors = [...snapshot.loadErrors];
  const warnings: string[] = [];
  const seen = new Map<string, Entry>();
  const keys = new Map<string, Entry>();

  for (const entry of snapshot.entries) {
    const result = validateEntryData(index, entry, seen, keys);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  if (!snapshot.tagsExists) errors.push("tags.toml is missing");
  for (const [tag, description] of Object.entries(snapshot.tags)) {
    if (!isString(description)) errors.push(`tags.toml: description for ${JSON.stringify(tag)} must be a string`);
  }

  if (snapshot.localPaths === null) {
    if (!snapshot.localPathsExists) warnings.push("local/paths.toml is missing; local path checks were skipped");
  } else {
    for (const [repositoryId, rawPath] of Object.entries(snapshot.localPaths)) {
      if (!isString(rawPath)) {
        errors.push(`local/paths.toml: path for ${JSON.stringify(repositoryId)} must be a string`);
        continue;
      }
      const target = index.get(repositoryId);
      if (!target || target.kind !== "repository") {
        errors.push(`local/paths.toml: ${JSON.stringify(repositoryId)} does not name a repository`);
        continue;
      }
      const pathError = facts.localPaths.get(repositoryId)?.error;
      if (pathError) errors.push(`local/paths.toml: ${pathError} for ${JSON.stringify(repositoryId)}`);
    }
  }

  const ignored = facts.localPathsIgnored;
  if ("error" in ignored) errors.push(`could not check Git ignore rule: ${ignored.error}`);
  else if (!ignored.ignored) errors.push("local/paths.toml is not ignored by Git");

  return { errors, warnings: [...new Set(warnings)].sort() };
}
