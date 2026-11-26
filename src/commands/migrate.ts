import { CatalogIndex } from "../domain/catalog.ts";
import { entryFile, errorMessage, isString, type Data, type Entry, type Finding } from "../domain/entry.ts";
import { ChartsError, entryNotFound, type ErrorCode } from "../domain/errors.ts";
import { validateEntryData, validationMaps, type NewTag } from "../domain/validation.ts";
import { checkCatalog } from "./check.ts";
import type { Ports } from "./context.ts";
import type { CatalogStore, GitInspector } from "./ports.ts";

export type MigrateResult =
  | { ok: true; type: Entry["kind"]; id: string; catalog: string; validation: Finding }
  | { ok: false; error: ChartsError };

export type MigratePorts = {
  source: CatalogStore;
  sourceGit: GitInspector;
  destination: Ports;
};

/** Copies one root entry to a named catalog, validates and commits it without syncing. */
export function migrate({ source, sourceGit, destination }: MigratePorts, id: string): MigrateResult {
  const destinationName = destination.catalogName;
  if (destinationName === undefined) {
    return { ok: false, error: new ChartsError("usage", "migration requires a named destination catalog") };
  }
  const failure = (
    entryKind: Entry["kind"] | undefined,
    errors: string[],
    code: ErrorCode = "invalid-entry",
    warnings: string[] = [],
    reason = "validation failed",
  ): MigrateResult => ({
    ok: false,
    error: new ChartsError(code, `could not migrate ${entryKind ? `${entryKind} ` : "entry "}${id} to catalog ${JSON.stringify(destinationName)}: ${reason}`, { errors, warnings }),
  });

  const sourceSnapshot = source.load();
  const sourceIndex = new CatalogIndex(sourceSnapshot);
  const entry = sourceIndex.get(id);
  if (!entry) {
    if (source.entryFileExists(id)) {
      const loadError = sourceSnapshot.loadErrors.find((error) => error.includes(` ${id}:`));
      return failure(undefined, [loadError ?? `entry ${JSON.stringify(id)} exists but cannot be read`], "invalid-entry", [], "the source entry could not be read");
    }
    return { ok: false, error: entryNotFound(id) };
  }
  const sourceMatches = sourceIndex.entries.filter((candidate) => candidate.id === id);
  if (sourceMatches.length > 1) return failure(entry.kind, [`ID ${JSON.stringify(id)} is duplicated in the root catalog`]);

  const destinationSnapshot = destination.store.load();
  const destinationIndex = new CatalogIndex(destinationSnapshot);
  if (destination.store.entryFileExists(id)) {
    return failure(entry.kind, [`ID ${JSON.stringify(id)} already exists in the destination catalog`]);
  }

  const newTags: NewTag[] = [];
  if (entry.kind === "repository" && Array.isArray(entry.data.tags)) {
    for (const tag of new Set(entry.data.tags.filter(isString))) {
      if (!Object.hasOwn(sourceSnapshot.tags, tag) || !isString(sourceSnapshot.tags[tag])) {
        return failure(entry.kind, [`source tag ${JSON.stringify(tag)} has no valid definition`]);
      }
      if (Object.hasOwn(destinationSnapshot.tags, tag)) {
        if (destinationSnapshot.tags[tag] !== sourceSnapshot.tags[tag]) {
          return failure(entry.kind, [`tag ${JSON.stringify(tag)} has a different definition in the destination catalog`]);
        }
      } else newTags.push({ name: tag, description: sourceSnapshot.tags[tag] as string });
    }
  }

  let localPath: string | undefined;
  if (entry.kind === "repository" && sourceSnapshot.localPathsExists && sourceSnapshot.localPaths === null) {
    return failure(entry.kind, ["the root local paths could not be read"], "invalid-entry", [], "the source local path could not be copied");
  }
  if (entry.kind === "repository" && sourceSnapshot.localPaths && Object.hasOwn(sourceSnapshot.localPaths, id)) {
    const rawPath = sourceSnapshot.localPaths[id];
    if (!isString(rawPath)) return failure(entry.kind, [`the root local path for ${JSON.stringify(id)} is not a string`]);
    localPath = sourceGit.inspectLocalPath(rawPath, entry.data.remote).resolved;
  }

  const maps = validationMaps(destinationIndex);
  const effectiveTags: Data = Object.assign(Object.create(null) as Data, destinationSnapshot.tags);
  for (const tag of newTags) Object.defineProperty(effectiveTags, tag.name, { value: tag.description, enumerable: true, writable: true });
  const effectiveIndex = new CatalogIndex({ ...destinationSnapshot, tags: effectiveTags });
  const inputFinding = validateEntryData(effectiveIndex, entry, maps.seen, maps.keys);
  if (inputFinding.errors.length) return failure(entry.kind, inputFinding.errors, "invalid-entry", inputFinding.warnings);

  const entryPath = entryFile(entry.kind, id);
  if (!destination.catalogGit || !destination.catalogPath || !destination.catalogRemote) {
    return failure(entry.kind, ["catalog Git support is not configured"], "external", [], "the destination could not be committed");
  }
  try {
    destination.catalogGit.assertWriteClean(destination.catalogPath, [entryPath, "tags.toml"]);
  } catch (error) {
    const message = errorMessage(error);
    const dirty = message === "catalog has uncommitted changes to an entry or tag file";
    return failure(
      entry.kind,
      [dirty ? message : "could not check destination files before the copy"],
      dirty ? "refused" : "external",
      [],
      dirty ? "destination files have uncommitted changes" : "the destination could not be checked",
    );
  }

  const created = destination.store.createEntry(entry.kind, id, entry.data, localPath, newTags);
  if (created.status === "invalid") return failure(entry.kind, created.errors);
  if (created.status === "failed") return failure(entry.kind, created.errors, "external", [], "the destination write failed");

  let validation: Finding;
  try {
    validation = checkCatalog(destination);
  } catch (error) {
    return failure(entry.kind, [`destination check failed: ${errorMessage(error)}`, ...created.rollback()], "external", created.warnings, "destination validation failed");
  }
  if (validation.errors.length) {
    const rollbackErrors = created.rollback();
    return failure(
      entry.kind,
      [...validation.errors, ...rollbackErrors],
      rollbackErrors.length ? "external" : "invalid-entry",
      [...validation.warnings, ...created.warnings],
      rollbackErrors.length ? "destination check and rollback failed" : "destination validation failed",
    );
  }
  validation = { ...validation, warnings: [...validation.warnings, ...created.warnings] };

  try {
    destination.catalogGit.commit(destination.catalogPath, [entryPath, "tags.toml"], `Migrate ${entry.kind} ${id}`);
  } catch {
    const rollbackErrors = created.rollback();
    return failure(
      entry.kind,
      ["could not commit the destination copy", ...rollbackErrors],
      "external",
      validation.warnings,
      rollbackErrors.length ? "the destination commit and rollback failed" : "the destination commit failed",
    );
  }
  return { ok: true, type: entry.kind, id, catalog: destinationName, validation };
}
