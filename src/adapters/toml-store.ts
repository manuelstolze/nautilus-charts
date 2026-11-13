import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Snapshot } from "../domain/catalog.ts";
import {
  ENTRY_DIRS,
  entryFile,
  errorMessage,
  FIELD_ORDER,
  isRecord,
  LOCAL_PATHS_FILE as LOCAL_PATHS,
  type Data,
  type Kind,
} from "../domain/entry.ts";
import type { CatalogStore } from "../commands/ports.ts";

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

function tomlValue(value: unknown): string {
  if (value === null || value === undefined) throw new Error("JSON null values cannot be written to TOML");
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("number is outside the TOML range");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (isRecord(value)) {
    const pairs = Object.entries(value).map(([key, item]) => `${tomlKey(key)} = ${tomlValue(item)}`);
    return `{ ${pairs.join(", ")} }`;
  }
  throw new Error(`unsupported TOML value: ${String(value)}`);
}

function tomlTable(data: Data, order: string[] = Object.keys(data)): string {
  return order
    .filter((key) => Object.prototype.hasOwnProperty.call(data, key))
    .map((key) => `${tomlKey(key)} = ${tomlValue(data[key])}`)
    .join("\n") + "\n";
}

/** The catalog store on disk: TOML files under the catalog root. */
export class TomlStore implements CatalogStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  load(): Snapshot {
    const snapshot: Snapshot = {
      entries: [],
      tags: {},
      tagsExists: existsSync(join(this.root, "tags.toml")),
      localPaths: null,
      localPathsExists: existsSync(join(this.root, LOCAL_PATHS)),
      loadErrors: [],
    };
    const readToml = (label: string): Data | null => {
      try {
        const value: unknown = parseToml(readFileSync(join(this.root, label), "utf8"));
        if (!isRecord(value)) {
          snapshot.loadErrors.push(`${label}: expected a TOML table`);
          return null;
        }
        return value;
      } catch (error) {
        snapshot.loadErrors.push(`${label}: invalid TOML: ${errorMessage(error)}`);
        return null;
      }
    };

    for (const [kind, directory] of ENTRY_DIRS) {
      const folder = join(this.root, directory);
      if (!existsSync(folder)) continue;
      let files: string[];
      try {
        files = readdirSync(folder).filter((file) => file.endsWith(".toml")).sort();
      } catch (error) {
        snapshot.loadErrors.push(`${directory}: cannot read entries: ${errorMessage(error)}`);
        continue;
      }
      for (const file of files) {
        const label = `${directory}/${file}`;
        const data = readToml(label);
        if (data) snapshot.entries.push({ kind, id: file.slice(0, -5), data, file: label });
      }
    }
    if (snapshot.tagsExists) Object.assign(snapshot.tags, readToml("tags.toml") ?? {});
    if (snapshot.localPathsExists) snapshot.localPaths = readToml(LOCAL_PATHS);
    return snapshot;
  }

  entryFileExists(id: string): boolean {
    return ENTRY_DIRS.some(([, directory]) => existsSync(join(this.root, directory, `${id}.toml`)));
  }

  private renderEntry(kind: Kind, data: Data): string {
    const templateValue: unknown = parseToml(readFileSync(join(this.root, "templates", `${kind}.toml`), "utf8"));
    if (!isRecord(templateValue)) throw new Error(`templates/${kind}.toml must contain a TOML table`);
    // Use the template's field order, but never copy its sample values.
    const order = [...new Set([...Object.keys(templateValue), ...FIELD_ORDER[kind]])];
    return tomlTable(data, order);
  }

  createEntry(kind: Kind, id: string, data: Data, localPath?: string): ReturnType<CatalogStore["createEntry"]> {
    const path = entryFile(kind, id);
    const entryPath = join(this.root, path);
    const localPathFile = join(this.root, LOCAL_PATHS);
    const invalid = (errors: string[]) => ({ status: "invalid" as const, path, errors });

    let entryText: string;
    try {
      entryText = this.renderEntry(kind, data);
    } catch (error) {
      return invalid([`cannot create entry from template: ${errorMessage(error)}`]);
    }

    let previousLocalPathText: string | null = null;
    let localPathText: string | null = null;
    if (localPath !== undefined) {
      try {
        if (existsSync(localPathFile)) {
          previousLocalPathText = readFileSync(localPathFile, "utf8");
          const parsed: unknown = parseToml(previousLocalPathText);
          if (!isRecord(parsed)) return invalid([`${LOCAL_PATHS} must contain a TOML table`]);
          localPathText = tomlTable({ ...parsed, [id]: localPath });
        } else {
          localPathText = tomlTable({ [id]: localPath });
        }
      } catch (error) {
        return invalid([`cannot update ${LOCAL_PATHS}: ${errorMessage(error)}`]);
      }
    }

    let entryCreated = false;
    let localPathWritten = false;
    // Never remove or restore a file that changed after this command wrote it.
    const rollback = (): string[] => {
      const errors: string[] = [];
      if (entryCreated && existsSync(entryPath)) {
        try {
          if (readFileSync(entryPath, "utf8") !== entryText) {
            errors.push("new entry changed during rollback and was not removed");
          } else {
            unlinkSync(entryPath);
          }
        } catch (error) {
          errors.push(`could not remove new entry: ${errorMessage(error)}`);
        }
      }
      if (localPathWritten && existsSync(localPathFile)) {
        try {
          if (readFileSync(localPathFile, "utf8") !== localPathText) {
            errors.push(`${LOCAL_PATHS} changed during rollback and was not restored`);
          } else if (previousLocalPathText === null) {
            unlinkSync(localPathFile);
          } else {
            writeFileSync(localPathFile, previousLocalPathText, "utf8");
          }
        } catch (error) {
          errors.push(`could not restore ${LOCAL_PATHS}: ${errorMessage(error)}`);
        }
      }
      return errors;
    };

    try {
      writeFileSync(entryPath, entryText, { encoding: "utf8", flag: "wx" });
      entryCreated = true;
      if (localPathText !== null) {
        mkdirSync(dirname(localPathFile), { recursive: true });
        writeFileSync(localPathFile, localPathText, "utf8");
        localPathWritten = true;
      }
    } catch (error) {
      return { status: "failed", path, errors: [`could not write entry: ${errorMessage(error)}`, ...rollback()] };
    }
    return { status: "created", path, rollback };
  }
}
