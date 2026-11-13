import { compact, entryJson, entryStatus, isString, type Entry } from "../domain/entry.ts";
import type { Ports } from "./context.ts";

export type FindOptions = { text?: string; system?: string; tag?: string; status?: string; owner?: string };
export type FindResult = { entries: Entry[]; status: number };

export function find({ store }: Ports, options: FindOptions): FindResult {
  const text = (options.text ?? "").toLowerCase();
  const entries = store.load().entries
    .filter((entry) => !text || compact(entryJson(entry)).toLowerCase().includes(text))
    .filter((entry) => {
      if (!options.system) return true;
      return entry.kind === "system" ? entry.id === options.system : entry.data.system === options.system;
    })
    .filter((entry) => {
      if (!options.tag) return true;
      return entry.kind === "repository" && Array.isArray(entry.data.tags) && entry.data.tags.includes(options.tag);
    })
    .filter((entry) => !options.status || entryStatus(entry) === options.status)
    .filter((entry) => !options.owner || (isString(entry.data.owner) && entry.data.owner.toLowerCase().includes(options.owner!.toLowerCase())))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  return { entries, status: 0 };
}
