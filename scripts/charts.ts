#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";

type Kind = "system" | "repository" | "external";
type Data = Record<string, unknown>;
type Dependency = { id: string; via?: unknown; [key: string]: unknown };
type Entry = { kind: Kind; id: string; data: Data; path: string };
type Finding = { errors: string[]; warnings: string[] };
type Options = {
  command: "find" | "show" | "deps" | "rdeps" | "check";
  json: boolean;
  text?: string;
  id?: string;
  system?: string;
  tag?: string;
  status?: string;
  owner?: string;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,4}$/;
const ENTRY_DIRS: Array<[Kind, string]> = [
  ["system", "systems"],
  ["repository", "repositories"],
  ["external", "externals"],
];
const STATUSES = new Set(["planned", "active", "deprecated", "archived"]);
const FIELDS: Record<Kind, Set<string>> = {
  system: new Set(["name", "description", "owner", "status"]),
  repository: new Set([
    "name",
    "description",
    "key",
    "system",
    "status",
    "owner",
    "tags",
    "remote",
    "default-branch",
    "depends-on",
  ]),
  external: new Set(["name", "description", "provider", "kind", "status"]),
};

function isRecord(value: unknown): value is Data {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function entryName(entry: Entry): string {
  return isString(entry.data.name) ? entry.data.name : entry.id;
}

function entryStatus(entry: Entry): unknown {
  return entry.data.status ?? "active";
}

function compact(value: unknown): string {
  if (Array.isArray(value)) return value.map(compact).join(", ");
  if (isRecord(value)) return Object.entries(value).map(([key, item]) => `${key}=${compact(item)}`).join(", ");
  return String(value).replace(/\s+/g, " ").trim();
}

function entryJson(entry: Entry): Data {
  return { ...entry.data, type: entry.kind, id: entry.id, name: entryName(entry) };
}

function validDependencies(value: unknown): Dependency[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Dependency => isRecord(item) && isString(item.id));
}

export class Catalog {
  readonly root: string;
  readonly entries: Entry[] = [];
  readonly loadErrors: string[] = [];
  readonly tags: Data = {};
  localPaths: Data | null = null;
  readonly localPathsExists: boolean;
  readonly byId = new Map<string, Entry>();

  constructor(root: string) {
    this.root = resolve(root);
    this.localPathsExists = existsSync(join(this.root, "local/paths.toml"));
    this.load();
    for (const entry of this.entries) {
      if (!this.byId.has(entry.id)) this.byId.set(entry.id, entry);
    }
  }

  private readToml(path: string, label: string): Data | null {
    try {
      const value: unknown = parseToml(readFileSync(path, "utf8"));
      if (!isRecord(value)) {
        this.loadErrors.push(`${label}: expected a TOML table`);
        return null;
      }
      return value;
    } catch (error) {
      this.loadErrors.push(`${label}: invalid TOML: ${errorMessage(error)}`);
      return null;
    }
  }

  private load(): void {
    for (const [kind, directory] of ENTRY_DIRS) {
      const folder = join(this.root, directory);
      if (!existsSync(folder)) continue;
      let files: string[];
      try {
        files = readdirSync(folder).filter((file) => file.endsWith(".toml")).sort();
      } catch (error) {
        this.loadErrors.push(`${directory}: cannot read entries: ${errorMessage(error)}`);
        continue;
      }
      for (const file of files) {
        const path = join(folder, file);
        const data = this.readToml(path, relative(this.root, path));
        if (data) this.entries.push({ kind, id: file.slice(0, -5), data, path });
      }
    }

    const tagsPath = join(this.root, "tags.toml");
    if (existsSync(tagsPath)) Object.assign(this.tags, this.readToml(tagsPath, "tags.toml") ?? {});

    const localPath = join(this.root, "local/paths.toml");
    if (this.localPathsExists) this.localPaths = this.readToml(localPath, "local/paths.toml");
  }

  entriesFor(kind: Kind): Entry[] {
    return this.entries.filter((entry) => entry.kind === kind);
  }

  get(id: string): Entry | undefined {
    return this.byId.get(id);
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

function remoteHasCredentials(remote: string): boolean {
  if (!remote.includes("://")) return false;
  try {
    const url = new URL(remote);
    if (url.password || ((url.protocol === "http:" || url.protocol === "https:") && url.username)) return true;
    const sensitive = ["token", "password", "secret", "credential", "api_key", "apikey", "auth"];
    for (const key of url.searchParams.keys()) {
      if (sensitive.some((word) => key.toLowerCase().includes(word))) return true;
    }
  } catch {
    return false;
  }
  return false;
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

export function showEntry(catalog: Catalog, entry: Entry): Data {
  const result = entryJson(entry);
  if (entry.kind !== "repository") return result;
  const configured = catalog.localPaths?.[entry.id];
  if (!isString(configured)) {
    return { ...result, local_path: null, local_path_status: "not configured" };
  }
  const path = resolveLocalPath(catalog.root, configured);
  const error = localPathError(path, entry.data.remote);
  return {
    ...result,
    local_path: error ? null : path,
    local_path_status: error ?? "ok",
  };
}

function repositoryDependencies(catalog: Catalog, repository: Entry): Data[] {
  const result: Data[] = [];
  for (const dependency of validDependencies(repository.data["depends-on"])) {
    const target = catalog.get(dependency.id);
    const item: Data = { id: dependency.id, type: target?.kind ?? "unknown" };
    if (target) item.name = entryName(target);
    if ("via" in dependency) item.via = dependency.via;
    result.push(item);
  }
  return result;
}

export function dependenciesFor(catalog: Catalog, entry: Entry): Data {
  if (entry.kind === "repository") {
    return { id: entry.id, type: entry.kind, dependencies: repositoryDependencies(catalog, entry) };
  }
  const members = catalog.entriesFor("repository")
    .filter((repository) => repository.data.system === entry.id)
    .sort((left, right) => left.id.localeCompare(right.id));
  const dependencies: Data[] = [];
  for (const repository of members) {
    for (const dependency of repositoryDependencies(catalog, repository)) {
      dependencies.push({ ...dependency, from: repository.id });
    }
  }

  const systemDependencies: Data[] = [];
  const edges = catalog.systemEdges().get(entry.id);
  if (edges) {
    for (const [id, repositories] of [...edges.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      systemDependencies.push({ id, type: "system", via_repositories: [...repositories].sort() });
    }
  }
  return {
    id: entry.id,
    type: entry.kind,
    dependencies,
    system_dependencies: systemDependencies,
  };
}

export function reverseDependencies(catalog: Catalog, entry: Entry): Data {
  let targetIds = new Set([entry.id]);
  if (entry.kind === "system") {
    targetIds = new Set(
      catalog.entriesFor("repository")
        .filter((repository) => repository.data.system === entry.id)
        .map((repository) => repository.id),
    );
  }

  const direct = new Map<string, Entry>();
  for (const repository of catalog.entriesFor("repository")) {
    if (validDependencies(repository.data["depends-on"]).some((dependency) => targetIds.has(dependency.id))) {
      direct.set(repository.id, repository);
    }
  }
  const dependents: Data[] = [...direct.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ({ id: item.id, type: item.kind, name: entryName(item) }));

  if (entry.kind === "system") {
    for (const [systemId, targets] of [...catalog.systemEdges().entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const repositories = targets.get(entry.id);
      if (!repositories) continue;
      const source = catalog.get(systemId);
      dependents.push({
        id: systemId,
        type: "system",
        name: source ? entryName(source) : systemId,
        via_repositories: [...repositories].sort(),
      });
    }
  }
  return { id: entry.id, type: entry.kind, dependents };
}

export function validateCatalog(catalog: Catalog): Finding {
  const errors = [...catalog.loadErrors];
  const warnings: string[] = [];
  const seen = new Map<string, Entry>();
  const keys = new Map<string, Entry>();

  for (const entry of catalog.entries) {
    const file = relative(catalog.root, entry.path);
    if (!ID_PATTERN.test(entry.id)) errors.push(`${file}: ID ${JSON.stringify(entry.id)} is not lowercase kebab-case`);
    const prior = seen.get(entry.id);
    if (prior) errors.push(`${file}: duplicate ID ${JSON.stringify(entry.id)}; also used by ${relative(catalog.root, prior.path)}`);
    else seen.set(entry.id, entry);

    const unknown = Object.keys(entry.data).filter((field) => !FIELDS[entry.kind].has(field)).sort();
    if (unknown.length) errors.push(`${file}: unknown field(s): ${unknown.join(", ")}`);
    if (!("description" in entry.data)) errors.push(`${file}: missing required field: description`);
    else if (!isString(entry.data.description)) errors.push(`${file}: description must be a string`);

    for (const field of ["name", "owner", "remote", "default-branch"]) {
      if (field in entry.data && !isString(entry.data[field])) errors.push(`${file}: ${field} must be a string`);
    }
    if ((entry.kind === "external") && ["provider", "kind"].some((field) => field in entry.data && !isString(entry.data[field]))) {
      for (const field of ["provider", "kind"]) {
        if (field in entry.data && !isString(entry.data[field])) errors.push(`${file}: ${field} must be a string`);
      }
    }

    const status = entryStatus(entry);
    if (!isString(status) || !STATUSES.has(status)) errors.push(`${file}: invalid status ${JSON.stringify(status)}`);
    if (isString(entry.data.remote) && remoteHasCredentials(entry.data.remote)) {
      errors.push(`${file}: remote must not contain credentials`);
    }

    if (entry.kind !== "repository") continue;
    const key = entry.data.key;
    if (key !== undefined && (!isString(key) || !KEY_PATTERN.test(key))) {
      errors.push(`${file}: key must be 2–5 characters: an uppercase letter, then uppercase letters or digits`);
    } else if (isString(key)) {
      const priorKey = keys.get(key);
      if (priorKey) errors.push(`${file}: duplicate key ${JSON.stringify(key)}; also used by ${relative(catalog.root, priorKey.path)}`);
      else keys.set(key, entry);
    }

    const systemId = entry.data.system;
    if (systemId !== undefined && !isString(systemId)) {
      errors.push(`${file}: system must be a string`);
    } else if (isString(systemId)) {
      const target = catalog.get(systemId);
      if (!target || target.kind !== "system") errors.push(`${file}: system ${JSON.stringify(systemId)} does not name a system`);
    }

    const tags = entry.data.tags ?? [];
    if (!Array.isArray(tags) || tags.some((tag) => !isString(tag))) {
      errors.push(`${file}: tags must be a list of strings`);
    } else {
      for (const tag of tags) {
        if (!(tag in catalog.tags)) errors.push(`${file}: tag ${JSON.stringify(tag)} is not defined in tags.toml`);
      }
    }

    const rawDependencies = entry.data["depends-on"] ?? [];
    if (!Array.isArray(rawDependencies)) {
      errors.push(`${file}: depends-on must be a list`);
      continue;
    }
    for (const [index, rawDependency] of rawDependencies.entries()) {
      const label = `${file}: depends-on[${index}]`;
      if (!isRecord(rawDependency)) {
        errors.push(`${label} must be a table`);
        continue;
      }
      const extra = Object.keys(rawDependency).filter((field) => !["id", "via"].includes(field)).sort();
      if (extra.length) errors.push(`${label} has unknown field(s): ${extra.join(", ")}`);
      const dependencyId = rawDependency.id;
      if (!isString(dependencyId)) {
        errors.push(`${label} requires a string id`);
        continue;
      }
      if (dependencyId === entry.id) errors.push(`${label} cannot point to the same repository`);
      const target = catalog.get(dependencyId);
      if (!target) errors.push(`${label} ID ${JSON.stringify(dependencyId)} does not exist`);
      else if (target.kind !== "repository" && target.kind !== "external") {
        errors.push(`${label} ID ${JSON.stringify(dependencyId)} is not a repository or external`);
      }
      if ("via" in rawDependency && !isString(rawDependency.via)) errors.push(`${label} via must be a string`);
      const status = target ? entryStatus(target) : "active";
      if (target && (status === "deprecated" || status === "archived")) {
        warnings.push(`${label} points to ${status} entry ${JSON.stringify(dependencyId)}`);
      }
    }
  }

  const tagsPath = join(catalog.root, "tags.toml");
  if (!existsSync(tagsPath)) errors.push("tags.toml is missing");
  for (const [tag, description] of Object.entries(catalog.tags)) {
    if (!isString(description)) errors.push(`tags.toml: description for ${JSON.stringify(tag)} must be a string`);
  }

  if (catalog.localPaths === null) {
    if (!catalog.localPathsExists) warnings.push("local/paths.toml is missing; local path checks were skipped");
  } else {
    for (const [repositoryId, rawPath] of Object.entries(catalog.localPaths)) {
      if (!isString(rawPath)) {
        errors.push(`local/paths.toml: path for ${JSON.stringify(repositoryId)} must be a string`);
        continue;
      }
      const target = catalog.get(repositoryId);
      if (!target || target.kind !== "repository") {
        errors.push(`local/paths.toml: ${JSON.stringify(repositoryId)} does not name a repository`);
        continue;
      }
      const path = resolveLocalPath(catalog.root, rawPath);
      const pathError = localPathError(path, target.data.remote);
      if (pathError) errors.push(`local/paths.toml: ${pathError} for ${JSON.stringify(repositoryId)}`);
    }
  }

  const ignored = spawnSync("git", ["check-ignore", "-q", "local/paths.toml"], {
    cwd: catalog.root,
    encoding: "utf8",
  });
  if (ignored.error) errors.push(`could not check Git ignore rule: ${ignored.error.message}`);
  else if (ignored.status !== 0) errors.push("local/paths.toml is not ignored by Git");

  return { errors, warnings: [...new Set(warnings)].sort() };
}

function parseArgs(argv: string[]): Options {
  const [command, ...rest] = argv;
  if (!["find", "show", "deps", "rdeps", "check"].includes(command)) {
    throw new Error("usage: charts <find|show|deps|rdeps|check> [arguments] [--json]");
  }
  const options: Options = { command: command as Options["command"], json: false };
  const positional: string[] = [];
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function main(argv = process.argv.slice(2), root = ROOT): number {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(errorMessage(error));
    return 2;
  }
  const catalog = new Catalog(root);

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
