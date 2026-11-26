export type Kind = "system" | "repository" | "external";
export type Data = Record<string, unknown>;
export type Dependency = { id: string; via?: unknown; [key: string]: unknown };
/** A catalog entry. `file` is its label relative to the catalog, such as `systems/shop.toml`. */
export type Entry = { kind: Kind; id: string; data: Data; file: string };
export type Finding = { errors: string[]; warnings: string[] };

export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,4}$/;
export const TICKET_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
export const ENTRY_DIRS: Array<[Kind, string]> = [
  ["system", "systems"],
  ["repository", "repositories"],
  ["external", "externals"],
];
/** The catalog-relative file that maps repository IDs to local paths. */
export const LOCAL_PATHS_FILE = "local/paths.toml";

export function localPathReplacementWarning(id: string): string {
  return `replaced the existing local path for ${JSON.stringify(id)} in the local paths`;
}

export const STATUSES = new Set(["planned", "active", "deprecated", "archived"]);
export const FIELD_ORDER: Record<Kind, string[]> = {
  system: ["name", "description", "owner", "ticket-key", "status"],
  repository: [
    "name",
    "description",
    "key",
    "ticket-key",
    "system",
    "status",
    "owner",
    "tags",
    "remote",
    "default-branch",
    "depends-on",
  ],
  external: ["name", "description", "provider", "kind", "status"],
};
export const FIELDS: Record<Kind, Set<string>> = {
  system: new Set(FIELD_ORDER.system),
  repository: new Set(FIELD_ORDER.repository),
  external: new Set(FIELD_ORDER.external),
};

export function isRecord(value: unknown): value is Data {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isKind(value: unknown): value is Kind {
  return ENTRY_DIRS.some(([kind]) => kind === value);
}

export function entryDirectory(kind: Kind): string {
  return ENTRY_DIRS.find(([entryKind]) => entryKind === kind)![1];
}

/** The catalog-relative label of an entry file. */
export function entryFile(kind: Kind, id: string): string {
  return `${entryDirectory(kind)}/${id}.toml`;
}

export function entryName(entry: Entry): string {
  return isString(entry.data.name) ? entry.data.name : entry.id;
}

export function entryStatus(entry: Entry): unknown {
  return entry.data.status ?? "active";
}

export function compact(value: unknown): string {
  if (Array.isArray(value)) return value.map(compact).join(", ");
  if (isRecord(value)) return Object.entries(value).map(([key, item]) => `${key}=${compact(item)}`).join(", ");
  return String(value).replace(/\s+/g, " ").trim();
}

export function entryJson(entry: Entry): Data {
  return { ...entry.data, type: entry.kind, id: entry.id, name: entryName(entry) };
}

export function validDependencies(value: unknown): Dependency[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Dependency => isRecord(item) && isString(item.id));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
