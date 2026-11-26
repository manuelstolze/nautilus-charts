import type { Snapshot } from "../domain/catalog.ts";
import type { Data, Kind } from "../domain/entry.ts";
import type { IgnoreCheck, LocalPathFact, NewTag } from "../domain/validation.ts";

/**
 * The catalog store: entry files, `tags.toml`, the templates, and `local/paths.toml`.
 */
export interface CatalogRegistration {
  name: string;
  path: string;
  remote: string;
}

/** Machine-local registry for named Charts catalogs. */
export interface CatalogRegistry {
  list(): CatalogRegistration[];
  get(name: string): CatalogRegistration | null;
  register(catalog: CatalogRegistration): void;
}

/** Git operations for named Charts catalogs only. */
export interface CatalogGit {
  initialize(path: string, remote: string): void;
  clone(path: string, remote: string): void;
  /** Refuses a write when its entry or tag files have uncommitted changes. */
  assertWriteClean(path: string, files: readonly string[]): void;
  /** Commits only the named catalog files. Never contacts a remote. */
  commit(path: string, files: readonly string[], message: string): void;
}

export interface CatalogStore {
  /** Reads the whole catalog. Unreadable files become load errors. */
  load(): Snapshot;
  /** Whether a file for this ID exists under any entry type, readable or not. */
  entryFileExists(id: string): boolean;
  /**
   * Writes a new entry from its template's field order, records its local path,
   * and appends any new tags. `path` is the root-relative entry file.
   * - `invalid`: nothing was written.
   * - `failed`: a write failed; the store already rolled back, and `errors`
   *   include any rollback errors.
   * - `created`: `rollback()` removes the entry and restores the previous
   *   `local/paths.toml` and `tags.toml`, unless a file changed in the meantime.
   *   It returns the rollback errors. `warnings` reports any replaced local path.
   */
  createEntry(
    kind: Kind,
    id: string,
    data: Data,
    localPath?: string,
    newTags?: readonly NewTag[],
  ):
    | { status: "invalid"; path: string; errors: string[] }
    | { status: "failed"; path: string; errors: string[] }
    | { status: "created"; path: string; warnings: string[]; rollback(): string[] };
  /** Updates only the named fields, records the local path and appends new tags. */
  updateEntry(
    kind: Kind,
    id: string,
    data: Data,
    changedFields: readonly string[],
    localPath?: string,
    newTags?: readonly NewTag[],
  ):
    | { status: "invalid"; path: string; errors: string[] }
    | { status: "failed"; path: string; errors: string[] }
    | { status: "updated"; path: string; warnings: string[]; rollback(): string[] };
}

/** Local Git data: repository roots, remotes, and ignore rules. Never remote access. */
export interface GitInspector {
  /** Resolves a configured local path and checks that it is a Git root with the given remote. */
  inspectLocalPath(rawPath: string, remote?: unknown, catalogName?: string): LocalPathFact;
  /** Whether Git ignores a path relative to the catalog root. */
  isIgnored(relativePath: string): IgnoreCheck;
}
