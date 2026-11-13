import { CatalogIndex } from "../domain/catalog.ts";
import { showEntry as showWithFacts } from "../domain/dependencies.ts";
import type { Data, Entry } from "../domain/entry.ts";
import { localPathFacts, type Ports } from "./context.ts";
import type { GitInspector } from "./ports.ts";

export type EntryResult = { status: 0; data: Data } | { status: 2; error: string };

/** Shows an entry, with a repository's local path only when its check passes. */
export function showEntry({ index, git }: { index: CatalogIndex; git: GitInspector }, entry: Entry): Data {
  return showWithFacts(index, entry, localPathFacts(index, git, entry.id));
}

export function unknownEntry(id: string): EntryResult {
  return { status: 2, error: `unknown entry ID: ${id}` };
}

export function show({ store, git }: Ports, id: string): EntryResult {
  const index = new CatalogIndex(store.load());
  const entry = index.get(id);
  if (!entry) return unknownEntry(id);
  return { status: 0, data: showEntry({ index, git }, entry) };
}
