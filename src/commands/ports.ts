import type { Snapshot } from "../domain/catalog.ts";
import type { Data, Kind } from "../domain/entry.ts";
import type { IgnoreCheck, LocalPathFact } from "../domain/validation.ts";

/**
 * The catalog store: entry files, `tags.toml`, the templates, and `local/paths.toml`.
 */
export interface CatalogStore {
  /** Reads the whole catalog. Unreadable files become load errors. */
  load(): Snapshot;
  /** Whether a file for this ID exists under any entry type, readable or not. */
  entryFileExists(id: string): boolean;
  /**
   * Writes a new entry from its template's field order and, for a repository,
   * records its local path. `path` is the root-relative entry file.
   * - `invalid`: nothing was written.
   * - `failed`: a write failed; the store already rolled back, and `errors`
   *   include any rollback errors.
   * - `created`: `rollback()` removes the entry and restores the previous
   *   `local/paths.toml`, unless a file changed in the meantime. It returns
   *   the rollback errors.
   */
  createEntry(
    kind: Kind,
    id: string,
    data: Data,
    localPath?: string,
  ):
    | { status: "invalid"; path: string; errors: string[] }
    | { status: "failed"; path: string; errors: string[] }
    | { status: "created"; path: string; rollback(): string[] };
}

/** Local Git data: repository roots, remotes, and ignore rules. Never remote access. */
export interface GitInspector {
  /** Resolves a configured local path and checks that it is a Git root with the given remote. */
  inspectLocalPath(rawPath: string, remote?: unknown): LocalPathFact;
  /** Whether Git ignores a path relative to the catalog root. */
  isIgnored(relativePath: string): IgnoreCheck;
}
