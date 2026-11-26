import { isString, validDependencies, type Data, type Entry, type Kind } from "./entry.ts";

/** Everything read from one catalog store, in store order. */
export type Snapshot = {
  /** Readable entries, sorted by file name within each type, in type order. */
  entries: Entry[];
  tags: Data;
  tagsExists: boolean;
  /** The raw `local/paths.toml` table, or null when it is missing or unreadable. */
  localPaths: Data | null;
  localPathsExists: boolean;
  loadErrors: string[];
  /** Runtime context supplied by the CLI; it is never stored in catalog files. */
  catalogName?: string;
  catalogs?: readonly NamedCatalogSnapshot[];
};

export type NamedCatalogSnapshot = { name: string; snapshot: Snapshot };
export type CatalogIndexOptions = {
  /** The catalog that owns the primary snapshot. */
  catalogName?: string;
  /** Other registered catalogs that are available for global ID lookups. */
  catalogs?: readonly NamedCatalogSnapshot[];
};

export class CatalogIndex {
  readonly snapshot: Snapshot;
  readonly catalogName: string | undefined;
  private readonly allEntries: Entry[] = [];
  private readonly byId = new Map<string, Entry>();
  private readonly catalogByEntry = new Map<Entry, string | undefined>();
  private readonly snapshotByEntry = new Map<Entry, Snapshot>();
  private readonly loadedCatalogs: Array<{ name?: string; snapshot: Snapshot }>;

  constructor(snapshot: Snapshot, options: CatalogIndexOptions = {}) {
    this.snapshot = snapshot;
    this.catalogName = options.catalogName ?? snapshot.catalogName;
    this.loadedCatalogs = [
      { ...(this.catalogName === undefined ? {} : { name: this.catalogName }), snapshot },
      ...(options.catalogs ?? snapshot.catalogs ?? []),
    ];
    for (const [position, catalog] of this.loadedCatalogs.entries()) {
      for (const entry of catalog.snapshot.entries) {
        this.allEntries.push(entry);
        this.catalogByEntry.set(entry, position === 0 ? this.catalogName : catalog.name);
        this.snapshotByEntry.set(entry, catalog.snapshot);
        // The first entry per ID wins.
        if (!this.byId.has(entry.id)) this.byId.set(entry.id, entry);
      }
    }
  }

  get entries(): Entry[] {
    return this.allEntries;
  }

  get(id: string): Entry | undefined {
    return this.byId.get(id);
  }

  getInCatalog(id: string, catalogName = this.catalogName): Entry | undefined {
    return this.entries.find((entry) => entry.id === id && this.catalogOf(entry) === catalogName);
  }

  get primaryEntries(): Entry[] {
    return this.snapshot.entries;
  }

  catalogOf(entry: Entry): string | undefined {
    return this.catalogByEntry.has(entry) ? this.catalogByEntry.get(entry) : this.catalogName;
  }

  snapshotFor(entry: Entry): Snapshot {
    return this.snapshotByEntry.get(entry) ?? this.snapshot;
  }

  unreadableCatalogs(): NamedCatalogSnapshot[] {
    return this.loadedCatalogs.filter((catalog): catalog is NamedCatalogSnapshot =>
      catalog.name !== undefined && catalog.snapshot.loadErrors.length > 0
    );
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
