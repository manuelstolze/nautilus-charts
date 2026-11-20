import type { AddResult } from "../commands/add.ts";
import type { CheckResult } from "../commands/check.ts";
import type { FindResult } from "../commands/find.ts";
import type { SetResult } from "../commands/set.ts";
import type { EntryResult } from "../commands/show.ts";
import type { NewTag } from "../domain/validation.ts";
import {
  compact,
  entryJson,
  entryName,
  errorMessage,
  ID_PATTERN,
  isKind,
  isRecord,
  STATUSES,
  type Data,
  type Kind,
} from "../domain/entry.ts";
import { ChartsError, ERROR_CATEGORIES, ERROR_CODES, exitCodeOf, type ErrorCode } from "../domain/errors.ts";

// The terminal adapter: argument parsing and text or JSON output.

export type CommandName = "find" | "show" | "deps" | "rdeps" | "check" | "add" | "set" | "describe";

export type Options = {
  command: CommandName;
  json: boolean;
  text?: string;
  id?: string;
  kind?: Kind;
  data?: Data;
  localPath?: string;
  newTags?: NewTag[];
  replaceKey?: boolean;
  system?: string;
  tag?: string;
  status?: string;
  owner?: string;
};

function parseAdd(rest: string[]): Options {
  const options: Options = { command: "add", json: false };
  const positional: string[] = [];
  let dataText: string | undefined;
  let localPathSet = false;
  const newTags: NewTag[] = [];
  const newTagNames = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--data" || argument === "--local-path" || argument === "--new-tag") {
      const value = rest[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--data") {
        if (dataText !== undefined) throw new Error("--data can be used only once");
        dataText = value;
      } else if (argument === "--local-path") {
        if (localPathSet) throw new Error("--local-path can be used only once");
        localPathSet = true;
        options.localPath = value;
      } else {
        const separator = value.indexOf("=");
        if (separator < 0) throw new Error("--new-tag must use <name>=<description>");
        const name = value.slice(0, separator);
        const description = value.slice(separator + 1);
        if (!name) throw new Error("--new-tag name must not be empty");
        if (!description) throw new Error("--new-tag description must not be empty");
        if (newTagNames.has(name)) throw new Error(`--new-tag name ${JSON.stringify(name)} was used more than once`);
        newTagNames.add(name);
        newTags.push({ name, description });
      }
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`unknown option: ${argument}`);
    positional.push(argument);
  }
  if (positional.length !== 2) throw new Error("add requires an entry type and ID");
  const kind = positional[0];
  if (!isKind(kind)) {
    throw new Error(`invalid entry type: ${kind}`);
  }
  options.kind = kind;
  if (newTags.length && kind !== "repository") throw new Error("--new-tag is valid only for repository entries");
  options.newTags = newTags;
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

function parseSet(rest: string[]): Options {
  const options: Options = { command: "set", json: false };
  const positional: string[] = [];
  let dataText: string | undefined;
  let localPathSet = false;
  let replaceKeySet = false;
  const newTags: NewTag[] = [];
  const newTagNames = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--replace-key") {
      if (replaceKeySet) throw new Error("--replace-key can be used only once");
      replaceKeySet = true;
      options.replaceKey = true;
      continue;
    }
    if (argument === "--data" || argument === "--local-path" || argument === "--new-tag") {
      const value = rest[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--data") {
        if (dataText !== undefined) throw new Error("--data can be used only once");
        dataText = value;
      } else if (argument === "--local-path") {
        if (localPathSet) throw new Error("--local-path can be used only once");
        localPathSet = true;
        options.localPath = value;
      } else {
        const separator = value.indexOf("=");
        if (separator < 0) throw new Error("--new-tag must use <name>=<description>");
        const name = value.slice(0, separator);
        const description = value.slice(separator + 1);
        if (!name) throw new Error("--new-tag name must not be empty");
        if (!description) throw new Error("--new-tag description must not be empty");
        if (newTagNames.has(name)) throw new Error(`--new-tag name ${JSON.stringify(name)} was used more than once`);
        newTagNames.add(name);
        newTags.push({ name, description });
      }
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`unknown option: ${argument}`);
    positional.push(argument);
  }
  if (positional.length !== 1) throw new Error("set requires one entry ID");
  options.id = positional[0];
  if (!ID_PATTERN.test(options.id)) throw new Error(`invalid ID ${JSON.stringify(options.id)}; use lowercase kebab-case`);
  if (dataText === undefined && options.localPath === undefined) {
    throw new Error("set requires --data '<JSON>' or --local-path <path>");
  }
  if (options.localPath === "") throw new Error("--local-path must not be empty");
  if (dataText !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataText);
    } catch (error) {
      throw new Error(`--data is not valid JSON: ${errorMessage(error)}`);
    }
    if (!isRecord(parsed)) throw new Error("--data must be a JSON object");
    if (Object.hasOwn(parsed, "id")) throw new Error("do not include id in --data; pass it as the positional ID");
    if (replaceKeySet && !Object.hasOwn(parsed, "key")) throw new Error("--replace-key requires key in --data");
    options.data = parsed;
  } else if (replaceKeySet) {
    throw new Error("--replace-key requires key in --data");
  }
  options.newTags = newTags;
  return options;
}

/** Parses `find`, `show`, `deps`, `rdeps`, and `check`. */
function parseQuery(command: "find" | "show" | "deps" | "rdeps" | "check", rest: string[]): Options {
  const options: Options = { command, json: false };
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

function parseDescribe(rest: string[]): Options {
  const options: Options = { command: "describe", json: false };
  for (const argument of rest) {
    if (argument !== "--json") throw new Error("describe takes no arguments");
    options.json = true;
  }
  return options;
}

/** A JSON Schema, as `describe` prints it. */
export type JsonSchema = { [key: string]: unknown };

/**
 * One command of Charts. The parser, the help text, and `describe` read this
 * table, so a command exists in all three or in none.
 */
export type CommandSpec = {
  name: CommandName;
  /** The help line after the command name. */
  usage: string;
  summary: string;
  /** The positional arguments as a JSON Schema array. */
  arguments: JsonSchema;
  /** The `--name value` options as a JSON Schema object. */
  options: JsonSchema;
  /** The fields of the `--json` output. */
  output: { type: "object" | "array"; fields: Record<string, string> };
  errors: ErrorCode[];
  /** Parses the arguments after the command name. Throws an Error with the usage message on bad input. */
  parse(args: string[]): Options;
};

/** Positional arguments: fixed items, then optional ones. */
function positionalSchema(required: JsonSchema[], optional: JsonSchema[] = []): JsonSchema {
  const items = [...required, ...optional];
  return { type: "array", prefixItems: items, items: false, minItems: required.length, maxItems: items.length };
}

/** Options given as `--name value`. */
function optionsSchema(properties: Record<string, JsonSchema> = {}, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const text = (description: string): JsonSchema => ({ type: "string", description });
const ID_SCHEMA: JsonSchema = { type: "string", title: "id", description: "an entry ID, lowercase kebab-case", pattern: ID_PATTERN.source };
const KIND_SCHEMA: JsonSchema = { type: "string", title: "type", enum: ["system", "repository", "external"] };
const ENTRY_OPTIONS: Record<string, JsonSchema> = {
  data: text("the entry fields as a JSON object, without id"),
  "local-path": text("a repository's local path on this machine"),
  "new-tag": {
    type: "array",
    description: "a tag to add to tags.toml, as <name>=<description>; repeatable, repositories only",
    items: { type: "string", pattern: "^[^=]+=.+$" },
  },
};
const ENTRY_FIELDS: Record<string, string> = {
  type: "the entry type: system, repository, or external",
  id: "the entry ID",
  name: "the name, or the ID when the entry has none",
  "<field>": "every field the entry file sets, such as description, system, tags, or depends-on",
};
const CHANGE_FIELDS: Record<string, string> = {
  ok: "true",
  type: "the entry type",
  id: "the entry ID",
  path: "the entry file, relative to Charts",
  validation: "ok, and the catalog's errors and warnings after the change",
};

export const COMMANDS: CommandSpec[] = [
  {
    name: "find",
    usage: "[<text>] [--system <id>] [--tag <tag>] [--status <status>] [--owner <text>]",
    summary: "Finds entries by text and filters, sorted by type and ID.",
    arguments: positionalSchema([], [{ ...text("text that the entry contains, ignoring case"), title: "text" }]),
    options: optionsSchema({
      system: text("only this system and its repositories and externals"),
      tag: text("only repositories with this tag"),
      status: { type: "string", description: "only entries with this status", enum: [...STATUSES] },
      owner: text("only entries whose owner contains this text, ignoring case"),
    }),
    output: { type: "object", fields: { entries: "the matching entries, each with type, id, name, and its fields" } },
    errors: ["usage", "external"],
    parse: (args) => parseQuery("find", args),
  },
  {
    name: "show",
    usage: "<id>",
    summary: "Shows an entry; a repository also gets its ticket key and checked local path.",
    arguments: positionalSchema([ID_SCHEMA]),
    options: optionsSchema(),
    output: {
      type: "object",
      fields: {
        ...ENTRY_FIELDS,
        resolved_ticket_key: "repositories only: its own or its system's ticket key, or null",
        ticket_key_source: "repositories only: repository, system, or null",
        local_path: "repositories only: the local path when its check passes, or null",
        local_path_status: "repositories only: ok, not configured, or why the check failed",
      },
    },
    errors: ["usage", "entry-not-found", "external"],
    parse: (args) => parseQuery("show", args),
  },
  {
    name: "deps",
    usage: "<id>",
    summary: "Lists what a repository or system depends on; a system's are derived from its repositories.",
    arguments: positionalSchema([ID_SCHEMA]),
    options: optionsSchema(),
    output: {
      type: "object",
      fields: {
        id: "the entry ID",
        type: "the entry type",
        dependencies: "each dependency with id, type, and name, via, from, or via_repositories where known",
        system_dependencies: "systems only: the systems it depends on, each with via_repositories",
      },
    },
    errors: ["usage", "entry-not-found", "external"],
    parse: (args) => parseQuery("deps", args),
  },
  {
    name: "rdeps",
    usage: "<id>",
    summary: "Lists what depends on an entry.",
    arguments: positionalSchema([ID_SCHEMA]),
    options: optionsSchema(),
    output: {
      type: "object",
      fields: { id: "the entry ID", type: "the entry type", dependents: "each dependent with id, type, and via, from, or via_repositories where known" },
    },
    errors: ["usage", "entry-not-found", "external"],
    parse: (args) => parseQuery("rdeps", args),
  },
  {
    name: "check",
    usage: "",
    summary: "Validates the catalog; with errors it prints its report and exits with 3.",
    arguments: positionalSchema([]),
    options: optionsSchema(),
    output: { type: "object", fields: { ok: "whether the catalog is valid", errors: "the errors", warnings: "the warnings" } },
    errors: ["usage", "external"],
    parse: (args) => parseQuery("check", args),
  },
  {
    name: "add",
    usage: "<system|repository|external> <id> --data '<JSON>' [--local-path <path>] [--new-tag <name>=<description>]...",
    summary: "Adds an entry from its template and validates the whole catalog; nothing is kept when that fails.",
    arguments: positionalSchema([KIND_SCHEMA, ID_SCHEMA]),
    options: optionsSchema(ENTRY_OPTIONS, ["data"]),
    output: { type: "object", fields: { ...CHANGE_FIELDS, new_tags: "the added tags, only when there are any" } },
    errors: ["usage", "invalid-entry", "refused", "external"],
    parse: parseAdd,
  },
  {
    name: "set",
    usage: "<id> [--data '<JSON>'] [--local-path <path>] [--new-tag <name>=<description>]... [--replace-key]",
    summary: "Updates the given fields of an entry and validates the whole catalog; nothing is kept when that fails.",
    arguments: positionalSchema([ID_SCHEMA]),
    options: {
      ...optionsSchema({
        ...ENTRY_OPTIONS,
        "replace-key": { type: "boolean", description: "allow changing an existing repository key; needs key in --data" },
      }),
      anyOf: [{ required: ["data"] }, { required: ["local-path"] }],
    },
    output: {
      type: "object",
      fields: { ...CHANGE_FIELDS, changed: "the changed fields", new_tags: "the added tags" },
    },
    errors: ["usage", "entry-not-found", "invalid-entry", "refused", "external"],
    parse: parseSet,
  },
  {
    name: "describe",
    usage: "",
    summary: "Describes the module, its error codes, and its commands; use --json.",
    arguments: positionalSchema([]),
    options: optionsSchema(),
    output: {
      type: "object",
      fields: {
        module: "the module name",
        version: "the module version",
        errors: "every error code with its category, exit code, and meaning",
        commands: "every command with its summary, arguments, options, output fields, and error codes",
      },
    },
    errors: ["usage"],
    parse: parseDescribe,
  },
];

export function helpText(): string {
  const lines = COMMANDS.map(({ name, usage }) => `  ${usage === "" ? name : `${name} ${usage}`}`);
  return ["Usage: charts <command> [arguments] [--json]", "       charts --version [--json]", "Commands:", ...lines].join("\n");
}

export type Invocation = { json: boolean; help: boolean; version: boolean; args: string[] };

/** Detects `--json` anywhere in the arguments and a request for help or for the version. */
export function readInvocation(argv: string[]): Invocation {
  const json = argv.includes("--json");
  const args = argv.filter((argument) => argument !== "--json");
  const help = args.length === 0 || args.includes("--help") || args.includes("-h");
  const version = args.length === 1 && args[0] === "--version";
  return { json, help, version, args };
}

/** Parses the command line. Throws an Error with the usage message on bad input. */
export function parseArgs(argv: string[]): Options {
  const [command, ...rest] = argv;
  const spec = COMMANDS.find(({ name }) => name === command);
  if (spec === undefined) throw new Error(`usage: charts <${COMMANDS.map(({ name }) => name).join("|")}> [arguments] [--json]`);
  return spec.parse(rest);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * Writes a failure as a typed error object with `--json`, or as prose on
 * standard error, and returns its category's exit code. An error that is not
 * a Charts error is external.
 */
export function renderError(json: boolean, error: unknown): number {
  const typed = error instanceof ChartsError ? error : new ChartsError("external", errorMessage(error));
  if (json) printJson({ error: { code: typed.code, message: typed.message, details: typed.details } });
  else console.error(`ERROR: ${typed.message}`);
  return exitCodeOf(typed.code);
}

/** Reports an argument error as a `usage` error. Returns the exit status. */
export function renderUsageError(argv: string[], error: unknown): number {
  const typed = error instanceof ChartsError ? error : new ChartsError("usage", errorMessage(error));
  return renderError(argv.includes("--json"), typed);
}

/** Without `--json`, prints the warnings and errors in a failure's details before its message. */
function renderFailure(json: boolean, error: ChartsError): number {
  if (!json) {
    const { errors = [], warnings = [] } = error.details as { errors?: string[]; warnings?: string[] };
    for (const warning of warnings) console.log(`WARNING: ${warning}`);
    for (const message of errors) console.error(`ERROR: ${message}`);
  }
  return renderError(json, error);
}

export function renderFind(json: boolean, result: FindResult): number {
  if (json) {
    printJson({ entries: result.entries.map(entryJson) });
  } else {
    for (const entry of result.entries) {
      console.log(`${entry.kind} ${entry.id} — ${compact(entryName(entry))} — ${compact(entry.data.description ?? "")}`);
    }
  }
  return 0;
}

export function renderShow(json: boolean, result: EntryResult): number {
  if (!result.ok) return renderError(json, result.error);
  const data = result.data;
  if (json) {
    printJson(data);
    return 0;
  }
  const fields = [`${data.type} ${data.id}`];
  for (const key of [
    "name",
    "description",
    "key",
    "ticket-key",
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
    "resolved_ticket_key",
    "ticket_key_source",
  ]) {
    if (key in data && data[key] !== null) fields.push(`${key}=${compact(data[key])}`);
  }
  console.log(fields.join(" — "));
  return 0;
}

/** Prints `deps` (reverse = false) or `rdeps` (reverse = true) results. */
export function renderEdges(json: boolean, result: EntryResult, reverse: boolean): number {
  if (!result.ok) return renderError(json, result.error);
  const data = result.data;
  if (json) {
    printJson(data);
    return 0;
  }
  const key = reverse ? "dependents" : "dependencies";
  const edges = data[key] as Data[];
  const systemDependencies = (data.system_dependencies as Data[] | undefined) ?? [];
  if (!edges.length && !systemDependencies.length) {
    console.log(`${data.id}: no ${key}`);
    return 0;
  }
  for (const edge of edges) {
    const via = edge.via ? ` via ${compact(edge.via)}` : "";
    const source = edge.from ? ` from ${compact(edge.from)}` : "";
    const viaRepositories = Array.isArray(edge.via_repositories)
      ? ` via repositories ${(edge.via_repositories as string[]).join(", ")}`
      : "";
    const arrow = reverse ? "<-" : "->";
    console.log(`${data.id} ${arrow} ${edge.type} ${edge.id}${via}${source}${viaRepositories}`);
  }
  if (!reverse) {
    for (const edge of systemDependencies) {
      const repositories = (edge.via_repositories as string[]).join(", ");
      console.log(`${data.id} -> system ${edge.id} via repositories ${repositories}`);
    }
  }
  return 0;
}

/** Prints the check report; with errors, the report stays the output and the exit code is a refusal's. */
export function renderCheck(json: boolean, result: CheckResult): number {
  const { errors, warnings } = result.finding;
  if (json) {
    printJson({ ok: errors.length === 0, errors, warnings });
  } else {
    for (const warning of warnings) console.log(`WARNING: ${warning}`);
    for (const error of errors) console.log(`ERROR: ${error}`);
    if (!errors.length) console.log("check: ok");
  }
  return errors.length ? exitCodeOf("refused") : 0;
}

export function renderSet(json: boolean, result: SetResult): number {
  if (!result.ok) return renderFailure(json, result.error);
  if (json) {
    printJson({
      ok: result.ok,
      type: result.type,
      id: result.id,
      path: result.path,
      changed: result.changed,
      new_tags: result.newTags,
      validation: { ok: result.validation.errors.length === 0, ...result.validation },
    });
    return 0;
  }
  for (const warning of result.validation.warnings) console.log(`WARNING: ${warning}`);
  if (result.changed.length === 0 && result.newTags.length === 0) {
    console.log(`No change to ${result.type} ${result.id} at ${result.path}`);
  } else {
    const changed = result.changed.length ? result.changed.join(", ") : "none";
    console.log(`Updated ${result.type} ${result.id} at ${result.path}; changed fields: ${changed}; validation ok`);
    if (result.newTags.length) {
      console.log(`New tags: ${result.newTags.join(", ")}. The shared tag list has uncommitted changes.`);
    }
  }
  return 0;
}

export function renderAdd(json: boolean, result: AddResult): number {
  if (!result.ok) return renderFailure(json, result.error);
  if (json) {
    const output: Data = {
      ok: result.ok,
      type: result.type,
      id: result.id,
      path: result.path,
      validation: { ok: result.validation.errors.length === 0, ...result.validation },
    };
    if (result.newTags.length) output.new_tags = result.newTags;
    printJson(output);
    return 0;
  }
  for (const warning of result.validation.warnings) console.log(`WARNING: ${warning}`);
  console.log(`Created ${result.type} ${result.id} at ${result.path}; validation ok`);
  if (result.newTags.length) {
    console.log(`New tags: ${result.newTags.join(", ")}. The shared tag list has uncommitted changes.`);
  }
  return 0;
}

/** The module's name and version, which the composition root reads from `package.json`. */
export type ModuleInfo = { module: string; version: string };

export type Description = ModuleInfo & {
  errors: Array<{ code: ErrorCode; category: string; exit_code: number; meaning: string }>;
  commands: Array<Omit<CommandSpec, "parse">>;
};

/** What `describe --json` prints: the module, its error codes, and its commands from the command table. */
export function describeModule(info: ModuleInfo): Description {
  return {
    module: info.module,
    version: info.version,
    errors: (Object.keys(ERROR_CODES) as ErrorCode[]).map((code) => ({
      code,
      category: ERROR_CODES[code].category,
      exit_code: exitCodeOf(code),
      meaning: ERROR_CODES[code].meaning,
    })),
    commands: COMMANDS.map(({ name, usage, summary, arguments: positional, options, output, errors }) => ({
      name,
      usage,
      summary,
      arguments: positional,
      options,
      output,
      errors,
    })),
  };
}

export function renderDescribe(json: boolean, info: ModuleInfo): number {
  const description = describeModule(info);
  if (json) {
    printJson(description);
    return 0;
  }
  const lines = [`${description.module} ${description.version}`, "Commands:"];
  for (const command of description.commands) {
    lines.push(`  ${command.usage === "" ? command.name : `${command.name} ${command.usage}`}`, `      ${command.summary}`);
  }
  lines.push("Error codes:");
  for (const error of description.errors) lines.push(`  ${error.code} (exit ${error.exit_code}): ${error.meaning}`);
  lines.push("Exit codes by category:");
  for (const [category, { exitCode, meaning }] of Object.entries(ERROR_CATEGORIES)) lines.push(`  ${exitCode} ${category}: ${meaning}`);
  console.log(lines.join("\n"));
  return 0;
}

/** Prints `charts <version>`, or the module and version as JSON. */
export function renderVersion(json: boolean, info: ModuleInfo): number {
  if (json) printJson({ module: info.module, version: info.version });
  else console.log(`${info.module} ${info.version}`);
  return 0;
}

export function renderHelp(): number {
  console.log(helpText());
  return 0;
}
