import { CatalogIndex } from "../domain/catalog.ts";
import { dependenciesFor, reverseDependencies } from "../domain/dependencies.ts";
import type { Ports } from "./context.ts";
import { unknownEntry, type EntryResult } from "./show.ts";

export function deps({ store }: Ports, id: string): EntryResult {
  const index = new CatalogIndex(store.load());
  const entry = index.get(id);
  if (!entry) return unknownEntry(id);
  if (entry.kind === "external") {
    return { status: 2, error: `deps supports repositories and systems, not external entries: ${entry.id}` };
  }
  return { status: 0, data: dependenciesFor(index, entry) };
}

export function rdeps({ store }: Ports, id: string): EntryResult {
  const index = new CatalogIndex(store.load());
  const entry = index.get(id);
  if (!entry) return unknownEntry(id);
  return { status: 0, data: reverseDependencies(index, entry) };
}
