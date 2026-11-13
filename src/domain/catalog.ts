import { isString, validDependencies, type Data, type Entry, type Kind } from "./entry.ts";

/** Everything read from the catalog store, in store order. */
export type Snapshot = {
  /** Readable entries, sorted by file name within each type, in type order. */
  entries: Entry[];
  tags: Data;
  tagsExists: boolean;
  /** The raw `local/paths.toml` table, or null when it is missing or unreadable. */
  localPaths: Data | null;
  localPathsExists: boolean;
  loadErrors: string[];
};

export class CatalogIndex {
  readonly snapshot: Snapshot;
  private readonly byId = new Map<string, Entry>();

  constructor(snapshot: Snapshot) {
    this.snapshot = snapshot;
    // The first entry per ID wins.
    for (const entry of snapshot.entries) {
      if (!this.byId.has(entry.id)) this.byId.set(entry.id, entry);
    }
  }

  get entries(): Entry[] {
    return this.snapshot.entries;
  }

  get(id: string): Entry | undefined {
    return this.byId.get(id);
  }

  entriesFor(kind: Kind): Entry[] {
    return this.entries.filter((entry) => entry.kind === kind);
  }

  systemEdges(): Map<string, Map<string, Set<string>>> {
    const edges = new Map<string, Map<string, Set<string>>>();
    for (const repository of this.entriesFor("repository")) {
      const sourceSystem = repository.data.system;
      if (!isString(sourceSystem)) continue;
      for (const dependency of validDependencies(repository.data["depends-on"])) {
        const target = this.get(dependency.id);
        if (!target || target.kind !== "repository" || !isString(target.data.system)) continue;
        const targetSystem = target.data.system;
        if (targetSystem === sourceSystem) continue;
        if (!edges.has(sourceSystem)) edges.set(sourceSystem, new Map());
        const sourceEdges = edges.get(sourceSystem)!;
        if (!sourceEdges.has(targetSystem)) sourceEdges.set(targetSystem, new Set());
        sourceEdges.get(targetSystem)!.add(repository.id);
      }
    }
    return edges;
  }
}
