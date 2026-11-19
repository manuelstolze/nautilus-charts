import { CatalogIndex } from "../domain/catalog.ts";
import { entryFile, errorMessage, isRecord, type Data, type Finding, type Kind } from "../domain/entry.ts";
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
export type SetResult = {
  ok: boolean;
  type: Kind | null;
  id: string;
  path: string;
  changed: string[];
  newTags: string[];
  validation: Finding;
  status: number;
};

function containsNull(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some(containsNull);
  if (isRecord(value)) return Object.values(value).some(containsNull);
  return false;
}

/** Updates fields on an existing catalog entry and validates the whole catalog. */
export function set(ports: Ports, options: SetOptions): SetResult {
  const { store, git } = ports;
  const snapshot = store.load();
  const index = new CatalogIndex(snapshot);
  const current = index.get(options.id);
  let type: Kind | null = current?.kind ?? null;
  let path = current?.file ?? "";
  const failure = (errors: string[], status = 2, changed: string[] = [], warnings: string[] = []): SetResult => ({
    ok: false,
    type,
    id: options.id,
    path,
    changed,
    newTags: [],
    validation: { errors, warnings },
    status,
  });

  if (!current) {
    if (store.entryFileExists(options.id)) {
      const unreadablePath = snapshot.loadErrors
        .map((error) => error.slice(0, error.indexOf(":")))
        .find((file) => file.endsWith(`/${options.id}.toml`));
      path = unreadablePath ?? "";
      return failure([unreadablePath ? `cannot read entry ${unreadablePath}` : `entry ${JSON.stringify(options.id)} exists but cannot be read`]);
    }
    return failure([`unknown ID ${JSON.stringify(options.id)}`]);
  }

  const { data, localPath, newTags = [], replaceKey = false } = options;
  if (data === undefined && localPath === undefined) return failure(["set requires --data or --local-path"]);
  if (data !== undefined && !isRecord(data)) return failure(["--data must be a JSON object"]);
  if (data && Object.hasOwn(data, "id")) return failure(["--data must not contain id"]);
  if (data && containsNull(data)) return failure(["--data must not contain JSON null values"]);
  if (replaceKey && (!data || !Object.hasOwn(data, "key"))) {
    return failure(["--replace-key requires key in --data"]);
  }
  if (localPath !== undefined && current.kind !== "repository") return failure(["--local-path is valid only for a repository"]);
  if (newTags.length > 0 && current.kind !== "repository") return failure(["--new-tag is valid only for a repository"]);

  const ignored = git.isIgnored(path);
  if ("error" in ignored) return failure([`could not check Git ignore rule: ${ignored.error}`]);
  if (!ignored.ignored) return failure([`${path} is not ignored by Git`]);

  const merged = mergeEntryData(current.data, data ?? {});
  if (
    current.kind === "repository"
    && Object.hasOwn(current.data, "key")
    && merged.changed.includes("key")
    && !replaceKey
  ) {
    return failure([`${path}: changing an existing key requires --replace-key`], 2, merged.changed);
  }

  const newTagErrors = validateNewTags(index.snapshot.tags, newTags, merged.data.tags);
  if (newTagErrors.length) return failure(newTagErrors.map((error) => `${path}: ${error}`), 2, merged.changed);

  const effectiveTags = Object.assign(Object.create(null) as Data, index.snapshot.tags);
  for (const tag of newTags) Object.defineProperty(effectiveTags, tag.name, { value: tag.description, enumerable: true, writable: true });
  const effectiveIndex = new CatalogIndex({ ...index.snapshot, tags: effectiveTags });
  const maps = validationMaps(index, options.id);
  const finding = validateEntryData(effectiveIndex, { ...current, data: merged.data }, maps.seen, maps.keys);
  if (finding.errors.length) return failure(finding.errors, 2, merged.changed, finding.warnings);

  const localPathUnchanged = localPath === undefined || index.snapshot.localPaths?.[options.id] === localPath;
  if (merged.changed.length === 0 && localPathUnchanged && newTags.length === 0) {
    return {
      ok: true,
      type,
      id: options.id,
      path,
      changed: [],
      newTags: [],
      validation: finding,
      status: 0,
    };
  }

  const updated = store.updateEntry(current.kind, options.id, merged.data, merged.changed, localPath, newTags);
  if (updated.status === "invalid") return failure(updated.errors, 2, merged.changed, finding.warnings);
  if (updated.status === "failed") return failure(updated.errors, 1, merged.changed, finding.warnings);

  let validation: Finding;
  try {
    validation = checkCatalog(ports);
  } catch (error) {
    return failure(
      [`catalog validation failed: ${errorMessage(error)}`, ...updated.rollback()],
      1,
      merged.changed,
      updated.warnings,
    );
  }
  if (validation.errors.length) {
    return failure(
      [...validation.errors, ...updated.rollback()],
      1,
      merged.changed,
      [...validation.warnings, ...updated.warnings],
    );
  }
  validation = { ...validation, warnings: [...validation.warnings, ...updated.warnings] };
  return {
    ok: true,
    type,
    id: options.id,
    path: entryFile(current.kind, options.id),
    changed: merged.changed,
    newTags: newTags.map(({ name }) => name),
    validation,
    status: 0,
  };
}
