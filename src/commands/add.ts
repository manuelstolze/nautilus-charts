import { CatalogIndex } from "../domain/catalog.ts";
import { entryFile, errorMessage, type Data, type Finding, type Kind } from "../domain/entry.ts";
import { ChartsError, type ErrorCode } from "../domain/errors.ts";
import { validateEntryData, validateNewTags, validationMaps, type NewTag } from "../domain/validation.ts";
import { checkCatalog } from "./check.ts";
import type { Ports } from "./context.ts";

export type AddOptions = { kind: Kind; id: string; data: Data; localPath?: string; newTags?: readonly NewTag[] };
export type AddResult =
  | { ok: true; type: Kind; id: string; path: string; validation: Finding; newTags: string[] }
  | { ok: false; error: ChartsError };

/**
 * Adds an entry: checks the input, writes the entry, its local path and new tags,
 * revalidates the whole catalog, and rolls back when that fails.
 * A failure is `invalid-entry` for validation errors, `refused` when Git does
 * not ignore the entry file, and `external` when Git or a write fails; its
 * details hold the errors and warnings.
 */
export function add(ports: Ports, { kind, id, data, localPath, newTags = [] }: AddOptions): AddResult {
  const { store, git } = ports;
  const path = entryFile(kind, id);
  const failure = (errors: string[], code: ErrorCode = "invalid-entry", warnings: string[] = []): AddResult => {
    const reason = code === "invalid-entry" ? "validation failed" : errors[0];
    return { ok: false, error: new ChartsError(code, `could not add ${kind} ${id}: ${reason}`, { errors, warnings }) };
  };

  const index = new CatalogIndex(store.load());
  // Every loaded entry has a file, and unreadable files count too.
  if (store.entryFileExists(id)) {
    return failure([`ID ${JSON.stringify(id)} already exists`]);
  }

  const ignored = git.isIgnored(path);
  if ("error" in ignored) return failure([`could not check Git ignore rule: ${ignored.error}`], "external");
  if (!ignored.ignored) return failure([`${path} is not ignored by Git`], "refused");

  const newTagErrors = validateNewTags(index.snapshot.tags, newTags, data.tags);
  if (newTagErrors.length) return failure(newTagErrors.map((error) => `${path}: ${error}`));

  const effectiveTags = Object.assign(Object.create(null) as Data, index.snapshot.tags);
  for (const tag of newTags) effectiveTags[tag.name] = tag.description;
  const effectiveIndex = new CatalogIndex({ ...index.snapshot, tags: effectiveTags });
  const maps = validationMaps(index);
  const inputFinding = validateEntryData(effectiveIndex, { kind, id, data, file: path }, maps.seen, maps.keys);
  if (inputFinding.errors.length) return failure(inputFinding.errors, "invalid-entry", inputFinding.warnings);

  const created = store.createEntry(kind, id, data, localPath, newTags);
  if (created.status === "invalid") return failure(created.errors);
  if (created.status === "failed") return failure(created.errors, "external");

  let validation: Finding;
  try {
    validation = checkCatalog(ports);
  } catch (error) {
    return failure([`catalog validation failed: ${errorMessage(error)}`, ...created.rollback()], "external", created.warnings);
  }
  if (validation.errors.length) {
    return failure(
      [...validation.errors, ...created.rollback()],
      "invalid-entry",
      [...validation.warnings, ...created.warnings],
    );
  }
  validation = { ...validation, warnings: [...validation.warnings, ...created.warnings] };
  return { ok: true, type: kind, id, path, validation, newTags: newTags.map(({ name }) => name) };
}
