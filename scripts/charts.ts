#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";

import { CatalogIndex, type Snapshot } from "../src/domain/catalog.ts";
import {
  dependenciesFor as domainDependenciesFor,
  reverseDependencies as domainReverseDependencies,
  showEntry as domainShowEntry,
} from "../src/domain/dependencies.ts";
import {
  compact,
  ENTRY_DIRS,
  entryFile,
  entryJson,
  entryName,
  entryStatus,
  errorMessage,
  FIELD_ORDER,
  ID_PATTERN,
  isRecord,
  isString,
  STATUSES,
  type Data,
  type Entry,
  type Finding,
  type Kind,
} from "../src/domain/entry.ts";
import {
  localPathTargets,
  validateCatalog as domainValidateCatalog,
  validateEntryData,
  validationMaps,
  type LocalPathFact,
} from "../src/domain/validation.ts";

type Options = {
  command: "find" | "show" | "deps" | "rdeps" | "check" | "add";
  json: boolean;
  text?: string;
  id?: string;
  kind?: Kind;
  data?: Data;
  localPath?: string;
  system?: string;
  tag?: string;
  status?: string;
  owner?: string;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadSnapshot(root: string): Snapshot {
  const snapshot: Snapshot = {
    entries: [],
    tags: {},
    tagsExists: existsSync(join(root, "tags.toml")),
    localPaths: null,
    localPathsExists: existsSync(join(root, "local/paths.toml")),
    loadErrors: [],
  };
  const readToml = (path: string, label: string): Data | null => {
    try {
      const value: unknown = parseToml(readFileSync(path, "utf8"));
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
    const folder = join(root, directory);
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
      const data = readToml(join(folder, file), label);
      if (data) snapshot.entries.push({ kind, id: file.slice(0, -5), data, file: label });
    }
  }
  if (snapshot.tagsExists) Object.assign(snapshot.tags, readToml(join(root, "tags.toml"), "tags.toml") ?? {});
  if (snapshot.localPathsExists) snapshot.localPaths = readToml(join(root, "local/paths.toml"), "local/paths.toml");
  return snapshot;
}

export class Catalog extends CatalogIndex {
  readonly root: string;

  constructor(root: string) {
    const resolved = resolve(root);
    super(loadSnapshot(resolved));
    this.root = resolved;
  }
}

function resolveLocalPath(root: string, rawPath: string): string {
  if (rawPath === "~") return homedir();
  if (rawPath.startsWith("~/")) return resolve(homedir(), rawPath.slice(2));
  return isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
}

function gitOutput(path: string, ...args: string[]): string | null {
  const result = spawnSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    timeout: 5000,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitRemotes(path: string): Set<string> {
  const output = gitOutput(path, "remote", "-v");
  if (!output) return new Set();
  const remotes = new Set<string>();
  for (const line of output.split("\n")) {
    const match = line.match(/^\S+\s+(\S+)\s+\(/);
    if (match) remotes.add(match[1]);
  }
  return remotes;
}

function localPathError(path: string, remote?: unknown): string | null {
  if (!existsSync(path)) return `path does not exist: ${path}`;
  try {
    if (!statSync(path).isDirectory()) return `not a Git repository root: ${path}`;
  } catch {
    return `cannot read local path: ${path}`;
  }
  const gitRoot = gitOutput(path, "rev-parse", "--show-toplevel");
  try {
    if (!gitRoot || realpathSync(gitRoot) !== realpathSync(path)) return `not a Git repository root: ${path}`;
  } catch {
    return `not a Git repository root: ${path}`;
  }
  if (isString(remote) && !gitRemotes(path).has(remote)) return `remote does not match ${JSON.stringify(remote)}`;
  return null;
}

function inspectLocalPath(root: string, rawPath: string, remote: unknown): LocalPathFact {
  const resolved = resolveLocalPath(root, rawPath);
  return { resolved, error: localPathError(resolved, remote) };
}

function localPathFacts(catalog: Catalog, only?: string): Map<string, LocalPathFact> {
  const facts = new Map<string, LocalPathFact>();
  for (const target of localPathTargets(catalog.snapshot)) {
    if (only === undefined || target.id === only) {
      facts.set(target.id, inspectLocalPath(catalog.root, target.rawPath, target.remote));
    }
  }
  return facts;
}

function gitIgnored(root: string, relativePath: string): { ignored: boolean } | { error: string } {
  const ignored = spawnSync("git", ["check-ignore", "-q", relativePath], {
    cwd: root,
    encoding: "utf8",
  });
  if (ignored.error) return { error: ignored.error.message };
  return { ignored: ignored.status === 0 };
}

export function showEntry(catalog: Catalog, entry: Entry): Data {
  return domainShowEntry(catalog, entry, localPathFacts(catalog, entry.id));
}

export function dependenciesFor(catalog: Catalog, entry: Entry): Data {
  return domainDependenciesFor(catalog, entry);
}

export function reverseDependencies(catalog: Catalog, entry: Entry): Data {
  return domainReverseDependencies(catalog, entry);
}

export function validateCatalog(catalog: Catalog): Finding {
  return domainValidateCatalog(catalog.snapshot, {
    localPaths: localPathFacts(catalog),
    localPathsIgnored: gitIgnored(catalog.root, "local/paths.toml"),
  });
}

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

function renderEntry(root: string, kind: Kind, data: Data): string {
  const templatePath = join(root, "templates", `${kind}.toml`);
  const templateValue: unknown = parseToml(readFileSync(templatePath, "utf8"));
  if (!isRecord(templateValue)) throw new Error(`templates/${kind}.toml must contain a TOML table`);
  // Use the template's field order, but never copy its sample values.
  const order = [...new Set([...Object.keys(templateValue), ...FIELD_ORDER[kind]])];
  return tomlTable(data, order);
}

function printAddResult(
  json: boolean,
  result: { ok: boolean; type: Kind; id: string; path: string; validation: Finding },
): void {
  if (json) {
    printJson({
      ok: result.ok,
      type: result.type,
      id: result.id,
      path: result.path,
      validation: { ok: result.validation.errors.length === 0, ...result.validation },
    });
    return;
  }
  for (const warning of result.validation.warnings) console.log(`WARNING: ${warning}`);
  for (const error of result.validation.errors) console.error(`ERROR: ${error}`);
  if (result.ok) console.log(`Created ${result.type} ${result.id} at ${result.path}; validation ok`);
  else console.error(`Could not add ${result.type} ${result.id} at ${result.path}; validation failed`);
}

function rollbackAdd(
  entryPath: string,
  entryText: string,
  entryCreated: boolean,
  localPathFile: string,
  localPathText: string | null,
  localPathWritten: boolean,
  previousLocalPathText: string | null,
): string[] {
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
        errors.push("local/paths.toml changed during rollback and was not restored");
      } else if (previousLocalPathText === null) {
        unlinkSync(localPathFile);
      } else {
        writeFileSync(localPathFile, previousLocalPathText, "utf8");
      }
    } catch (error) {
      errors.push(`could not restore local/paths.toml: ${errorMessage(error)}`);
    }
  }
  return errors;
}

function addEntry(catalog: Catalog, options: Options): number {
  const kind = options.kind!;
  const id = options.id!;
  const data = options.data!;
  const relativeEntryPath = entryFile(kind, id);
  const entryPath = join(catalog.root, relativeEntryPath);
  const localPathFile = join(catalog.root, "local/paths.toml");
  const failure = (errors: string[], status = 2, warnings: string[] = []): number => {
    printAddResult(options.json, {
      ok: false,
      type: kind,
      id,
      path: relativeEntryPath,
      validation: { errors, warnings },
    });
    return status;
  };

  const duplicatePaths = ENTRY_DIRS
    .map(([, directory]) => join(catalog.root, directory, `${id}.toml`))
    .filter((path) => existsSync(path));
  if (catalog.entries.some((entry) => entry.id === id) || duplicatePaths.length) {
    return failure([`ID ${JSON.stringify(id)} already exists`]);
  }

  const ignored = gitIgnored(catalog.root, relativeEntryPath);
  if ("error" in ignored) return failure([`could not check Git ignore rule: ${ignored.error}`]);
  if (!ignored.ignored) return failure([`${relativeEntryPath} is not ignored by Git`]);

  const candidate: Entry = { kind, id, data, file: relativeEntryPath };
  const maps = validationMaps(catalog);
  const inputFinding = validateEntryData(catalog, candidate, maps.seen, maps.keys);
  if (inputFinding.errors.length) return failure(inputFinding.errors, 2, inputFinding.warnings);

  let entryText: string;
  try {
    entryText = renderEntry(catalog.root, kind, data);
  } catch (error) {
    return failure([`cannot create entry from template: ${errorMessage(error)}`]);
  }

  let previousLocalPathText: string | null = null;
  let localPathText: string | null = null;
  if (options.localPath !== undefined) {
    try {
      if (existsSync(localPathFile)) {
        previousLocalPathText = readFileSync(localPathFile, "utf8");
        const parsed: unknown = parseToml(previousLocalPathText);
        if (!isRecord(parsed)) return failure(["local/paths.toml must contain a TOML table"]);
        localPathText = tomlTable({ ...parsed, [id]: options.localPath });
      } else {
        localPathText = tomlTable({ [id]: options.localPath });
      }
    } catch (error) {
      return failure([`cannot update local/paths.toml: ${errorMessage(error)}`]);
    }
  }

  let entryCreated = false;
  let localPathWritten = false;
  try {
    writeFileSync(entryPath, entryText, { encoding: "utf8", flag: "wx" });
    entryCreated = true;
    if (localPathText !== null) {
      mkdirSync(dirname(localPathFile), { recursive: true });
      writeFileSync(localPathFile, localPathText, "utf8");
      localPathWritten = true;
    }
  } catch (error) {
    const rollbackErrors = rollbackAdd(
      entryPath,
      entryText,
      entryCreated,
      localPathFile,
      localPathText,
      localPathWritten,
      previousLocalPathText,
    );
    return failure([`could not write entry: ${errorMessage(error)}`, ...rollbackErrors], 1);
  }

  let validation: Finding;
  try {
    validation = validateCatalog(new Catalog(catalog.root));
  } catch (error) {
    const rollbackErrors = rollbackAdd(
      entryPath,
      entryText,
      entryCreated,
      localPathFile,
      localPathText,
      localPathWritten,
      previousLocalPathText,
    );
    return failure([`catalog validation failed: ${errorMessage(error)}`, ...rollbackErrors], 1);
  }
  if (validation.errors.length) {
    const rollbackErrors = rollbackAdd(
      entryPath,
      entryText,
      entryCreated,
      localPathFile,
      localPathText,
      localPathWritten,
      previousLocalPathText,
    );
    return failure([...validation.errors, ...rollbackErrors], 1, validation.warnings);
  }

  printAddResult(options.json, {
    ok: true,
    type: kind,
    id,
    path: relativeEntryPath,
    validation,
  });
  return 0;
}

function parseArgs(argv: string[]): Options {
  const [command, ...rest] = argv;
  if (!["find", "show", "deps", "rdeps", "check", "add"].includes(command)) {
    throw new Error("usage: charts <find|show|deps|rdeps|check|add> [arguments] [--json]");
  }
  const options: Options = { command: command as Options["command"], json: false };
  const positional: string[] = [];

  if (command === "add") {
    let dataText: string | undefined;
    let localPathSet = false;
    for (let index = 0; index < rest.length; index += 1) {
      const argument = rest[index];
      if (argument === "--json") {
        options.json = true;
        continue;
      }
      if (argument === "--data" || argument === "--local-path") {
        const value = rest[index + 1];
        if (value === undefined) throw new Error(`${argument} requires a value`);
        index += 1;
        if (argument === "--data") {
          if (dataText !== undefined) throw new Error("--data can be used only once");
          dataText = value;
        } else {
          if (localPathSet) throw new Error("--local-path can be used only once");
          localPathSet = true;
          options.localPath = value;
        }
        continue;
      }
      if (argument.startsWith("--")) throw new Error(`unknown option: ${argument}`);
      positional.push(argument);
    }
    if (positional.length !== 2) throw new Error("add requires an entry type and ID");
    const kind = positional[0];
    if (!ENTRY_DIRS.some(([entryKind]) => entryKind === kind)) {
      throw new Error(`invalid entry type: ${kind}`);
    }
    options.kind = kind as Kind;
    options.id = positional[1];
    if (!ID_PATTERN.test(options.id)) throw new Error(`invalid ID ${JSON.stringify(options.id)}; use lowercase kebab-case`);
    if (dataText === undefined) throw new Error("add requires --data '<JSON>'");
    if (options.localPath !== undefined && options.kind !== "repository") {
      throw new Error("--local-path is valid only for repository entries");
    }
    if (options.localPath === "") throw new Error("--local-path must not be empty");
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataText);
    } catch (error) {
      throw new Error(`--data is not valid JSON: ${errorMessage(error)}`);
    }
    if (!isRecord(parsed)) throw new Error("--data must be a JSON object");
    if ("id" in parsed) throw new Error("do not include id in --data; pass it as the positional ID");
    options.data = parsed;
    return options;
  }

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument.startsWith("--")) {
      if (command !== "find" || !["--system", "--tag", "--status", "--owner"].includes(argument)) {
        throw new Error(`unknown option: ${argument}`);
      }
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--system") options.system = value;
      if (argument === "--tag") options.tag = value;
      if (argument === "--status") options.status = value;
      if (argument === "--owner") options.owner = value;
      continue;
    }
    positional.push(argument);
  }

  if (command === "find") {
    if (positional.length > 1) throw new Error("find accepts at most one text value");
    options.text = positional[0];
    if (options.status && !STATUSES.has(options.status)) throw new Error(`invalid status filter: ${options.status}`);
  } else if (command === "check") {
    if (positional.length) throw new Error("check accepts no positional arguments");
  } else {
    if (positional.length !== 1) throw new Error(`${command} requires one entry ID`);
    options.id = positional[0];
  }
  return options;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printFind(entries: Entry[]): void {
  for (const entry of entries) {
    console.log(`${entry.kind} ${entry.id} — ${compact(entryName(entry))} — ${compact(entry.data.description ?? "")}`);
  }
}

function printShow(data: Data): void {
  const fields = [`${data.type} ${data.id}`];
  for (const key of [
    "name",
    "description",
    "key",
    "system",
    "status",
    "owner",
    "tags",
    "provider",
    "kind",
    "remote",
    "default-branch",
    "depends-on",
    "local_path",
    "local_path_status",
  ]) {
    if (key in data && data[key] !== null) fields.push(`${key}=${compact(data[key])}`);
  }
  console.log(fields.join(" — "));
}

function printEdges(result: Data, reverse = false): void {
  const key = reverse ? "dependents" : "dependencies";
  const edges = result[key] as Data[];
  const systemDependencies = (result.system_dependencies as Data[] | undefined) ?? [];
  if (!edges.length && !systemDependencies.length) {
    console.log(`${result.id}: no ${key}`);
    return;
  }
  for (const edge of edges) {
    const via = edge.via ? ` via ${compact(edge.via)}` : "";
    const source = edge.from ? ` from ${compact(edge.from)}` : "";
    const viaRepositories = Array.isArray(edge.via_repositories)
      ? ` via repositories ${(edge.via_repositories as string[]).join(", ")}`
      : "";
    const arrow = reverse ? "<-" : "->";
    console.log(`${result.id} ${arrow} ${edge.type} ${edge.id}${via}${source}${viaRepositories}`);
  }
  if (!reverse) {
    for (const edge of systemDependencies) {
      const repositories = (edge.via_repositories as string[]).join(", ");
      console.log(`${result.id} -> system ${edge.id} via repositories ${repositories}`);
    }
  }
}

export function main(argv = process.argv.slice(2), root = ROOT): number {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    const message = errorMessage(error);
    if (argv[0] === "add" && argv.includes("--json")) printJson({ ok: false, error: message });
    else console.error(message);
    return 2;
  }
  const catalog = new Catalog(root);

  if (options.command === "add") return addEntry(catalog, options);

  if (options.command === "check") {
    const result = validateCatalog(catalog);
    if (options.json) {
      printJson({ ok: result.errors.length === 0, ...result });
    } else {
      for (const warning of result.warnings) console.log(`WARNING: ${warning}`);
      for (const error of result.errors) console.log(`ERROR: ${error}`);
      if (!result.errors.length) console.log("check: ok");
    }
    return result.errors.length ? 1 : 0;
  }

  if (options.command === "find") {
    const text = (options.text ?? "").toLowerCase();
    const entries = catalog.entries
      .filter((entry) => !text || compact(entryJson(entry)).toLowerCase().includes(text))
      .filter((entry) => {
        if (!options.system) return true;
        return entry.kind === "system" ? entry.id === options.system : entry.data.system === options.system;
      })
      .filter((entry) => {
        if (!options.tag) return true;
        return entry.kind === "repository" && Array.isArray(entry.data.tags) && entry.data.tags.includes(options.tag);
      })
      .filter((entry) => !options.status || (entry.kind !== "external" && entryStatus(entry) === options.status))
      .filter((entry) => !options.owner || (isString(entry.data.owner) && entry.data.owner.toLowerCase().includes(options.owner!.toLowerCase())))
      .sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
    if (options.json) printJson({ entries: entries.map(entryJson) });
    else printFind(entries);
    return 0;
  }

  const entry = catalog.get(options.id!);
  if (!entry) {
    const message = `unknown entry ID: ${options.id}`;
    if (options.json) printJson({ error: message });
    else console.error(message);
    return 2;
  }
  if (options.command === "show") {
    const result = showEntry(catalog, entry);
    if (options.json) printJson(result);
    else printShow(result);
    return 0;
  }
  if (options.command === "deps" && entry.kind === "external") {
    const message = `deps supports repositories and systems, not external entries: ${entry.id}`;
    if (options.json) printJson({ error: message });
    else console.error(message);
    return 2;
  }

  const result = options.command === "deps"
    ? dependenciesFor(catalog, entry)
    : reverseDependencies(catalog, entry);
  if (options.json) printJson(result);
  else printEdges(result, options.command === "rdeps");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
