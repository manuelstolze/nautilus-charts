import { CatalogIndex } from "../domain/catalog.ts";
import { dependenciesFor, reverseDependencies } from "../domain/dependencies.ts";
import { ChartsError } from "../domain/errors.ts";
import type { Ports } from "./context.ts";
import { unknownEntry, type EntryResult } from "./show.ts";

export function deps({ store }: Ports, id: string): EntryResult {
  const index = new CatalogIndex(store.load());
  const entry = index.get(id);
  if (!entry) return unknownEntry(id);
  if (entry.kind === "external") {
    return {
      ok: false,
      error: new ChartsError("usage", `deps supports repositories and systems, not external entries: ${entry.id}`, { id: entry.id }),
    };
  }
  return { ok: true, data: dependenciesFor(index, entry) };
}

export function rdeps({ store }: Ports, id: string): EntryResult {
  const index = new CatalogIndex(store.load());
  const entry = index.get(id);
  if (!entry) return unknownEntry(id);
  return { ok: true, data: reverseDependencies(index, entry) };
}
