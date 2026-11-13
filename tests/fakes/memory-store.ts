import type { CatalogStore } from "../../src/commands/ports.ts";
import type { Snapshot } from "../../src/domain/catalog.ts";
import { ENTRY_DIRS, entryFile, type Data, type Entry, type Kind } from "../../src/domain/entry.ts";

type FakeEntry = { kind: Kind; id: string; data: Data };

/** An in-memory catalog store for use-case tests. */
export class MemoryStore implements CatalogStore {
  entries: Entry[];
  /** Entry files that exist but cannot be read, as root-relative labels. */
  unreadable: string[];
  tags: Data | null;
  localPaths: Data | null;
  /** The text "written" for each entry file. */
  readonly files = new Map<string, string>();
  /** Simulates another writer that changes these files before a rollback. */
  changeBeforeRollback = new Set<"entry" | "localPaths">();
  /** Makes the next write fail with this message. */
  failWrite: string | null = null;

  constructor(options: { entries?: FakeEntry[]; unreadable?: string[]; tags?: Data | null; localPaths?: Data | null } = {}) {
    this.entries = (options.entries ?? []).map((entry) => ({ ...entry, file: entryFile(entry.kind, entry.id) }));
    this.unreadable = options.unreadable ?? [];
    this.tags = options.tags === undefined ? {} : options.tags;
    this.localPaths = options.localPaths ?? null;
  }

  load(): Snapshot {
    const order = (entry: Entry) => ENTRY_DIRS.findIndex(([kind]) => kind === entry.kind);
    return structuredClone({
      entries: [...this.entries].sort((left, right) => order(left) - order(right) || left.file.localeCompare(right.file)),
      tags: this.tags ?? {},
      tagsExists: this.tags !== null,
      localPaths: this.localPaths,
      localPathsExists: this.localPaths !== null,
      loadErrors: this.unreadable.map((file) => `${file}: invalid TOML: unreadable`),
    });
  }

  entryFileExists(id: string): boolean {
    return ENTRY_DIRS.some(([kind]) => {
      const file = entryFile(kind, id);
      return this.entries.some((entry) => entry.file === file) || this.unreadable.includes(file);
    });
  }

  createEntry(kind: Kind, id: string, data: Data, localPath?: string): ReturnType<CatalogStore["createEntry"]> {
    const path = entryFile(kind, id);
    if (this.failWrite) return { status: "failed", path, errors: [`could not write entry: ${this.failWrite}`] };
    const entry: Entry = { kind, id, data: structuredClone(data), file: path };
    const text = JSON.stringify(data);
    const previousLocalPaths = this.localPaths;
    this.entries.push(entry);
    this.files.set(path, text);
    if (localPath !== undefined) this.localPaths = { ...(previousLocalPaths ?? {}), [id]: localPath };
    const writtenLocalPaths = this.localPaths;

    const rollback = (): string[] => {
      const errors: string[] = [];
      if (this.changeBeforeRollback.has("entry")) this.files.set(path, `${text} changed`);
      if (this.changeBeforeRollback.has("localPaths")) this.localPaths = { ...(this.localPaths ?? {}), other: "changed" };
      if (this.files.get(path) !== text) {
        errors.push("new entry changed during rollback and was not removed");
      } else {
        this.entries = this.entries.filter((item) => item !== entry);
        this.files.delete(path);
      }
      if (localPath !== undefined) {
        if (this.localPaths !== writtenLocalPaths) errors.push("local/paths.toml changed during rollback and was not restored");
        else this.localPaths = previousLocalPaths;
      }
      return errors;
    };
    return { status: "created", path, rollback };
  }
}
