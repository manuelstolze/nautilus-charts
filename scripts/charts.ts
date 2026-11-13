#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GitCli } from "../src/adapters/git-cli.ts";
import { TomlStore } from "../src/adapters/toml-store.ts";
import { CatalogIndex } from "../src/domain/catalog.ts";
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

export class Catalog extends CatalogIndex {
  readonly root: string;
  readonly store: TomlStore;
  readonly git: GitCli;

  constructor(root: string) {
    const store = new TomlStore(root);
    super(store.load());
    this.root = store.root;
    this.store = store;
    this.git = new GitCli(store.root);
  }
}

function localPathFacts(catalog: Catalog, only?: string): Map<string, LocalPathFact> {
  const facts = new Map<string, LocalPathFact>();
  for (const target of localPathTargets(catalog.snapshot)) {
    if (only === undefined || target.id === only) {
      facts.set(target.id, catalog.git.inspectLocalPath(target.rawPath, target.remote));
    }
  }
  return facts;
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
    localPathsIgnored: catalog.git.isIgnored("local/paths.toml"),
  });
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

function addEntry(catalog: Catalog, options: Options): number {
  const kind = options.kind!;
  const id = options.id!;
  const data = options.data!;
  const relativeEntryPath = entryFile(kind, id);
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

  if (catalog.entries.some((entry) => entry.id === id) || catalog.store.entryFileExists(id)) {
    return failure([`ID ${JSON.stringify(id)} already exists`]);
  }

  const ignored = catalog.git.isIgnored(relativeEntryPath);
  if ("error" in ignored) return failure([`could not check Git ignore rule: ${ignored.error}`]);
  if (!ignored.ignored) return failure([`${relativeEntryPath} is not ignored by Git`]);

  const candidate: Entry = { kind, id, data, file: relativeEntryPath };
  const maps = validationMaps(catalog);
  const inputFinding = validateEntryData(catalog, candidate, maps.seen, maps.keys);
  if (inputFinding.errors.length) return failure(inputFinding.errors, 2, inputFinding.warnings);

  const created = catalog.store.createEntry(kind, id, data, options.localPath);
  if (created.status === "invalid") return failure(created.errors);
  if (created.status === "failed") return failure(created.errors, 1);

  let validation: Finding;
  try {
    validation = validateCatalog(new Catalog(catalog.root));
  } catch (error) {
    return failure([`catalog validation failed: ${errorMessage(error)}`, ...created.rollback()], 1);
  }
  if (validation.errors.length) {
    return failure([...validation.errors, ...created.rollback()], 1, validation.warnings);
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
