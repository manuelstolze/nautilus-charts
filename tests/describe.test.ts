import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { COMMANDS, describeModule, helpText } from "../src/adapters/cli.ts";
import { ERROR_CODES } from "../src/domain/errors.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "charts.ts");
const R6_CODES = ["entry-not-found", "invalid-entry", "unsupported-runtime", "usage", "not-found", "refused", "external"];

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
}

/** The command names that the help text lists. */
function helpCommands(text: string): string[] {
  const lines = text.split("\n");
  return lines.slice(lines.indexOf("Commands:") + 1).filter((line) => line.startsWith("  ")).map((line) => line.trim().split(" ")[0]);
}

describe("describe", () => {
  test("lists every command that the help text lists, and no other", () => {
    const help = run(["--help"]);
    assert.equal(help.status, 0, help.stderr);
    const described = run(["describe", "--json"]);
    assert.equal(described.status, 0, described.stderr);
    const commands = (JSON.parse(described.stdout) as { commands: Array<{ name: string }> }).commands.map(({ name }) => name);
    assert.deepEqual(commands, helpCommands(help.stdout));
    assert.deepEqual(commands, ["find", "show", "deps", "rdeps", "check", "add", "set", "describe"]);
  });

  test("has the structure of the Logbook's describe output", () => {
    const description = JSON.parse(run(["describe", "--json"]).stdout) as Record<string, unknown> & { commands: Array<Record<string, unknown>> };
    assert.deepEqual(Object.keys(description), ["module", "version", "errors", "commands"]);
    assert.equal(description.module, "charts");
    for (const command of description.commands) {
      assert.deepEqual(Object.keys(command), ["name", "usage", "summary", "arguments", "options", "output", "errors"]);
    }
  });

  test("lists every error code with its exit code and meaning, including each code of R6", () => {
    const { errors } = JSON.parse(run(["describe", "--json"]).stdout) as {
      errors: Array<{ code: string; category: string; exit_code: number; meaning: string }>;
    };
    assert.deepEqual(errors.map(({ code }) => code), Object.keys(ERROR_CODES));
    for (const code of R6_CODES) assert.ok(errors.some((error) => error.code === code), code);
    for (const error of errors) {
      assert.deepEqual(Object.keys(error), ["code", "category", "exit_code", "meaning"]);
      assert.ok([1, 2, 3, 4].includes(error.exit_code), error.code);
      assert.ok(error.meaning.length > 0, error.code);
    }
  });

  test("prints the module and a prose list of commands without --json", () => {
    const result = run(["describe"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^charts \S+\nCommands:\n {2}find \[<text>\]/);
    assert.match(result.stdout, /\nError codes:\n {2}usage \(exit 1\): /);
  });

  test("refuses arguments", () => {
    const result = run(["describe", "extra", "--json"]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, "usage");
  });
});

describe("command table", () => {
  /** The problems of one table entry; empty when it is complete. */
  function problems(command: (typeof COMMANDS)[number]): string[] {
    const found: string[] = [];
    if (!command.summary?.trim()) found.push("summary");
    if (command.arguments?.type !== "array" || !Array.isArray(command.arguments.prefixItems)) found.push("arguments schema");
    if (command.options?.type !== "object" || typeof command.options.properties !== "object") found.push("options schema");
    if (!command.output || Object.keys(command.output.fields).length === 0) found.push("output fields");
    if (!command.errors?.length || !command.errors.includes("usage")) found.push("error codes");
    for (const code of command.errors ?? []) if (!(code in ERROR_CODES)) found.push(`unknown error code ${code}`);
    return found;
  }

  test("gives every command a summary, schemas, output fields, and known error codes", () => {
    for (const command of COMMANDS) assert.deepEqual(problems(command), [], command.name);
  });

  test("finds an entry without a summary, a schema, or error codes", () => {
    const [find] = COMMANDS;
    assert.deepEqual(problems({ ...find, summary: "" }), ["summary"]);
    assert.deepEqual(problems({ ...find, options: {} }), ["options schema"]);
    assert.deepEqual(problems({ ...find, arguments: { type: "object" } }), ["arguments schema"]);
    assert.deepEqual(problems({ ...find, errors: [] }), ["error codes"]);
  });

  test("names each command once, and the help text has one line per command", () => {
    const names = COMMANDS.map(({ name }) => name);
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual(helpCommands(helpText()), names);
  });

  test("describe prints the table without the parsers", () => {
    const description = describeModule({ module: "charts", version: "9.9.9" });
    assert.equal(description.version, "9.9.9");
    assert.deepEqual(description.commands.map(({ name }) => name), COMMANDS.map(({ name }) => name));
    assert.ok(description.commands.every((command) => !("parse" in command)));
  });

  test("covers each specific code in at least one command", () => {
    const used = new Set(COMMANDS.flatMap(({ errors }) => errors));
    for (const code of ["entry-not-found", "invalid-entry", "refused", "external"]) assert.ok(used.has(code as never), code);
  });
});

describe("version", () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };

  test("package.json starts Charts at version 1.0.0", () => {
    assert.equal(manifest.version, "1.0.0");
  });

  test("--version prints the module and the version from package.json, as text or JSON", () => {
    const text = run(["--version"]);
    assert.deepEqual([text.status, text.stdout, text.stderr], [0, `charts ${manifest.version}\n`, ""]);
    for (const args of [["--version", "--json"], ["--json", "--version"]]) {
      const json = run(args);
      assert.equal(json.status, 0, json.stderr);
      assert.deepEqual(JSON.parse(json.stdout), { module: "charts", version: manifest.version });
    }
    assert.equal(JSON.parse(run(["describe", "--json"]).stdout).version, manifest.version);
  });

  test("the version is not repeated in the code", () => {
    const files = [
      ...readdirSync(join(REPO_ROOT, "src"), { recursive: true, encoding: "utf8" }).map((file) => join("src", file)),
      "scripts/charts.ts",
    ].filter((file) => file.endsWith(".ts"));
    for (const file of files) assert.ok(!readFileSync(join(REPO_ROOT, file), "utf8").includes(manifest.version), file);
  });

  test("the help text lists --version", () => {
    assert.match(helpText(), /charts --version \[--json\]/);
  });
});
