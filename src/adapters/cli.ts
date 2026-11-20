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
import { ChartsError, exitCodeOf } from "../domain/errors.ts";

// The terminal adapter: argument parsing and text or JSON output.

export type Options = {
  command: "find" | "show" | "deps" | "rdeps" | "check" | "add" | "set";
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

/** Parses the command line. Throws an Error with the usage message on bad input. */
export function parseArgs(argv: string[]): Options {
  const [command, ...rest] = argv;
  if (!["find", "show", "deps", "rdeps", "check", "add", "set"].includes(command)) {
    throw new Error("usage: charts <find|show|deps|rdeps|check|add|set> [arguments] [--json]");
  }
  const options: Options = { command: command as Options["command"], json: false };
  const positional: string[] = [];

  if (command === "add") {
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

  if (command === "set") {
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
