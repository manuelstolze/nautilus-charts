import { CatalogIndex } from "../domain/catalog.ts";
import { entryFile, errorMessage, type Data, type Finding, type Kind } from "../domain/entry.ts";
import { ChartsError, type ErrorCode } from "../domain/errors.ts";
import { validateEntryData, validateNewTags, validationMaps, type NewTag } from "../domain/validation.ts";
import { checkCatalog } from "./check.ts";
import type { Ports } from "./context.ts";

export type AddOptions = { kind: Kind; id: string; data: Data; localPath?: string; newTags?: readonly NewTag[] };
export type AddResult =
  | { ok: true; type: Kind; id: string; validation: Finding; newTags: string[] }
  | { ok: false; error: ChartsError };

/**
 * Adds an entry: checks the input, writes the entry, its local path and new tags,
 * revalidates the whole catalog, and rolls back when that fails.
 * A failure is `invalid-entry` for validation errors, `refused` when Git does
 * not ignore the entry file, and `external` when Git, a write, or the rollback
 * fails; its details hold the errors and warnings.
 */
export function add(ports: Ports, { kind, id, data, localPath, newTags = [] }: AddOptions): AddResult {
  const { store, git } = ports;
  const path = entryFile(kind, id);
  const failure = (errors: string[], code: ErrorCode = "invalid-entry", warnings: string[] = [], reason = "validation failed"): AddResult => ({
    ok: false,
    error: new ChartsError(code, `could not add ${kind} ${id}: ${reason}`, { errors, warnings }),
  });

  const index = new CatalogIndex(store.load());
  // Every loaded entry has a file, and unreadable files count too.
  if (store.entryFileExists(id)) {
    return failure([`ID ${JSON.stringify(id)} already exists`]);
  }

  if (ports.catalogName === undefined) {
    const ignored = git.isIgnored(path);
    if ("error" in ignored) return failure([`could not check Git ignore rule: ${ignored.error}`], "external", [], "the Git ignore rule could not be checked");
    if (!ignored.ignored) return failure([`${kind} ${id} is not ignored by Git`], "refused", [], "Git does not ignore the entry");
  }

  const newTagErrors = validateNewTags(index.snapshot.tags, newTags, data.tags);
  if (newTagErrors.length) return failure(newTagErrors);

  const effectiveTags = Object.assign(Object.create(null) as Data, index.snapshot.tags);
  for (const tag of newTags) effectiveTags[tag.name] = tag.description;
  const effectiveIndex = new CatalogIndex({ ...index.snapshot, tags: effectiveTags });
  const maps = validationMaps(index);
  const inputFinding = validateEntryData(effectiveIndex, { kind, id, data, file: path }, maps.seen, maps.keys);
  if (inputFinding.errors.length) return failure(inputFinding.errors, "invalid-entry", inputFinding.warnings);

  if (ports.catalogName !== undefined) {
    if (!ports.catalogGit || !ports.catalogPath) return failure(["catalog Git support is not configured"], "external", [], "the catalog could not be committed");
    try {
      ports.catalogGit.assertWriteClean(ports.catalogPath, [path, "tags.toml"]);
    } catch (error) {
      const dirty = errorMessage(error) === "catalog has uncommitted changes to an entry or tag file";
      return failure(
        [dirty ? errorMessage(error) : "could not check catalog files before the write"],
        dirty ? "refused" : "external",
        [],
        dirty ? "catalog files have uncommitted changes" : "the catalog could not be checked",
      );
    }
  }

  const created = store.createEntry(kind, id, data, localPath, newTags);
  if (created.status === "invalid") return failure(created.errors);
  if (created.status === "failed") return failure(created.errors, "external", [], "a write failed");

  let validation: Finding;
  try {
    validation = checkCatalog(ports);
  } catch (error) {
    return failure([`catalog validation failed: ${errorMessage(error)}`, ...created.rollback()], "external", created.warnings, "catalog validation failed");
  }
  if (validation.errors.length) {
    const rollbackErrors = created.rollback();
    return failure(
      [...validation.errors, ...rollbackErrors],
      rollbackErrors.length ? "external" : "invalid-entry",
      [...validation.warnings, ...created.warnings],
      rollbackErrors.length ? "validation failed, and the rollback failed" : "validation failed",
    );
  }
  validation = { ...validation, warnings: [...validation.warnings, ...created.warnings] };
  if (ports.catalogName !== undefined) {
    try {
      ports.catalogGit!.commit(ports.catalogPath!, [path, "tags.toml"], `Add ${kind} ${id}`);
    } catch (error) {
      const rollbackErrors = created.rollback();
      return failure(
        ["could not commit the catalog write", ...rollbackErrors],
        "external",
        validation.warnings,
        rollbackErrors.length ? "the catalog commit and rollback failed" : "the catalog commit failed",
      );
    }
  }
  return { ok: true, type: kind, id, validation, newTags: newTags.map(({ name }) => name) };
}
