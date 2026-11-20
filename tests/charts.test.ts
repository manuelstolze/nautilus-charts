import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";
import { parse as parseToml } from "smol-toml";
import { main } from "../scripts/charts.ts";
import { renderError } from "../src/adapters/cli.ts";
import { GitCli } from "../src/adapters/git-cli.ts";
import { TomlStore } from "../src/adapters/toml-store.ts";
import { checkCatalog as validateCatalog } from "../src/commands/check.ts";
import { showEntry } from "../src/commands/show.ts";
import { CatalogIndex } from "../src/domain/catalog.ts";
import { dependenciesFor, reverseDependencies } from "../src/domain/dependencies.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let temporary: string;
let root: string;

function write(relativePath: string, content: string): string {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

function makeFixture(): void {
  temporary = mkdtempSync(join(tmpdir(), "charts-test-"));
  root = join(temporary, "charts");
  for (const directory of ["systems", "repositories", "externals", "local", "templates"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  for (const kind of ["system", "repository", "external"]) {
    copyFileSync(join(REPO_ROOT, `templates/${kind}.toml`), join(root, `templates/${kind}.toml`));
  }
  writeFileSync(
    join(root, ".gitignore"),
    "/systems/*.toml\n/repositories/*.toml\n/externals/*.toml\n/local/paths.toml\n",
    "utf8",
  );
  execFileSync("git", ["init", "-q", root]);
  write("tags.toml", 'utility = "Shared tools."\nlibrary = "Reusable code."\n');
  write("systems/alpha.toml", 'description = "Alpha system."\n');
  write("systems/beta.toml", 'description = "Beta system."\n');
  write("systems/gamma.toml", 'description = "Gamma system."\n');
  write(
    "repositories/alpha-app.toml",
    'description = "Alpha application."\nsystem = "alpha"\ntags = ["utility"]\n' +
      'depends-on = [{ id = "beta-lib", via = "npm" }, { id = "stripe", via = "API" }]\n',
  );
  write(
    "repositories/beta-lib.toml",
    'description = "Beta library."\nsystem = "beta"\ntags = ["library"]\n',
  );
  write(
    "repositories/gamma-app.toml",
    'description = "Gamma application."\nsystem = "gamma"\ndepends-on = [{ id = "beta-lib" }]\n',
  );
  write("externals/stripe.toml", 'description = "Payment service."\n');
}

function capture<T>(action: () => T): { result: T; output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  const original = console.log;
  const originalError = console.error;
  console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
  try {
    return { result: action(), output, errors };
  } finally {
    console.log = original;
    console.error = originalError;
  }
}

beforeEach(makeFixture);
afterEach(() => rmSync(temporary, { recursive: true, force: true }));

describe("catalog validation", () => {
  test("accepts a missing local paths file", () => {
    const result = validateCatalog({ store: new TomlStore(root), git: new GitCli(root) });
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((warning) => warning.includes("local/paths.toml is missing")));
  });

  test("reports invalid TOML, unknown fields, and missing required fields", () => {
    write("systems/broken.toml", "description = [\n");
    write("systems/unknown.toml", 'description = "Extra field."\nextra = true\n');
    write("externals/no-description.toml", 'provider = "vendor"\n');
    const { errors } = validateCatalog({ store: new TomlStore(root), git: new GitCli(root) });
    assert.ok(errors.some((error) => error.includes("systems/broken.toml: invalid TOML")));
    assert.ok(errors.some((error) => error.includes("unknown field(s): extra")));
    assert.ok(errors.some((error) => error.includes("missing required field: description")));
  });

  test("checks kebab-case IDs and uniqueness across entry types", () => {
    write("repositories/Bad_ID.toml", 'description = "Bad ID."\n');
    write("repositories/shared-id.toml", 'description = "A repository."\n');
    write("externals/shared-id.toml", 'description = "An external."\n');
    const { errors } = validateCatalog({ store: new TomlStore(root), git: new GitCli(root) });
    assert.ok(errors.some((error) => error.includes("ID \"Bad_ID\" is not lowercase kebab-case")));
    assert.ok(errors.some((error) => error.includes("duplicate ID \"shared-id\"")));
  });

  test("checks status values and tags", () => {
    write(
      "repositories/alpha-app.toml",
      'description = "Alpha application."\nsystem = "alpha"\nstatus = "paused"\ntags = ["unknown"]\n',
    );
    const { errors } = validateCatalog({ store: new TomlStore(root), git: new GitCli(root) });
    assert.ok(errors.some((error) => error.includes("invalid status \"paused\"")));
    assert.ok(errors.some((error) => error.includes("tag \"unknown\" is not defined")));
  });

  test("checks system references, dependency references, and self-dependencies", () => {
    write(
      "repositories/alpha-app.toml",
      'description = "Alpha application."\nsystem = "missing-system"\n' +
        'depends-on = [{ id = "alpha-app" }, { id = "missing-repo" }, { id = "beta-lib", extra = true, via = 4 }]\n',
    );
    const { errors } = validateCatalog({ store: new TomlStore(root), git: new GitCli(root) });
    assert.ok(errors.some((error) => error.includes("system \"missing-system\" does not name a system")));
    assert.ok(errors.some((error) => error.includes("cannot point to the same repository")));
    assert.ok(errors.some((error) => error.includes("ID \"missing-repo\" does not exist")));
    assert.ok(errors.some((error) => error.includes("unknown field(s): extra")));
    assert.ok(errors.some((error) => error.includes("via must be a string")));
  });

  test("warns on dependencies to deprecated and archived entries", () => {
    write("repositories/beta-lib.toml", 'description = "Beta library."\nstatus = "deprecated"\n');
    write("externals/old-api.toml", 'description = "Retired API."\nstatus = "archived"\n');
    write("repositories/old-lib.toml", 'description = "Archived library."\nstatus = "archived"\n');
    write(
      "repositories/alpha-app.toml",
      'description = "Alpha application."\nsystem = "alpha"\n' +
        'depends-on = [{ id = "beta-lib" }, { id = "old-lib" }, { id = "old-api" }]\n',
    );
    const result = validateCatalog({ store: new TomlStore(root), git: new GitCli(root) });
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((warning) => warning.includes("deprecated entry \"beta-lib\"")));
    assert.ok(result.warnings.some((warning) => warning.includes("archived entry \"old-lib\"")));
    assert.ok(result.warnings.some((warning) => warning.includes("archived entry \"old-api\"")));
  });

  test("checks missing paths, non-Git paths, remotes, and credentials", () => {
    const nonRepo = join(root, "not-a-repository");
    const work = join(root, "work-repository");
    mkdirSync(nonRepo);
    mkdirSync(work);
    execFileSync("git", ["init", "-q", work]);
    write("repositories/alpha-app.toml", 'description = "Alpha."\nremote = "https://user:token@example/repo.git"\n');
    write("repositories/gamma-app.toml", 'description = "Gamma."\nremote = "ssh://example/gamma.git"\n');
    write(
      "local/paths.toml",
      `alpha-app = "${nonRepo}"\nbeta-lib = "${join(root, "absent")}"\ngamma-app = "${work}"\n`,
    );
    const { errors } = validateCatalog({ store: new TomlStore(root), git: new GitCli(root) });
    assert.ok(errors.some((error) => error.includes("not a Git repository root")));
    assert.ok(errors.some((error) => error.includes("path does not exist")));
    assert.ok(errors.some((error) => error.includes("remote does not match") && error.includes("gamma-app")));
    assert.ok(errors.some((error) => error.includes("remote must not contain credentials")));
  });

  test("requires Git to ignore local/paths.toml", () => {
    writeFileSync(join(root, ".gitignore"), "", "utf8");
    write("local/paths.toml", 'alpha-app = "/missing"\n');
    const { errors } = validateCatalog({ store: new TomlStore(root), git: new GitCli(root) });
    assert.ok(errors.some((error) => error.includes("local/paths.toml is not ignored")));
  });

  test("accepts a repository key and returns it from show and find", () => {
    write("repositories/alpha-app.toml", 'description = "Alpha application."\nkey = "NBR"\nsystem = "alpha"\n');
    assert.deepEqual(validateCatalog({ store: new TomlStore(root), git: new GitCli(root) }).errors, []);

    const shown = capture(() => main(["show", "alpha-app", "--json"], root));
    assert.equal(shown.result, 0);
    assert.equal(JSON.parse(shown.output.join("\n")).key, "NBR");
    assert.ok(capture(() => main(["show", "alpha-app"], root)).output.join("\n").includes("key=NBR"));

    const found = capture(() => main(["find", "NBR", "--json"], root));
    assert.equal(found.result, 0);
    assert.deepEqual(JSON.parse(found.output.join("\n")).entries.map((entry: { id: string }) => entry.id), ["alpha-app"]);
  });

  test("shows resolved ticket keys in JSON for repositories only", () => {
    write("systems/alpha.toml", 'description = "Alpha system."\nticket-key = "ABC"\n');
    write("repositories/alpha-app.toml", 'description = "Alpha application."\nsystem = "alpha"\nticket-key = "XYZ"\n');
    write("repositories/beta-lib.toml", 'description = "Beta library."\nsystem = "beta"\n');
    write("repositories/independent.toml", 'description = "Independent repository."\n');

    const own = capture(() => main(["show", "alpha-app", "--json"], root));
    const ownData = JSON.parse(own.output.join("\n"));
    assert.equal(ownData["ticket-key"], "XYZ");
    assert.equal(ownData.resolved_ticket_key, "XYZ");
    assert.equal(ownData.ticket_key_source, "repository");

    write("repositories/alpha-app.toml", 'description = "Alpha application."\nsystem = "alpha"\n');
    const inherited = capture(() => main(["show", "alpha-app", "--json"], root));
    const inheritedData = JSON.parse(inherited.output.join("\n"));
    assert.equal(inheritedData.resolved_ticket_key, "ABC");
    assert.equal(inheritedData.ticket_key_source, "system");

    for (const id of ["beta-lib", "independent"]) {
      const result = capture(() => main(["show", id, "--json"], root));
      const data = JSON.parse(result.output.join("\n"));
      assert.equal(data.resolved_ticket_key, null, id);
      assert.equal(data.ticket_key_source, null, id);
    }
    for (const id of ["alpha", "stripe"]) {
      const result = capture(() => main(["show", id, "--json"], root));
      const data = JSON.parse(result.output.join("\n"));
      assert.equal("resolved_ticket_key" in data, false, id);
      assert.equal("ticket_key_source" in data, false, id);
    }
  });

  test("checks repository key form, type, uniqueness, and entry type", () => {
    const form = "key must be 2–5 characters: an uppercase letter, then uppercase letters or digits";
    write("repositories/lower-key.toml", 'description = "Lowercase key."\nkey = "nb"\n');
    write("repositories/short-key.toml", 'description = "Short key."\nkey = "N"\n');
    write("repositories/long-key.toml", 'description = "Long key."\nkey = "NBRIDGE"\n');
    write("repositories/digit-key.toml", 'description = "Digit first."\nkey = "1NB"\n');
    write("repositories/number-key.toml", 'description = "Number key."\nkey = 12\n');
    write("repositories/first-key.toml", 'description = "First key."\nkey = "NBR"\n');
    write("repositories/second-key.toml", 'description = "Second key."\nkey = "NBR"\n');
    write("systems/system-key.toml", 'description = "System key."\nkey = "SYS"\n');
    const { errors } = validateCatalog({ store: new TomlStore(root), git: new GitCli(root) });

    for (const id of ["lower-key", "short-key", "long-key", "digit-key", "number-key"]) {
      assert.deepEqual(errors.filter((error) => error.startsWith(`repositories/${id}.toml:`)), [`repositories/${id}.toml: ${form}`]);
    }
    assert.deepEqual(
      errors.filter((error) => error.includes("duplicate key")),
      ['repositories/second-key.toml: duplicate key "NBR"; also used by repositories/first-key.toml'],
    );
    assert.deepEqual(
      errors.filter((error) => error.startsWith("systems/system-key.toml:")),
      ["systems/system-key.toml: unknown field(s): key"],
    );
  });

  test("prints check results as JSON and exits with 3 on errors", () => {
    const valid = capture(() => main(["check", "--json"], root));
    const validPayload = JSON.parse(valid.output.join("\n"));
    assert.equal(valid.result, 0);
    assert.equal(validPayload.ok, true);
    assert.ok(Array.isArray(validPayload.warnings));

    write("repositories/invalid-status.toml", 'description = "Invalid status."\nstatus = "paused"\n');
    const invalid = capture(() => main(["check", "--json"], root));
    const invalidPayload = JSON.parse(invalid.output.join("\n"));
    assert.equal(invalid.result, 3);
    assert.equal(invalidPayload.ok, false);
    assert.ok(invalidPayload.errors.length > 0);
  });

  test("rejects tags that tags.toml does not define, even inherited names", () => {
    write("repositories/inherited-tags.toml", 'description = "Inherited tags."\ntags = ["toString", "constructor", "__proto__", "utility"]\n');
    const { result, output } = capture(() => main(["check"], root));
    assert.notEqual(result, 0);
    assert.deepEqual(output.filter((line) => line.includes("repositories/inherited-tags.toml")), [
      'ERROR: repositories/inherited-tags.toml: tag "toString" is not defined in tags.toml',
      'ERROR: repositories/inherited-tags.toml: tag "constructor" is not defined in tags.toml',
      'ERROR: repositories/inherited-tags.toml: tag "__proto__" is not defined in tags.toml',
    ]);
  });

  test("accepts inherited names that tags.toml defines", () => {
    write("tags.toml", 'utility = "Shared tools."\nlibrary = "Reusable code."\n__proto__ = "Proto tag."\nconstructor = "Builds things."\n');
    write("repositories/inherited-tags.toml", 'description = "Inherited tags."\ntags = ["__proto__", "constructor", "utility"]\n');
    const { result, output } = capture(() => main(["check"], root));
    assert.deepEqual(output.filter((line) => line.startsWith("ERROR:")), []);
    assert.equal(result, 0);
  });
});

describe("charts add", () => {
  function add(kind: string, id: string, data: unknown, extra: string[] = []) {
    const dataText = typeof data === "string" ? data : JSON.stringify(data);
    return capture(() => main(["add", kind, id, "--data", dataText, ...extra], root));
  }

  test("creates each entry type from its template with only supplied values", () => {
    const systemData = {
      name: 'Quoted "System"',
      description: "Line one.\nLine two.",
      owner: "Team Example",
      "ticket-key": "ABC",
    };
    const system = add("system", "new-system", systemData, ["--json"]);
    const systemPayload = JSON.parse(system.output.join("\\n"));
    assert.equal(system.result, 0, JSON.stringify({ output: system.output, errors: system.errors }));
    assert.equal(systemPayload.type, "system");
    assert.equal(systemPayload.id, "new-system");
    assert.equal(systemPayload.path, "systems/new-system.toml");
    assert.equal(systemPayload.validation.ok, true);
    const systemContent = readFileSync(join(root, systemPayload.path), "utf8");
    assert.deepEqual(JSON.parse(JSON.stringify(parseToml(systemContent))), systemData);
    assert.ok(!systemContent.includes("Display name"));
    assert.ok(systemContent.indexOf('owner = "Team Example"') < systemContent.indexOf('ticket-key = "ABC"'));
    assert.ok(readFileSync(join(root, "templates/system.toml"), "utf8").includes('# ticket-key = "ABC"'));

    const repoData = {
      description: 'Uses a "quoted" name.\nSecond line.',
      key: "NEW",
      "ticket-key": "ABC",
      system: "alpha",
      tags: ["utility", "library"],
      "depends-on": [{ id: "beta-lib", via: "npm package" }, { id: "stripe", via: "API" }],
    };
    const repository = add("repository", "new-repository", repoData, ["--json"]);
    assert.equal(repository.result, 0);
    const repositoryFile = join(root, "repositories/new-repository.toml");
    const repositoryContent = readFileSync(repositoryFile, "utf8");
    const repositoryParsed = JSON.parse(JSON.stringify(parseToml(repositoryContent))) as Record<string, unknown>;
    assert.deepEqual(repositoryParsed, repoData);
    assert.ok(repositoryContent.indexOf('key = "NEW"') < repositoryContent.indexOf('ticket-key = "ABC"'));
    assert.ok(readFileSync(join(root, "templates/repository.toml"), "utf8").includes('# ticket-key = "ABC"'));
    assert.ok(!("id" in repositoryParsed));
    assert.ok(!repositoryContent.includes("Short purpose of this repository"));

    const externalData = { description: "External payment service.", provider: "example", kind: "saas" };
    const external = add("external", "new-external", externalData, ["--json"]);
    assert.equal(external.result, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(parseToml(readFileSync(join(root, "externals/new-external.toml"), "utf8")))), externalData);
    assert.ok(!existsSync(join(root, "systems/new-external.toml")));
  });

  test("omits optional template values when they are not supplied", () => {
    const result = add("system", "minimal-system", { description: "A minimal system." }, ["--json"]);
    assert.equal(result.result, 0);
    assert.deepEqual(
      JSON.parse(JSON.stringify(parseToml(readFileSync(join(root, "systems/minimal-system.toml"), "utf8")))),
      { description: "A minimal system." },
    );
  });

  test("rejects malformed or invalid input without writing files", () => {
    const cases: Array<{ kind: string; id: string; data: unknown; expected: string; code: string }> = [
      { kind: "invalid", id: "new-entry", data: { description: "Example." }, expected: "invalid entry type", code: "usage" },
      { kind: "system", id: "Bad_ID", data: { description: "Example." }, expected: "invalid ID", code: "usage" },
      { kind: "system", id: "missing-description", data: { name: "No description" }, expected: "missing required field: description", code: "invalid-entry" },
      { kind: "system", id: "unknown-field", data: { description: "Example.", extra: true }, expected: "unknown field(s): extra", code: "invalid-entry" },
      { kind: "system", id: "bad-status", data: { description: "Example.", status: "paused" }, expected: "invalid status", code: "invalid-entry" },
      { kind: "system", id: "bad-name", data: { description: "Example.", name: false }, expected: "name must be a string", code: "invalid-entry" },
      { kind: "system", id: "id-in-data", data: { id: "wrong", description: "Example." }, expected: "do not include id", code: "usage" },
    ];
    for (const item of cases) {
      const result = add(item.kind, item.id, item.data, ["--json"]);
      assert.equal(result.result, item.code === "usage" ? 1 : 3, JSON.stringify(item));
      assert.equal(JSON.parse(result.output.join("\n")).error.code, item.code, JSON.stringify(item));
      assert.ok(result.output.join("\\n").includes(item.expected), result.output.join("\\n"));
      for (const directory of ["systems", "repositories", "externals"]) {
        assert.equal(existsSync(join(root, directory, `${item.id}.toml`)), false);
      }
    }

    const malformed = capture(() => main(["add", "system", "bad-json", "--data", "{", "--json"], root));
    assert.equal(malformed.result, 1);
    assert.ok(JSON.parse(malformed.output.join("\\n")).error.message.includes("not valid JSON"));
    assert.equal(existsSync(join(root, "systems/bad-json.toml")), false);

    for (const value of ["[]", "null", '"text"']) {
      const result = capture(() => main(["add", "system", "not-object", "--data", value, "--json"], root));
      assert.equal(result.result, 1);
      assert.ok(JSON.parse(result.output.join("\\n")).error.message.includes("JSON object"));
      assert.equal(existsSync(join(root, "systems/not-object.toml")), false);
    }

    const invalidLocalPath = capture(() => main([
      "add", "external", "external-path", "--data", '{"description":"Example."}', "--local-path", "/tmp/work", "--json",
    ], root));
    assert.equal(invalidLocalPath.result, 1);
    assert.ok(JSON.parse(invalidLocalPath.output.join("\\n")).error.message.includes("only for repository"));
    assert.equal(existsSync(join(root, "externals/external-path.toml")), false);
  });

  test("rejects IDs used by any entry type without overwriting files", () => {
    const originalSystem = readFileSync(join(root, "systems/alpha.toml"), "utf8");
    const originalRepository = readFileSync(join(root, "repositories/alpha-app.toml"), "utf8");
    const originalExternal = readFileSync(join(root, "externals/stripe.toml"), "utf8");
    for (const [kind, id] of [["repository", "alpha"], ["external", "alpha-app"], ["system", "stripe"]]) {
      const result = add(kind, id, { description: "Must not replace." }, ["--json"]);
      assert.equal(result.result, 3);
      assert.ok(JSON.stringify(JSON.parse(result.output.join("\\n"))).includes("already exists"));
    }
    assert.equal(readFileSync(join(root, "systems/alpha.toml"), "utf8"), originalSystem);
    assert.equal(readFileSync(join(root, "repositories/alpha-app.toml"), "utf8"), originalRepository);
    assert.equal(readFileSync(join(root, "externals/stripe.toml"), "utf8"), originalExternal);
  });

  test("rejects invalid ticket-key values without writing", () => {
    const values: unknown[] = ["A", "abc", "1AB", "AB-C", "ABCDEFGHIJK", 12];
    const form = "ticket-key must be 2–10 characters: an uppercase letter, then uppercase letters or digits";
    let number = 0;
    for (const kind of ["system", "repository"]) {
      for (const value of values) {
        const id = `bad-ticket-key-${number}`;
        number += 1;
        const result = add(kind, id, { description: "Invalid ticket key.", "ticket-key": value }, ["--json"]);
        assert.equal(result.result, 3, `${kind} ${JSON.stringify(value)}`);
        const payload = JSON.parse(result.output.join("\n"));
        const directory = kind === "system" ? "systems" : "repositories";
        assert.equal(payload.error.code, "invalid-entry");
        assert.deepEqual(payload.error.details.errors, [`${directory}/${id}.toml: ${form}`]);
        assert.equal(existsSync(join(root, `${directory}/${id}.toml`)), false);
      }
    }
  });

  test("checks keys, tags, dependencies, and remotes before writing", () => {
    write("repositories/alpha-app.toml", 'description = "Alpha application."\nkey = "NBR"\n');
    const cases = [
      { id: "bad-key", data: { description: "Example.", key: "not-valid" }, error: "key must be" },
      { id: "duplicate-key", data: { description: "Example.", key: "NBR" }, error: "duplicate key" },
      { id: "bad-tag", data: { description: "Example.", tags: ["unknown"] }, error: "tag" },
      { id: "bad-dependency", data: { description: "Example.", "depends-on": [{ id: "missing" }] }, error: "does not exist" },
      { id: "system-dependency", data: { description: "Example.", "depends-on": [{ id: "alpha" }] }, error: "not a repository or external" },
      { id: "bad-remote", data: { description: "Example.", remote: "https://user:token@example.com/repo.git" }, error: "remote must not contain credentials" },
    ];
    for (const item of cases) {
      const result = add("repository", item.id, item.data, ["--json"]);
      assert.equal(result.result, 3, item.id);
      assert.ok(JSON.stringify(JSON.parse(result.output.join("\\n"))).includes(item.error), item.id);
      assert.equal(existsSync(join(root, `repositories/${item.id}.toml`)), false);
    }
  });

  test("adds a checked repository path and keeps catalog files ignored and unstaged", () => {
    const localRepository = join(temporary, "local-repository");
    mkdirSync(localRepository);
    execFileSync("git", ["init", "-q", localRepository]);
    const remote = "https://example.com/team/new-repository.git";
    execFileSync("git", ["-C", localRepository, "remote", "add", "origin", remote]);
    const result = add(
      "repository",
      "path-repository",
      { description: "A local repository.", remote },
      ["--local-path", localRepository, "--json"],
    );
    assert.equal(result.result, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(parseToml(readFileSync(join(root, "local/paths.toml"), "utf8")))),  {
      "path-repository": localRepository,
    });
    assert.equal(
      execFileSync("git", ["-C", root, "check-ignore", "repositories/path-repository.toml"], { encoding: "utf8" }).trim(),
      "repositories/path-repository.toml",
    );
    assert.equal(
      execFileSync("git", ["-C", root, "check-ignore", "local/paths.toml"], { encoding: "utf8" }).trim(),
      "local/paths.toml",
    );
    execFileSync("git", ["-C", root, "diff", "--cached", "--quiet"]);
  });

  test("appends a local path without changing existing comments or formatting", () => {
    const existingRepository = join(temporary, "existing-path-repository");
    mkdirSync(existingRepository);
    execFileSync("git", ["init", "-q", existingRepository]);
    const newRepository = join(temporary, "new-path-repository");
    mkdirSync(newRepository);
    execFileSync("git", ["init", "-q", newRepository]);
    const original = `# Existing paths\n\n"alpha-app" = ${JSON.stringify(existingRepository)}\n`;
    write("local/paths.toml", original);

    const result = add(
      "repository",
      "path-preservation",
      { description: "Preserves local path text." },
      ["--local-path", newRepository],
    );
    assert.equal(result.result, 0, JSON.stringify({ output: result.output, errors: result.errors }));
    assert.equal(
      readFileSync(join(root, "local/paths.toml"), "utf8"),
      `${original}path-preservation = ${JSON.stringify(newRepository)}\n`,
    );
  });

  test("adds a newline before appending and keeps the paths file parseable", () => {
    const existingRepository = join(temporary, "existing-path-repository");
    mkdirSync(existingRepository);
    execFileSync("git", ["init", "-q", existingRepository]);
    const newRepository = join(temporary, "new-path-repository");
    mkdirSync(newRepository);
    execFileSync("git", ["init", "-q", newRepository]);
    const original = `# Existing path\n"alpha-app" = ${JSON.stringify(existingRepository)}`;
    write("local/paths.toml", original);

    const result = add(
      "repository",
      "newline-path",
      { description: "Adds a local path." },
      ["--local-path", newRepository],
    );
    const pathsText = readFileSync(join(root, "local/paths.toml"), "utf8");
    assert.equal(result.result, 0, JSON.stringify({ output: result.output, errors: result.errors }));
    assert.equal(pathsText, `${original}\nnewline-path = ${JSON.stringify(newRepository)}\n`);
    assert.deepEqual(JSON.parse(JSON.stringify(parseToml(pathsText))), {
      "alpha-app": existingRepository,
      "newline-path": newRepository,
    });
  });

  test("replaces a stale local path and reports a warning in JSON", () => {
    const localRepository = join(temporary, "replacement-repository");
    mkdirSync(localRepository);
    execFileSync("git", ["init", "-q", localRepository]);
    const original = 'stale-json = "/old"  # note\n';
    write("local/paths.toml", original);

    const result = add(
      "repository",
      "stale-json",
      { description: "Replaces a stale local path." },
      ["--local-path", localRepository, "--json"],
    );
    const payload = JSON.parse(result.output.join("\\n"));
    assert.equal(result.result, 0);
    assert.equal(readFileSync(join(root, "local/paths.toml"), "utf8"), `stale-json = ${JSON.stringify(localRepository)}  # note\n`);
    assert.deepEqual(payload.validation.warnings, ['replaced the existing local path for "stale-json" in local/paths.toml']);
    assert.equal(capture(() => main(["check"], root)).result, 0);
  });

  test("keeps BOM, quoted key, comment, and CRLF when replacing a path", () => {
    const oldRepository = join(temporary, "old-bom-repository");
    const newRepository = join(temporary, "new-bom-repository");
    for (const repository of [oldRepository, newRepository]) {
      mkdirSync(repository);
      execFileSync("git", ["init", "-q", repository]);
    }
    const original = `\uFEFF"bom-path" = ${JSON.stringify(oldRepository)} # note\r\n`;
    write("local/paths.toml", original);

    const result = add(
      "repository",
      "bom-path",
      { description: "Keeps path file formatting." },
      ["--local-path", newRepository, "--json"],
    );
    const payload = JSON.parse(result.output.join("\\n"));
    assert.equal(result.result, 0);
    assert.equal(
      readFileSync(join(root, "local/paths.toml"), "utf8"),
      `\uFEFF"bom-path" = ${JSON.stringify(newRepository)} # note\r\n`,
    );
    assert.deepEqual(payload.validation.warnings, ['replaced the existing local path for "bom-path" in local/paths.toml']);
  });

  test("keeps CRLF when it appends a local path", () => {
    const existingRepository = join(temporary, "existing-crlf-repository");
    const newRepository = join(temporary, "new-crlf-repository");
    for (const repository of [existingRepository, newRepository]) {
      mkdirSync(repository);
      execFileSync("git", ["init", "-q", repository]);
    }
    const original = `# Existing paths\r\n"alpha-app" = ${JSON.stringify(existingRepository)}\r\n`;
    write("local/paths.toml", original);

    const result = add(
      "repository",
      "crlf-path",
      { description: "Keeps CRLF line endings." },
      ["--local-path", newRepository],
    );
    assert.equal(result.result, 0, JSON.stringify({ output: result.output, errors: result.errors }));
    assert.equal(
      readFileSync(join(root, "local/paths.toml"), "utf8"),
      `${original}crlf-path = ${JSON.stringify(newRepository)}\r\n`,
    );
  });

  test("reports a stale local path warning in text", () => {
    const localRepository = join(temporary, "replacement-repository");
    mkdirSync(localRepository);
    execFileSync("git", ["init", "-q", localRepository]);
    write("local/paths.toml", 'stale-text = "/old"  # note\n');

    const result = add(
      "repository",
      "stale-text",
      { description: "Replaces a stale local path." },
      ["--local-path", localRepository],
    );
    assert.equal(result.result, 0);
    assert.ok(result.output.includes('WARNING: replaced the existing local path for "stale-text" in local/paths.toml'));
    assert.equal(capture(() => main(["check"], root)).result, 0);
  });

  test("rejects dotted, table, multi-line, and duplicate stale mappings without writing", () => {
    const localRepository = join(temporary, "invalid-mapping-repository");
    mkdirSync(localRepository);
    execFileSync("git", ["init", "-q", localRepository]);
    const cases = [
      { id: "dotted-path", text: '"dotted-path".x = "/old"\n' },
      { id: "table-path", text: '[table-path]\npath = "/old"\n' },
      { id: "multiline-path", text: 'multiline-path = """old\npath"""\n' },
      { id: "duplicate-path", text: 'duplicate-path = "/old"\nduplicate-path = "/other"\n' },
    ];
    for (const { id, text } of cases) {
      write("local/paths.toml", text);
      const result = add(
        "repository",
        id,
        { description: "Rejects an unsafe local path mapping." },
        ["--local-path", localRepository, "--json"],
      );
      const payload = JSON.parse(result.output.join("\\n"));
      assert.equal(result.result, 3, id);
      assert.deepEqual(payload.error.details.errors, [
        `local/paths.toml: cannot replace the existing local path for ${JSON.stringify(id)}; edit the file by hand`,
      ]);
      assert.equal(readFileSync(join(root, "local/paths.toml"), "utf8"), text);
      assert.equal(existsSync(join(root, `repositories/${id}.toml`)), false);
    }
  });

  test("does not replace a path-like key inside a table section", () => {
    const original = '[other]\nsection-path = "/old"\n';
    write("local/paths.toml", original);

    const result = new TomlStore(root).createEntry(
      "repository",
      "section-path",
      { description: "Does not replace a nested path." },
      "/work/new",
    );
    assert.equal(result.status, "invalid");
    assert.equal(readFileSync(join(root, "local/paths.toml"), "utf8"), original);
    assert.equal(existsSync(join(root, "repositories/section-path.toml")), false);
  });

  test("does not rewrite target-like text inside a multi-line string", () => {
    const original = 'b = """\nhidden-path = "/old"\n"""\n';
    write("local/paths.toml", original);

    const result = new TomlStore(root).createEntry(
      "repository",
      "hidden-path",
      { description: "Ignores text inside a string." },
      "/work/new",
    );
    assert.equal(result.status, "created");
    if (result.status !== "created") return;
    assert.deepEqual(result.warnings, []);
    assert.equal(readFileSync(join(root, "local/paths.toml"), "utf8"), `${original}hidden-path = "/work/new"\n`);
  });

  test("does not append a path inside a table section", () => {
    const original = 'b = "/x"\n[meta]\nv = 1';
    write("local/paths.toml", original);

    const result = new TomlStore(root).createEntry(
      "repository",
      "new-after-section",
      { description: "Does not append inside a table." },
      "/work/new",
    );
    assert.equal(result.status, "invalid");
    assert.equal(readFileSync(join(root, "local/paths.toml"), "utf8"), original);
    assert.equal(existsSync(join(root, "repositories/new-after-section.toml")), false);
  });

  test("keeps the existing mapping and skips the warning when the path is unchanged", () => {
    const localRepository = join(temporary, "same-path-repository");
    mkdirSync(localRepository);
    execFileSync("git", ["init", "-q", localRepository]);
    const original = `"same-path" = ${JSON.stringify(localRepository)} # note\n`;
    write("local/paths.toml", original);

    const result = add(
      "repository",
      "same-path",
      { description: "Keeps the existing local path." },
      ["--local-path", localRepository, "--json"],
    );
    const payload = JSON.parse(result.output.join("\\n"));
    assert.equal(result.result, 0);
    assert.deepEqual(payload.validation.warnings, []);
    assert.equal(readFileSync(join(root, "local/paths.toml"), "utf8"), original);
  });

  test("restores appended path text exactly after remote mismatch", () => {
    const existingRepository = join(temporary, "existing-path-repository");
    mkdirSync(existingRepository);
    execFileSync("git", ["init", "-q", existingRepository]);
    const mismatchedRepository = join(temporary, "mismatched-repository");
    mkdirSync(mismatchedRepository);
    execFileSync("git", ["init", "-q", mismatchedRepository]);
    execFileSync("git", ["-C", mismatchedRepository, "remote", "add", "origin", "https://example.com/other.git"]);
    const original = `# Existing paths\n\n"alpha-app" = ${JSON.stringify(existingRepository)}\n`;
    write("local/paths.toml", original);

    const result = add(
      "repository",
      "rollback-append",
      { description: "Rolls back an appended path.", remote: "https://example.com/wanted.git" },
      ["--local-path", mismatchedRepository, "--json"],
    );
    const payload = JSON.parse(result.output.join("\\n"));
    assert.equal(result.result, 3);
    assert.ok(payload.error.details.errors.some((error: string) => error.includes("remote does not match")));
    assert.equal(readFileSync(join(root, "local/paths.toml"), "utf8"), original);
    assert.equal(existsSync(join(root, "repositories/rollback-append.toml")), false);
  });

  test("restores replaced path text exactly after remote mismatch", () => {
    const mismatchedRepository = join(temporary, "mismatched-repository");
    mkdirSync(mismatchedRepository);
    execFileSync("git", ["init", "-q", mismatchedRepository]);
    execFileSync("git", ["-C", mismatchedRepository, "remote", "add", "origin", "https://example.com/other.git"]);
    const original = 'rollback-replace = "/old"  # note\n';
    write("local/paths.toml", original);

    const result = add(
      "repository",
      "rollback-replace",
      { description: "Rolls back a replaced path.", remote: "https://example.com/wanted.git" },
      ["--local-path", mismatchedRepository, "--json"],
    );
    const payload = JSON.parse(result.output.join("\\n"));
    assert.equal(result.result, 3);
    assert.ok(payload.error.details.errors.some((error: string) => error.includes("remote does not match")));
    assert.equal(readFileSync(join(root, "local/paths.toml"), "utf8"), original);
    assert.equal(existsSync(join(root, "repositories/rollback-replace.toml")), false);
  });

  test("rolls back a failed path check and restores an existing map exactly", () => {
    const localRepository = join(temporary, "existing-repository");
    mkdirSync(localRepository);
    execFileSync("git", ["init", "-q", localRepository]);
    const original = `alpha-app = ${JSON.stringify(localRepository)}\n`;
    write("local/paths.toml", original);
    const result = add(
      "repository",
      "rollback-repository",
      { description: "Has an invalid local path." },
      ["--local-path", join(temporary, "missing-repository"), "--json"],
    );
    const payload = JSON.parse(result.output.join("\\n"));
    assert.equal(result.result, 3);
    assert.equal(payload.error.code, "invalid-entry");
    assert.equal(payload.error.message, "could not add repository rollback-repository: validation failed");
    assert.ok(payload.error.details.errors.some((error: string) => error.includes("path does not exist")));
    assert.equal(existsSync(join(root, "repositories/rollback-repository.toml")), false);
    assert.equal(readFileSync(join(root, "local/paths.toml"), "utf8"), original);
  });

  test("removes a new path map after validation fails", () => {
    assert.equal(existsSync(join(root, "local/paths.toml")), false);
    const result = add(
      "repository",
      "rollback-without-map",
      { description: "Has an invalid local path." },
      ["--local-path", join(temporary, "missing-repository"), "--json"],
    );
    assert.equal(result.result, 3);
    assert.equal(existsSync(join(root, "repositories/rollback-without-map.toml")), false);
    assert.equal(existsSync(join(root, "local/paths.toml")), false);
  });

  test("rolls back a local path whose Git remote does not match", () => {
    const localRepository = join(temporary, "mismatched-repository");
    mkdirSync(localRepository);
    execFileSync("git", ["init", "-q", localRepository]);
    execFileSync("git", ["-C", localRepository, "remote", "add", "origin", "https://example.com/other.git"]);
    const result = add(
      "repository",
      "remote-mismatch",
      { description: "Has a remote mismatch.", remote: "https://example.com/wanted.git" },
      ["--local-path", localRepository, "--json"],
    );
    const payload = JSON.parse(result.output.join("\\n"));
    assert.equal(result.result, 3);
    assert.ok(payload.error.details.errors.some((error: string) => error.includes("remote does not match")));
    assert.equal(existsSync(join(root, "repositories/remote-mismatch.toml")), false);
    assert.equal(existsSync(join(root, "local/paths.toml")), false);
  });

  test("adds repository tags and appends them without changing prior tag text", () => {
    const originalTags = readFileSync(join(root, "tags.toml"), "utf8");
    const result = add(
      "repository",
      "demo",
      { description: "Demo.", tags: ["data-pipeline"] },
      ["--new-tag", "data-pipeline=Moves data between systems."],
    );
    assert.equal(result.result, 0, JSON.stringify({ output: result.output, errors: result.errors }));
    assert.equal(
      readFileSync(join(root, "tags.toml"), "utf8"),
      `${originalTags}data-pipeline = "Moves data between systems."\n`,
    );
    assert.equal(existsSync(join(root, "repositories/demo.toml")), true);
    assert.equal(capture(() => main(["check"], root)).result, 0);
    assert.ok(result.output.some((line) => line.includes("New tags: data-pipeline. The shared tag list has uncommitted changes.")));
  });

  test("adds a separator when tags.toml has no final newline", () => {
    const originalTags = 'utility = "Shared tools."\nlibrary = "Reusable code."';
    write("tags.toml", originalTags);
    const result = add(
      "repository",
      "newline-tag",
      { description: "Newline tag.", tags: ["data-pipeline"] },
      ["--new-tag", "data-pipeline=Moves data."],
    );
    assert.equal(result.result, 0, JSON.stringify({ output: result.output, errors: result.errors }));
    assert.equal(
      readFileSync(join(root, "tags.toml"), "utf8"),
      `${originalTags}\ndata-pipeline = "Moves data."\n`,
    );
  });

  test("rejects an undefined tag without --new-tag and writes nothing", () => {
    const originalTags = readFileSync(join(root, "tags.toml"), "utf8");
    const result = add("repository", "missing-tag", { description: "Missing tag.", tags: ["data-pipeline"] }, ["--json"]);
    const payload = JSON.parse(result.output.join("\\n"));
    assert.equal(result.result, 3);
    assert.ok(payload.error.details.errors.includes('repositories/missing-tag.toml: tag "data-pipeline" is not defined in tags.toml'));
    assert.equal(existsSync(join(root, "repositories/missing-tag.toml")), false);
    assert.equal(readFileSync(join(root, "tags.toml"), "utf8"), originalTags);
    assert.equal(existsSync(join(root, "local/paths.toml")), false);
  });

  test("rejects invalid and already-defined new tags without writing", () => {
    write("tags.toml", 'utility = "Shared tools."\nlibrary = "Reusable code."\nconstructor = "Builds things."\n');
    const originalTags = readFileSync(join(root, "tags.toml"), "utf8");
    const cases = [
      { id: "bad-tag-case", name: "Data_Pipeline", tags: ["Data_Pipeline"] },
      { id: "inherited-tag", name: "toString", tags: ["toString"] },
      { id: "existing-utility", name: "utility", tags: ["utility"] },
      { id: "existing-constructor", name: "constructor", tags: ["constructor"] },
      { id: "unused-tag", name: "unused-tag", tags: [] },
    ];
    for (const item of cases) {
      const result = add(
        "repository",
        item.id,
        { description: "Invalid new tag.", tags: item.tags },
        ["--new-tag", `${item.name}=New description.`, "--json"],
      );
      assert.equal(result.result, 3, item.name);
      assert.equal(existsSync(join(root, `repositories/${item.id}.toml`)), false);
      assert.equal(readFileSync(join(root, "tags.toml"), "utf8"), originalTags);
    }
  });

  test("rejects invalid --new-tag usage without writing files", () => {
    const originalTags = readFileSync(join(root, "tags.toml"), "utf8");
    const cases = [
      { kind: "system", id: "tag-system", extra: ["--new-tag", "new-tag=Description."] },
      { kind: "external", id: "tag-external", extra: ["--new-tag", "new-tag=Description."] },
      { kind: "repository", id: "missing-equals", extra: ["--new-tag", "new-tag"] },
      { kind: "repository", id: "empty-name", extra: ["--new-tag", "=Description."] },
      { kind: "repository", id: "empty-description", extra: ["--new-tag", "new-tag="] },
      {
        kind: "repository",
        id: "duplicate-tag",
        extra: ["--new-tag", "new-tag=First.", "--new-tag", "new-tag=Second."],
      },
    ];
    for (const item of cases) {
      const result = add(item.kind, item.id, { description: "Usage error." }, item.extra);
      assert.equal(result.result, 1, item.id);
      assert.equal(existsSync(join(root, `${item.kind === "system" ? "systems" : item.kind === "external" ? "externals" : "repositories"}/${item.id}.toml`)), false);
      assert.equal(readFileSync(join(root, "tags.toml"), "utf8"), originalTags);
      assert.equal(existsSync(join(root, "local/paths.toml")), false);
    }
  });

  test("restores tags and local paths after a remote mismatch", () => {
    const existingRepository = join(temporary, "existing-repository");
    mkdirSync(existingRepository);
    execFileSync("git", ["init", "-q", existingRepository]);
    const originalPaths = `# Existing path\nalpha-app = ${JSON.stringify(existingRepository)}\n`;
    write("local/paths.toml", originalPaths);
    const originalTags = readFileSync(join(root, "tags.toml"), "utf8");

    const mismatchedRepository = join(temporary, "mismatched-repository");
    mkdirSync(mismatchedRepository);
    execFileSync("git", ["init", "-q", mismatchedRepository]);
    execFileSync("git", ["-C", mismatchedRepository, "remote", "add", "origin", "https://example.com/other.git"]);
    const result = add(
      "repository",
      "rollback-new-tag",
      { description: "Rollback.", remote: "https://example.com/wanted.git", tags: ["data-pipeline"] },
      ["--local-path", mismatchedRepository, "--new-tag", "data-pipeline=Moves data."],
    );
    assert.equal(result.result, 3);
    assert.ok(result.errors.join("\\n").includes("remote does not match"));
    assert.equal(existsSync(join(root, "repositories/rollback-new-tag.toml")), false);
    assert.equal(readFileSync(join(root, "tags.toml"), "utf8"), originalTags);
    assert.equal(readFileSync(join(root, "local/paths.toml"), "utf8"), originalPaths);
  });

  test("escapes a new tag description and returns exact text from show", () => {
    const description = 'Moves "quoted" data with \\ paths, café, and key=value.';
    const result = add(
      "repository",
      "escaped-tag",
      { description, tags: ["escaped-tag"] },
      ["--new-tag", `escaped-tag=${description}`],
    );
    assert.equal(result.result, 0, JSON.stringify({ output: result.output, errors: result.errors }));
    assert.equal(capture(() => main(["check"], root)).result, 0);
    const tags = parseToml(readFileSync(join(root, "tags.toml"), "utf8")) as Record<string, unknown>;
    assert.equal(tags["escaped-tag"], description);
    const shown = capture(() => main(["show", "escaped-tag", "--json"], root));
    assert.equal(shown.result, 0);
    assert.equal(JSON.parse(shown.output.join("\\n")).description, description);
  });

  test("returns new tag names in JSON order without adding a path field", () => {
    const result = add(
      "repository",
      "json-tags",
      { description: "JSON tags.", tags: ["first-tag", "second-tag"] },
      ["--new-tag", "first-tag=First.", "--new-tag", "second-tag=Second.", "--json"],
    );
    const payload = JSON.parse(result.output.join("\\n"));
    assert.equal(result.result, 0);
    assert.deepEqual(payload.new_tags, ["first-tag", "second-tag"]);
    assert.deepEqual(Object.keys(payload), ["ok", "type", "id", "path", "validation", "new_tags"]);
  });

  test("reports text success and JSON argument errors", () => {
    const text = add("external", "text-entry", { description: "Text output." });
    assert.equal(text.result, 0);
    assert.ok(text.output.join("\\n").includes("Created external text-entry at externals/text-entry.toml; validation ok"));

    const jsonError = capture(() => main(["add", "repository", "bad-json-output", "--data", "{", "--json"], root));
    const payload = JSON.parse(jsonError.output.join("\\n"));
    assert.equal(jsonError.result, 1);
    assert.equal(payload.error.code, "usage");
    assert.ok(payload.error.message.includes("not valid JSON"));

    const validationFailure = capture(() => main([
      "add", "repository", "text-path-failure", "--data", '{"description":"Failure output."}',
      "--local-path", join(temporary, "missing-path"),
    ], root));
    assert.equal(validationFailure.result, 3);
    assert.ok(validationFailure.errors.some((line) => line.includes("path does not exist")));
    assert.ok(validationFailure.errors.some((line) => line.includes("validation failed")));
    assert.equal(existsSync(join(root, "repositories/text-path-failure.toml")), false);
  });
});

describe("charts set", () => {
  function update(id: string, data?: unknown, extra: string[] = []) {
    const args = ["set", id];
    if (data !== undefined) args.push("--data", typeof data === "string" ? data : JSON.stringify(data));
    return capture(() => main([...args, ...extra], root));
  }

  test("adds a missing field in template order and keeps all other text", () => {
    const original = '# header\ndescription = "Alpha application."\n# before system\nsystem = "alpha"\ntags = ["utility"]\n# footer\n';
    write("repositories/alpha-app.toml", original);
    const result = update("alpha-app", { key: "NEW" }, ["--json"]);
    const payload = JSON.parse(result.output.join("\\n"));
    assert.equal(result.result, 0, JSON.stringify({ output: result.output, errors: result.errors }));
    assert.deepEqual(payload.changed, ["key"]);
    assert.equal(
      readFileSync(join(root, "repositories/alpha-app.toml"), "utf8"),
      '# header\ndescription = "Alpha application."\nkey = "NEW"\n# before system\nsystem = "alpha"\ntags = ["utility"]\n# footer\n',
    );
  });

  test("replaces a multi-line dependency field and keeps outside comments", () => {
    const original = [
      'description = "Alpha application."',
      'system = "alpha"',
      'tags = ["utility"]',
      "# before dependencies",
      "depends-on = [",
      '  { id = "beta-lib", via = "npm" },',
      '  { id = "stripe", via = "API" },',
      "]",
      "# after dependencies",
      "",
    ].join("\n");
    write("repositories/alpha-app.toml", original);
    const result = update("alpha-app", { "depends-on": [{ id: "beta-lib", via: "pnpm" }] }, ["--json"]);
    assert.equal(result.result, 0, JSON.stringify({ output: result.output, errors: result.errors }));
    assert.equal(
      readFileSync(join(root, "repositories/alpha-app.toml"), "utf8"),
      'description = "Alpha application."\nsystem = "alpha"\ntags = ["utility"]\n# before dependencies\ndepends-on = [{ id = "beta-lib", via = "pnpm" }]\n# after dependencies\n',
    );
  });

  test("refuses unsafe field layouts and leaves each file unchanged", () => {
    const cases = [
      { text: 'description = "One"\ndescription = "Two"\n', reason: "field appears more than once" },
      { text: 'description.extra = "One"\n', reason: "field uses a dotted key" },
      { text: 'description = "One"\n[meta]\nvalue = 1\n', reason: "file contains a table section" },
    ];
    for (const [index, item] of cases.entries()) {
      const id = `unsafe-${index}`;
      const path = `repositories/${id}.toml`;
      write(path, item.text);
      const original = readFileSync(join(root, path), "utf8");
      const store = new TomlStore(root);
      const result = store.updateEntry("repository", id, { description: "Updated." }, ["description"]);
      assert.equal(result.status, "invalid", id);
      if (result.status === "invalid") assert.ok(result.errors.join(" ").includes(item.reason), result.errors.join(" "));
      assert.equal(readFileSync(join(root, path), "utf8"), original);
    }
  });

  test("sets or replaces a repository path and appends a used new tag", () => {
    const work = join(temporary, "set-path");
    mkdirSync(work);
    execFileSync("git", ["init", "-q", work]);
    write("local/paths.toml", 'alpha-app = "/old/path" # keep note\n');
    const pathResult = update("alpha-app", undefined, ["--local-path", work, "--json"]);
    const pathPayload = JSON.parse(pathResult.output.join("\\n"));
    assert.equal(pathResult.result, 0, JSON.stringify({ output: pathResult.output, errors: pathResult.errors }));
    assert.ok(pathPayload.validation.warnings.some((warning: string) => warning.includes("replaced the existing local path")));
    assert.equal(readFileSync(join(root, "local/paths.toml"), "utf8"), `alpha-app = ${JSON.stringify(work)} # keep note\n`);

    const tagResult = update("alpha-app", { tags: ["utility", "data-pipeline"] }, ["--new-tag", "data-pipeline=Moves data.", "--json"]);
    const tagPayload = JSON.parse(tagResult.output.join("\\n"));
    assert.equal(tagResult.result, 0, JSON.stringify({ output: tagResult.output, errors: tagResult.errors }));
    assert.deepEqual(tagPayload.new_tags, ["data-pipeline"]);
    assert.equal((parseToml(readFileSync(join(root, "tags.toml"), "utf8")) as Record<string, unknown>)["data-pipeline"], "Moves data.");
  });

  test("rejects local paths and new tags for non-repositories", () => {
    for (const id of ["alpha", "stripe"]) {
      const pathResult = update(id, undefined, ["--local-path", "/work/example", "--json"]);
      assert.equal(pathResult.result, 1, id);
      assert.ok(JSON.parse(pathResult.output.join("\\n")).error.message.includes("only for a repository"));
      const tagResult = update(id, {}, ["--new-tag", "example-tag=Example.", "--json"]);
      assert.equal(tagResult.result, 1, id);
      assert.ok(JSON.parse(tagResult.output.join("\\n")).error.message.includes("only for a repository"));
    }
  });

  test("rejects an unused new tag without writing", () => {
    const originalEntry = readFileSync(join(root, "repositories/alpha-app.toml"), "utf8");
    const originalTags = readFileSync(join(root, "tags.toml"), "utf8");
    const result = update("alpha-app", {}, ["--new-tag", "unused-tag=Unused.", "--json"]);
    assert.equal(result.result, 3);
    assert.ok(JSON.parse(result.output.join("\\n")).error.details.errors[0].includes("is not used by the entry"));
    assert.equal(readFileSync(join(root, "repositories/alpha-app.toml"), "utf8"), originalEntry);
    assert.equal(readFileSync(join(root, "tags.toml"), "utf8"), originalTags);
  });

  test("rolls back the entry, path map, and tags after full validation fails", () => {
    const originalEntry = readFileSync(join(root, "repositories/alpha-app.toml"), "utf8");
    const originalTags = readFileSync(join(root, "tags.toml"), "utf8");
    const originalPaths = 'alpha-app = "/old/path" # old path\n';
    write("local/paths.toml", originalPaths);
    const work = join(temporary, "wrong-remote");
    mkdirSync(work);
    execFileSync("git", ["init", "-q", work]);
    execFileSync("git", ["-C", work, "remote", "add", "origin", "https://example.com/other.git"]);
    const result = update("alpha-app", { remote: "https://example.com/wanted.git", tags: ["utility", "data-pipeline"] }, [
      "--local-path", work,
      "--new-tag", "data-pipeline=Moves data.",
      "--json",
    ]);
    assert.equal(result.result, 3);
    assert.ok(JSON.parse(result.output.join("\\n")).error.details.errors.some((error: string) => error.includes("remote does not match")));
    assert.equal(readFileSync(join(root, "repositories/alpha-app.toml"), "utf8"), originalEntry);
    assert.equal(readFileSync(join(root, "local/paths.toml"), "utf8"), originalPaths);
    assert.equal(readFileSync(join(root, "tags.toml"), "utf8"), originalTags);
  });

  test("does not overwrite files changed before rollback", () => {
    const store = new TomlStore(root);
    const updated = store.updateEntry(
      "repository",
      "alpha-app",
      { description: "Updated.", tags: ["utility", "data-pipeline"] },
      ["description", "tags"],
      "/work/new-path",
      [{ name: "data-pipeline", description: "Moves data." }],
    );
    assert.equal(updated.status, "updated");
    write("repositories/alpha-app.toml", "external entry change\n");
    write("local/paths.toml", "external path change\n");
    write("tags.toml", "external tag change\n");
    const errors = updated.rollback();
    assert.ok(errors.includes("repositories/alpha-app.toml changed during rollback and was not restored"));
    assert.ok(errors.includes("local/paths.toml changed during rollback and was not restored"));
    assert.ok(errors.includes("tags.toml changed during rollback and was not restored"));
    assert.equal(readFileSync(join(root, "repositories/alpha-app.toml"), "utf8"), "external entry change\n");
    assert.equal(readFileSync(join(root, "local/paths.toml"), "utf8"), "external path change\n");
    assert.equal(readFileSync(join(root, "tags.toml"), "utf8"), "external tag change\n");
  });

  test("reports no change and returns JSON usage errors", () => {
    const noChange = update("alpha-app", { description: "Alpha application." });
    assert.equal(noChange.result, 0);
    assert.ok(noChange.output[0].includes("No change"));
    const emptyData = update("alpha-app", {});
    assert.equal(emptyData.result, 0);
    assert.ok(emptyData.output[0].includes("No change"));

    const noOptions = capture(() => main(["set", "alpha-app", "--json"], root));
    assert.equal(noOptions.result, 1);
    assert.equal(JSON.parse(noOptions.output.join("\\n")).error.code, "usage");
    const missingId = capture(() => main(["set", "--json"], root));
    assert.equal(missingId.result, 1);
    assert.equal(JSON.parse(missingId.output.join("\\n")).error.code, "usage");
    const missingKey = capture(() => main(["set", "alpha-app", "--data", "{}", "--replace-key", "--json"], root));
    assert.equal(missingKey.result, 1);
    assert.ok(JSON.parse(missingKey.output.join("\\n")).error.message.includes("requires key"));
    const repeated = capture(() => main(["set", "alpha-app", "--data", "{}", "--data", "{}", "--json"], root));
    assert.equal(repeated.result, 1);
    assert.ok(JSON.parse(repeated.output.join("\\n")).error.message.includes("used only once"));
    const badJson = capture(() => main(["set", "alpha-app", "--data", "{", "--json"], root));
    assert.equal(badJson.result, 1);
    assert.ok(JSON.parse(badJson.output.join("\\n")).error.message.includes("not valid JSON"));
  });
});

describe("catalog commands", () => {
  test("derives system dependencies from repository dependencies", () => {
    const catalog = new CatalogIndex(new TomlStore(root).load());
    const result = dependenciesFor(catalog, catalog.get("alpha")!);
    assert.deepEqual(result.system_dependencies, [
      { id: "beta", type: "system", via_repositories: ["alpha-app"] },
    ]);
    assert.deepEqual((result.dependencies as Array<{ id: string }>).map((edge) => edge.id), ["beta-lib", "stripe"]);
  });

  test("finds reverse dependencies for repositories, externals, and systems", () => {
    const catalog = new CatalogIndex(new TomlStore(root).load());
    const repository = reverseDependencies(catalog, catalog.get("beta-lib")!);
    const external = reverseDependencies(catalog, catalog.get("stripe")!);
    const system = reverseDependencies(catalog, catalog.get("beta")!);

    assert.deepEqual(new Set((repository.dependents as Array<{ id: string }>).map((item) => item.id)), new Set(["alpha-app", "gamma-app"]));
    assert.deepEqual((external.dependents as Array<{ id: string }>).map((item) => item.id), ["alpha-app"]);
    assert.deepEqual(
      new Set((system.dependents as Array<{ id: string; type: string }>).map((item) => `${item.type}:${item.id}`)),
      new Set(["repository:alpha-app", "repository:gamma-app", "system:alpha", "system:gamma"]),
    );
  });

  test("does not show an unchecked local path", () => {
    const work = join(root, "local-work");
    mkdirSync(work);
    execFileSync("git", ["init", "-q", work]);
    write("local/paths.toml", `alpha-app = "${work}"\n`);
    const result = showEntry({ index: new CatalogIndex(new TomlStore(root).load()), git: new GitCli(root) }, new CatalogIndex(new TomlStore(root).load()).get("alpha-app")!);
    assert.equal(result.local_path, work);
    assert.equal(result.local_path_status, "ok");
  });

  test("returns JSON from find", () => {
    const { result, output } = capture(() => main(["find", "alpha", "--json"], root));
    const payload = JSON.parse(output.join("\n"));
    assert.equal(result, 0);
    assert.deepEqual(payload.entries.map((entry: { id: string }) => entry.id), ["alpha-app", "alpha"]);
  });

  test("matches externals without a status as active", () => {
    write("externals/old-api.toml", 'description = "Retired API."\nstatus = "archived"\n');
    const { result, output } = capture(() => main(["find", "--status", "active", "--json"], root));
    const payload = JSON.parse(output.join("\n"));
    assert.equal(result, 0);
    const externals = payload.entries.filter((entry: { type: string }) => entry.type === "external");
    assert.deepEqual(externals.map((entry: { id: string }) => entry.id), ["stripe"]);
  });

  test("lists archived externals in the status filter", () => {
    write("externals/old-api.toml", 'description = "Retired API."\nstatus = "archived"\n');
    const { result, output } = capture(() => main(["find", "--status", "archived"], root));
    assert.equal(result, 0);
    assert.deepEqual(output, ["external old-api — old-api — Retired API."]);
  });

  test("rejects deps for external entries", () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
    try {
      assert.equal(main(["deps", "stripe"], root), 1);
    } finally {
      console.error = original;
    }
    assert.ok(errors[0].includes("not external entries"));
  });

  /** Copies the command and its code into the fixture, whose catalog Git ignores. */
  function installCommand(): void {
    for (const folder of ["bin", "scripts", "src"]) cpSync(join(REPO_ROOT, folder), join(root, folder), { recursive: true });
    copyFileSync(join(REPO_ROOT, "package.json"), join(root, "package.json"));
    symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  }

  /** Runs the `charts` command through a symbolic link, from a folder outside Charts. */
  function runLinked(args: string[]) {
    const binFolder = join(temporary, "local-bin");
    mkdirSync(binFolder, { recursive: true });
    const link = join(binFolder, "charts");
    rmSync(link, { force: true });
    symlinkSync(join(root, "bin/charts.js"), link);
    const cwd = join(temporary, "elsewhere");
    mkdirSync(cwd, { recursive: true });
    return spawnSync(link, args, { cwd, encoding: "utf8" });
  }

  test("the charts command runs through a symbolic link from another folder like the script", () => {
    installCommand();
    const linked = runLinked(["find", "--json"]);
    const script = spawnSync(process.execPath, [realpathSync(join(root, "scripts/charts.ts")), "find", "--json"], { cwd: root, encoding: "utf8" });
    assert.equal(script.status, 0, script.stderr);
    assert.equal(linked.status, 0, linked.stdout + linked.stderr);
    assert.equal(linked.stderr, "");
    assert.equal(linked.stdout, script.stdout);
    // main runs exactly once: one JSON document.
    assert.equal(JSON.parse(linked.stdout).entries.length, 7);

    const failed = runLinked(["show", "missing", "--json"]);
    assert.equal(failed.status, 2, failed.stdout + failed.stderr);
    assert.equal(JSON.parse(failed.stdout).error.code, "entry-not-found");
  });

  test("the charts command fails with unsupported-runtime below engines before it loads Charts", () => {
    installCommand();
    const manifest = join(root, "package.json");
    writeFileSync(manifest, readFileSync(manifest, "utf8").replace('"node": ">=26"', '"node": ">=999.1"'));
    // If the command loaded Charts, this would fail differently.
    writeFileSync(join(root, "scripts/charts.ts"), 'throw new Error("Charts was loaded");\n');
    const running = process.versions.node;
    const message = `charts needs Node 999.1.0 or later, but this is Node ${running}`;

    const json = runLinked(["find", "--json"]);
    assert.equal(json.status, 4, json.stdout + json.stderr);
    assert.equal(json.stderr, "");
    assert.deepEqual(JSON.parse(json.stdout), {
      error: { code: "unsupported-runtime", message, details: { required: "999.1.0", running } },
    });

    const text = runLinked(["find"]);
    assert.equal(text.status, 4, text.stdout + text.stderr);
    assert.equal(text.stdout, "");
    assert.equal(text.stderr, `ERROR: ${message}\n`);
  });

  test("resolves the catalog root when run from another directory", () => {
    // The catalog is git-ignored, so run a copy of the script inside the fixture.
    mkdirSync(join(root, "scripts"));
    copyFileSync(join(REPO_ROOT, "scripts/charts.ts"), join(root, "scripts/charts.ts"));
    cpSync(join(REPO_ROOT, "src"), join(root, "src"), { recursive: true });
    symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
    const otherDirectory = mkdtempSync(join(tmpdir(), "charts-cwd-"));
    try {
      const output = execFileSync(
        process.execPath,
        [realpathSync(join(root, "scripts/charts.ts")), "find", "alpha-app", "--json"],
        { cwd: otherDirectory, encoding: "utf8" },
      );
      const payload = JSON.parse(output);
      assert.ok(payload.entries.some((entry: { id: string }) => entry.id === "alpha-app"));
    } finally {
      rmSync(otherDirectory, { recursive: true, force: true });
    }
  });
});

describe("typed errors", () => {
  /** Runs a command with and without --json and returns both outcomes. */
  function both(argv: string[]) {
    return { json: capture(() => main([...argv, "--json"], root)), text: capture(() => main(argv, root)) };
  }

  /** Checks the error object on stdout with --json, the message on stderr without, and the exit code. */
  function assertError(argv: string[], code: string, exitCode: number, message: string) {
    const { json, text } = both(argv);
    assert.equal(json.result, exitCode, argv.join(" "));
    assert.deepEqual(json.errors, []);
    const payload = JSON.parse(json.output.join("\n"));
    assert.deepEqual(Object.keys(payload), ["error"]);
    assert.deepEqual(Object.keys(payload.error), ["code", "message", "details"]);
    assert.equal(payload.error.code, code);
    assert.equal(payload.error.message, message);
    assert.equal(text.result, exitCode, argv.join(" "));
    assert.equal(text.errors.at(-1), `ERROR: ${message}`);
    return payload.error;
  }

  test("a usage error exits with 1", () => {
    assertError(["show", "alpha", "--verbose"], "usage", 1, "unknown option: --verbose");
  });

  test("a missing entry exits with 2", () => {
    assertError(["show", "missing"], "entry-not-found", 2, "unknown entry ID: missing");
  });

  test("a refusal exits with 3", () => {
    writeFileSync(join(root, ".gitignore"), "/repositories/*.toml\n/externals/*.toml\n/local/paths.toml\n", "utf8");
    const error = assertError(
      ["add", "system", "unignored", "--data", '{"description":"Unignored."}'],
      "refused",
      3,
      "could not add system unignored: systems/unignored.toml is not ignored by Git",
    );
    assert.deepEqual(error.details.errors, ["systems/unignored.toml is not ignored by Git"]);
    assert.equal(existsSync(join(root, "systems/unignored.toml")), false);
  });

  test("a failed catalog write exits with 4", (context) => {
    if (process.getuid?.() === 0) return context.skip("root can write to a read-only folder");
    chmodSync(join(root, "systems"), 0o555);
    try {
      const { json, text } = both(["add", "system", "unwritable", "--data", '{"description":"Unwritable."}']);
      for (const outcome of [json, text]) assert.equal(outcome.result, 4);
      const payload = JSON.parse(json.output.join("\n"));
      assert.equal(payload.error.code, "external");
      assert.match(payload.error.message, /^could not add system unwritable: /);
      assert.ok(payload.error.details.errors.length > 0);
      assert.match(text.errors.at(-1)!, /^ERROR: could not add system unwritable: /);
    } finally {
      chmodSync(join(root, "systems"), 0o755);
    }
  });

  test("show, deps, and rdeps give entry-not-found with the ID for an unknown ID", () => {
    for (const command of ["show", "deps", "rdeps"]) {
      const error = assertError([command, "missing"], "entry-not-found", 2, "unknown entry ID: missing");
      assert.deepEqual(error.details, { id: "missing" }, command);
    }
  });

  test("add and set give invalid-entry with the validation errors and warnings", () => {
    write("externals/old-api.toml", 'description = "Retired API."\nstatus = "archived"\n');
    const added = assertError(
      ["add", "repository", "bad-repo", "--data", JSON.stringify({ description: "Bad.", tags: ["unknown"], "depends-on": [{ id: "old-api" }] })],
      "invalid-entry",
      3,
      "could not add repository bad-repo: validation failed",
    );
    assert.deepEqual(added.details, {
      errors: ['repositories/bad-repo.toml: tag "unknown" is not defined in tags.toml'],
      warnings: ['repositories/bad-repo.toml: depends-on[0] points to archived entry "old-api"'],
    });
    const updated = assertError(
      ["set", "beta-lib", "--data", JSON.stringify({ system: "missing" })],
      "invalid-entry",
      3,
      "could not set repository beta-lib: validation failed",
    );
    assert.deepEqual(updated.details, { errors: ['repositories/beta-lib.toml: system "missing" does not name a system'], warnings: [] });
  });

  test("deps on an external entry is a usage error with the ID", () => {
    const error = assertError(["deps", "stripe"], "usage", 1, "deps supports repositories and systems, not external entries: stripe");
    assert.deepEqual(error.details, { id: "stripe" });
  });

  test("an error that is not a Charts error is external", () => {
    const json = capture(() => renderError(true, new Error("disk full")));
    assert.equal(json.result, 4);
    assert.deepEqual(JSON.parse(json.output.join("\n")), { error: { code: "external", message: "disk full", details: {} } });
    const text = capture(() => renderError(false, "odd"));
    assert.deepEqual([text.result, text.output, text.errors], [4, [], ["ERROR: odd"]]);
  });
});
