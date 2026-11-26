import { CatalogIndex } from "../domain/catalog.ts";
import { ENTRY_DIRS, errorMessage, isRecord, type Data, type Finding, type Kind } from "../domain/entry.ts";
import { ChartsError, entryNotFound, type ErrorCode } from "../domain/errors.ts";
import {
  mergeEntryData,
  validateEntryData,
  validateNewTags,
  validationMaps,
  type NewTag,
} from "../domain/validation.ts";
import { checkCatalog } from "./check.ts";
import type { Ports } from "./context.ts";

export type SetOptions = {
  id: string;
  data?: Data;
  localPath?: string;
  newTags?: readonly NewTag[];
  replaceKey?: boolean;
};
export type SetResult =
  | { ok: true; type: Kind; id: string; changed: string[]; newTags: string[]; validation: Finding }
  | { ok: false; error: ChartsError };

function containsNull(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some(containsNull);
  if (isRecord(value)) return Object.values(value).some(containsNull);
  return false;
}

/**
 * Updates fields on an existing catalog entry and validates the whole catalog.
 * A failure is `entry-not-found` for an unknown ID, `usage` for options that do
 * not fit the entry, `invalid-entry` for validation errors, `refused` when Git
 * does not ignore the entry file, and `external` when Git, a write, or the rollback fails;
 * except for the first two, its details hold the errors and warnings.
 */
export function set(ports: Ports, options: SetOptions): SetResult {
  const { store, git } = ports;
  const snapshot = store.load();
  const index = new CatalogIndex(snapshot);
  const current = index.getInCatalog(options.id);
  const failure = (errors: string[], code: ErrorCode = "invalid-entry", warnings: string[] = [], reason = "validation failed"): SetResult => {
    const name = current ? `${current.kind} ${options.id}` : `entry ${options.id}`;
    return { ok: false, error: new ChartsError(code, `could not set ${name}: ${reason}`, { errors, warnings }) };
  };
  const usage = (message: string): SetResult => ({ ok: false, error: new ChartsError("usage", message) });

  if (!current) {
    if (store.entryFileExists(options.id)) {
      const unreadable = snapshot.loadErrors.find((error) =>
        ENTRY_DIRS.some(([kind]) => error.startsWith(`${kind} ${options.id}:`))
      );
      return failure([unreadable ?? `entry ${JSON.stringify(options.id)} exists but cannot be read`]);
    }
    return { ok: false, error: entryNotFound(options.id) };
  }
  const type = current.kind;
  const path = current.file;

  const { data, localPath, newTags = [], replaceKey = false } = options;
  if (data === undefined && localPath === undefined) return usage("set requires --data or --local-path");
  if (data !== undefined && !isRecord(data)) return usage("--data must be a JSON object");
  if (data && Object.hasOwn(data, "id")) return usage("--data must not contain id");
  if (data && containsNull(data)) return usage("--data must not contain JSON null values");
  if (replaceKey && (!data || !Object.hasOwn(data, "key"))) return usage("--replace-key requires key in --data");
  if (localPath !== undefined && current.kind !== "repository") return usage("--local-path is valid only for a repository");
  if (newTags.length > 0 && current.kind !== "repository") return usage("--new-tag is valid only for a repository");

  if (ports.catalogName === undefined) {
    const ignored = git.isIgnored(path);
    if ("error" in ignored) return failure([`could not check Git ignore rule: ${ignored.error}`], "external", [], "the Git ignore rule could not be checked");
    if (!ignored.ignored) return failure([`${current.kind} ${options.id} is not ignored by Git`], "refused", [], "Git does not ignore the entry");
  }

  const merged = mergeEntryData(current.data, data ?? {});
  if (
    current.kind === "repository"
    && Object.hasOwn(current.data, "key")
    && merged.changed.includes("key")
    && !replaceKey
  ) {
    return failure([`${current.kind} ${options.id}: changing an existing key requires --replace-key`]);
  }

  const newTagErrors = validateNewTags(index.snapshot.tags, newTags, merged.data.tags);
  if (newTagErrors.length) return failure(newTagErrors);

  const effectiveTags = Object.assign(Object.create(null) as Data, index.snapshot.tags);
  for (const tag of newTags) Object.defineProperty(effectiveTags, tag.name, { value: tag.description, enumerable: true, writable: true });
  const effectiveIndex = new CatalogIndex({ ...index.snapshot, tags: effectiveTags });
  const maps = validationMaps(index, options.id);
  const finding = validateEntryData(effectiveIndex, { ...current, data: merged.data }, maps.seen, maps.keys);
  if (finding.errors.length) return failure(finding.errors, "invalid-entry", finding.warnings);

  const localPathUnchanged = localPath === undefined || index.snapshot.localPaths?.[options.id] === localPath;
  if (merged.changed.length === 0 && localPathUnchanged && newTags.length === 0) {
    return {
      ok: true,
      type,
      id: options.id,
      changed: [],
      newTags: [],
      validation: finding,
    };
  }

  if (ports.catalogName !== undefined) {
    if (!ports.catalogGit || !ports.catalogPath || !ports.catalogRemote) return failure(["catalog Git support is not configured"], "external", [], "the catalog could not be committed");
    try {
      ports.catalogGit.assertWriteClean(ports.catalogPath, [path, "tags.toml"]);
    } catch (error) {
      const message = errorMessage(error);
      const dirty = message === "catalog has uncommitted changes to an entry or tag file";
      return failure(
        [dirty ? message : "could not check catalog files before the write"],
        dirty ? "refused" : "external",
        [],
        dirty ? "catalog files have uncommitted changes" : "the catalog could not be checked",
      );
    }
  }

  const updated = store.updateEntry(current.kind, options.id, merged.data, merged.changed, localPath, newTags);
  if (updated.status === "invalid") return failure(updated.errors, "invalid-entry", finding.warnings);
  if (updated.status === "failed") return failure(updated.errors, "external", finding.warnings, "a write failed");

  let validation: Finding;
  try {
    validation = checkCatalog(ports);
  } catch (error) {
    return failure(
      [`catalog validation failed: ${errorMessage(error)}`, ...updated.rollback()],
      "external",
      updated.warnings,
      "catalog validation failed",
    );
  }
  if (validation.errors.length) {
    const rollbackErrors = updated.rollback();
    return failure(
      [...validation.errors, ...rollbackErrors],
      rollbackErrors.length ? "external" : "invalid-entry",
      [...validation.warnings, ...updated.warnings],
      rollbackErrors.length ? "validation failed, and the rollback failed" : "validation failed",
    );
  }
  validation = { ...validation, warnings: [...validation.warnings, ...updated.warnings] };
  if (ports.catalogName !== undefined) {
    try {
      ports.catalogGit!.commit(ports.catalogPath!, [path, "tags.toml"], `Update ${current.kind} ${options.id}`);
    } catch (error) {
      const rollbackErrors = updated.rollback();
      return failure(
        ["could not commit the catalog write", ...rollbackErrors],
        "external",
        validation.warnings,
        rollbackErrors.length ? "the catalog commit and rollback failed" : "the catalog commit failed",
      );
    }
    try {
      ports.catalogGit!.syncWrite(ports.catalogPath!, ports.catalogRemote!);
    } catch {
      validation = {
        ...validation,
        warnings: [...validation.warnings, `catalog ${JSON.stringify(ports.catalogName)} could not sync; local changes were kept`],
      };
    }
  }
  return {
    ok: true,
    type,
    id: options.id,
    changed: merged.changed,
    newTags: newTags.map(({ name }) => name),
    validation,
  };
}
