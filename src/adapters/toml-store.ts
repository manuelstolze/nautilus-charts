import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
  localPathReplacementWarning,
  type Data,
  type Kind,
} from "../domain/entry.ts";
import type { CatalogStore } from "../commands/ports.ts";
import type { NewTag } from "../domain/validation.ts";
import { appendTomlLines, setTomlFields, tomlKey, tomlValue, upsertSingleLineMapping } from "./toml-lines.ts";

function localPathUpdateError(id: string, reason: "unsafe-mapping" | "table-section"): string {
  if (reason === "unsafe-mapping") {
    return `the local paths: cannot replace the existing local path for ${JSON.stringify(id)}; edit the file by hand`;
  }
  return `the local paths: cannot safely update the local path for ${JSON.stringify(id)} while it contains a table section; edit the file by hand`;
}

function ioErrorReason(error: unknown): string {
  const message = errorMessage(error);
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") return message;
  const prefix = `${error.code}: `;
  return (message.startsWith(prefix) ? message.slice(prefix.length) : message).split(", ")[0];
}

function tomlTable(data: Data, order: string[] = Object.keys(data)): string {
  return order
    .filter((key) => Object.prototype.hasOwnProperty.call(data, key))
    .map((key) => `${tomlKey(key)} = ${tomlValue(data[key])}`)
    .join("\n") + "\n";
}

function replaceTextFile(path: string, text: string): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : undefined;
  try {
    writeFileSync(temporaryPath, text, {
      encoding: "utf8",
      flag: "wx",
      ...(mode === undefined ? {} : { mode }),
    });
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

type SidecarUpdate = {
  label: string;
  path: string;
  previousText: string | null;
  nextText: string;
  atomic: boolean;
  written: boolean;
};
type PreparedSidecars =
  | { updates: SidecarUpdate[]; warnings: string[] }
  | { errors: string[] };

/** The catalog store on disk: TOML files under the catalog root. */
export class TomlStore implements CatalogStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private prepareSidecars(id: string, localPath?: string, newTags: readonly NewTag[] = []): PreparedSidecars {
    const updates: SidecarUpdate[] = [];
    const warnings: string[] = [];
    const localPathFile = join(this.root, LOCAL_PATHS);

    if (localPath !== undefined) {
      let previousText: string | null;
      try {
        previousText = existsSync(localPathFile) ? readFileSync(localPathFile, "utf8") : null;
      } catch (error) {
        return { errors: [`cannot update the local paths: ${ioErrorReason(error)}`] };
      }
      let nextText: string;
      let replaced = false;
      if (previousText === null) {
        nextText = appendTomlLines("", [`${tomlKey(id)} = ${JSON.stringify(localPath)}`]);
      } else {
        const update = upsertSingleLineMapping(previousText, id, `${tomlKey(id)} = ${JSON.stringify(localPath)}`);
        if ("error" in update) return { errors: [localPathUpdateError(id, update.error)] };
        let parsed: unknown;
        try {
          parsed = parseToml(previousText);
        } catch (error) {
          return { errors: [`cannot update the local paths: ${ioErrorReason(error)}`] };
        }
        if (!isRecord(parsed)) return { errors: ["the local paths must contain a TOML table"] };
        if (Object.hasOwn(parsed, id) && parsed[id] === localPath) nextText = previousText;
        else {
          nextText = update.text;
          replaced = update.replaced;
        }
      }
      if (nextText !== previousText) {
        updates.push({ label: "the local paths", path: localPathFile, previousText, nextText, atomic: false, written: false });
        if (replaced) warnings.push(localPathReplacementWarning(id));
      }
    }

    if (newTags.length > 0) {
      const tagsFile = join(this.root, "tags.toml");
      let previousText: string | null;
      try {
        previousText = existsSync(tagsFile) ? readFileSync(tagsFile, "utf8") : null;
      } catch (error) {
        return { errors: [`cannot update the tag list: ${ioErrorReason(error)}`] };
      }
      const existingText = previousText ?? "";
      const appended = newTags.map(({ name, description }) => `${name} = ${JSON.stringify(description)}`);
      updates.push({
        label: "the tag list",
        path: tagsFile,
        previousText,
        nextText: appendTomlLines(existingText, appended),
        atomic: true,
        written: false,
      });
    }
    return { updates, warnings };
  }

  private writeSidecars(updates: SidecarUpdate[]): string[] {
    for (const update of updates) {
      try {
        if (update.atomic) replaceTextFile(update.path, update.nextText);
        else {
          mkdirSync(dirname(update.path), { recursive: true });
          writeFileSync(update.path, update.nextText, "utf8");
        }
        update.written = true;
      } catch (error) {
        return [`could not write ${update.label}: ${ioErrorReason(error)}`];
      }
    }
    return [];
  }

  private rollbackSidecars(updates: SidecarUpdate[]): string[] {
    const errors: string[] = [];
    for (const update of [...updates].reverse()) {
      if (!update.written) continue;
      try {
        if (!existsSync(update.path) || readFileSync(update.path, "utf8") !== update.nextText) {
          errors.push(`${update.label} changed during rollback and could not be restored`);
        } else if (update.previousText === null) unlinkSync(update.path);
        else if (update.atomic) replaceTextFile(update.path, update.previousText);
        else writeFileSync(update.path, update.previousText, "utf8");
      } catch (error) {
        errors.push(`could not restore ${update.label}: ${ioErrorReason(error)}`);
      }
    }
    return errors;
  }

  private templateOrder(kind: Kind): string[] {
    let text: string;
    try {
      text = readFileSync(join(this.root, "templates", `${kind}.toml`), "utf8");
    } catch (error) {
      throw new Error(ioErrorReason(error));
    }
    const templateValue: unknown = parseToml(text);
    if (!isRecord(templateValue)) throw new Error(`the ${kind} template must contain a TOML table`);
    return [...new Set([...Object.keys(templateValue), ...FIELD_ORDER[kind]])];
  }

  load(): Snapshot {
    const snapshot: Snapshot = {
      entries: [],
      // No prototype, so the tags table holds only names that tags.toml defines.
      tags: Object.create(null) as Data,
      tagsExists: existsSync(join(this.root, "tags.toml")),
      localPaths: null,
      localPathsExists: existsSync(join(this.root, LOCAL_PATHS)),
      loadErrors: [],
    };
    const readToml = (path: string, label: string): Data | null => {
      try {
        const value: unknown = parseToml(readFileSync(join(this.root, path), "utf8"));
        if (!isRecord(value)) {
          snapshot.loadErrors.push(`${label}: expected a TOML table`);
          return null;
        }
        return value;
      } catch (error) {
        snapshot.loadErrors.push(`${label}: invalid TOML: ${ioErrorReason(error)}`);
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
        snapshot.loadErrors.push(`cannot read ${kind} entries: ${ioErrorReason(error)}`);
        continue;
      }
      for (const file of files) {
        const path = `${directory}/${file}`;
        const id = file.slice(0, -5);
        const data = readToml(path, `${kind} ${id}`);
        if (data) snapshot.entries.push({ kind, id, data, file: path });
      }
    }
    // Assign, not copy: copying into an object runs the __proto__ setter.
    if (snapshot.tagsExists) snapshot.tags = readToml("tags.toml", "the tag list") ?? snapshot.tags;
    if (snapshot.localPathsExists) snapshot.localPaths = readToml(LOCAL_PATHS, "the local paths");
    return snapshot;
  }

  entryFileExists(id: string): boolean {
    return ENTRY_DIRS.some(([, directory]) => existsSync(join(this.root, directory, `${id}.toml`)));
  }

  private renderEntry(kind: Kind, data: Data): string {
    // Use the template's field order, but never copy its sample values.
    return tomlTable(data, this.templateOrder(kind));
  }

  createEntry(
    kind: Kind,
    id: string,
    data: Data,
    localPath?: string,
    newTags: readonly NewTag[] = [],
  ): ReturnType<CatalogStore["createEntry"]> {
    const path = entryFile(kind, id);
    const entryPath = join(this.root, path);
    const invalid = (errors: string[]) => ({ status: "invalid" as const, path, errors });

    let entryText: string;
    try {
      entryText = this.renderEntry(kind, data);
    } catch (error) {
      return invalid([`cannot create entry from template: ${errorMessage(error)}`]);
    }

    const prepared = this.prepareSidecars(id, localPath, newTags);
    if ("errors" in prepared) return invalid(prepared.errors);
    const { updates, warnings } = prepared;

    let entryCreated = false;
    const rollback = (): string[] => {
      const errors = this.rollbackSidecars(updates);
      if (entryCreated && existsSync(entryPath)) {
        try {
          if (readFileSync(entryPath, "utf8") !== entryText) {
            errors.push(`${kind} ${id} changed during rollback and was not removed`);
          } else unlinkSync(entryPath);
        } catch (error) {
          errors.push(`could not remove new ${kind} ${id}: ${ioErrorReason(error)}`);
        }
      }
      return errors;
    };

    try {
      writeFileSync(entryPath, entryText, { encoding: "utf8", flag: "wx" });
      entryCreated = true;
    } catch (error) {
      return { status: "failed", path, errors: [`could not write ${kind} ${id}: ${ioErrorReason(error)}`] };
    }
    const sidecarErrors = this.writeSidecars(updates);
    if (sidecarErrors.length) return { status: "failed", path, errors: [...sidecarErrors, ...rollback()] };
    return { status: "created", path, warnings, rollback };
  }

  updateEntry(
    kind: Kind,
    id: string,
    data: Data,
    changedFields: readonly string[],
    localPath?: string,
    newTags: readonly NewTag[] = [],
  ): ReturnType<CatalogStore["updateEntry"]> {
    const path = entryFile(kind, id);
    const entryPath = join(this.root, path);
    const invalid = (errors: string[]) => ({ status: "invalid" as const, path, errors });

    let previousEntryText: string;
    try {
      previousEntryText = readFileSync(entryPath, "utf8");
    } catch (error) {
      return invalid([`cannot read ${kind} ${id}: ${ioErrorReason(error)}`]);
    }

    let order: string[];
    try {
      order = this.templateOrder(kind);
    } catch (error) {
      return invalid([`cannot read template for ${kind}: ${ioErrorReason(error)}`]);
    }
    const fields: Data = Object.create(null) as Data;
    for (const field of changedFields) {
      if (Object.hasOwn(data, field)) Object.defineProperty(fields, field, { value: data[field], enumerable: true, writable: true });
    }
    const updated = changedFields.length === 0
      ? { text: previousEntryText }
      : setTomlFields(previousEntryText, fields, order);
    if ("error" in updated) {
      const reasons = {
        "duplicate-field": "a field appears more than once",
        "dotted-key": "a field uses a dotted key",
        "table-section": "the file contains a table section",
        "unsafe-value": "a field value cannot be read or rendered safely",
      };
      return invalid([`${kind} ${id}: cannot safely update fields: ${reasons[updated.error]}; edit the entry by hand`]);
    }

    const prepared = this.prepareSidecars(id, localPath, newTags);
    if ("errors" in prepared) return invalid(prepared.errors);
    const { updates, warnings } = prepared;
    let entryWritten = false;
    const rollback = (): string[] => {
      const errors: string[] = [];
      if (entryWritten) {
        try {
          if (!existsSync(entryPath) || readFileSync(entryPath, "utf8") !== updated.text) {
            errors.push(`${kind} ${id} changed during rollback and was not restored`);
          } else replaceTextFile(entryPath, previousEntryText);
        } catch (error) {
          errors.push(`could not restore ${kind} ${id}: ${ioErrorReason(error)}`);
        }
      }
      errors.push(...this.rollbackSidecars(updates));
      return errors;
    };

    if (updated.text !== previousEntryText) {
      try {
        replaceTextFile(entryPath, updated.text);
        entryWritten = true;
      } catch (error) {
        return { status: "failed", path, errors: [`could not write ${kind} ${id}: ${ioErrorReason(error)}`] };
      }
    }
    const sidecarErrors = this.writeSidecars(updates);
    if (sidecarErrors.length) return { status: "failed", path, errors: [...sidecarErrors, ...rollback()] };
    return { status: "updated", path, warnings, rollback };
  }
}
