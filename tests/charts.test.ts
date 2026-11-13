import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";
import { parse as parseToml } from "smol-toml";
import { main } from "../scripts/charts.ts";
import { GitCli } from "../src/adapters/git-cli.ts";
import { TomlStore } from "../src/adapters/toml-store.ts";
import { checkCatalog as validateCatalog } from "../src/commands/check.ts";
import { showEntry } from "../src/commands/show.ts";
import { CatalogIndex } from "../src/domain/catalog.ts";
import { dependenciesFor, reverseDependencies } from "../src/domain/dependencies.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(REPO_ROOT, "node_modules/.bin/tsx");

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

  test("prints check results as JSON and returns non-zero on errors", () => {
    const valid = capture(() => main(["check", "--json"], root));
    const validPayload = JSON.parse(valid.output.join("\n"));
    assert.equal(valid.result, 0);
    assert.equal(validPayload.ok, true);
    assert.ok(Array.isArray(validPayload.warnings));

    write("repositories/invalid-status.toml", 'description = "Invalid status."\nstatus = "paused"\n');
    const invalid = capture(() => main(["check", "--json"], root));
    const invalidPayload = JSON.parse(invalid.output.join("\n"));
    assert.equal(invalid.result, 1);
    assert.equal(invalidPayload.ok, false);
    assert.ok(invalidPayload.errors.length > 0);
  });
});

describe("charts add", () => {
  function add(kind: string, id: string, data: unknown, extra: string[] = []) {
    const dataText = typeof data === "string" ? data : JSON.stringify(data);
    return capture(() => main(["add", kind, id, "--data", dataText, ...extra], root));
  }

  test("creates each entry type from its template with only supplied values", () => {
    const systemData = { name: 'Quoted "System"', description: "Line one.\nLine two." };
    const system = add("system", "new-system", systemData, ["--json"]);
    const systemPayload = JSON.parse(system.output.join("\\n"));
    assert.equal(system.result, 0, JSON.stringify({ output: system.output, errors: system.errors }));
    assert.equal(systemPayload.type, "system");
    assert.equal(systemPayload.id, "new-system");
    assert.equal(systemPayload.path, "systems/new-system.toml");
    assert.equal(systemPayload.validation.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(parseToml(readFileSync(join(root, systemPayload.path), "utf8")))), systemData);
    assert.ok(!readFileSync(join(root, systemPayload.path), "utf8").includes("Display name"));

    const repoData = {
      description: 'Uses a "quoted" name.\nSecond line.',
      key: "NEW",
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
    const cases: Array<{ kind: string; id: string; data: unknown; expected: string }> = [
      { kind: "invalid", id: "new-entry", data: { description: "Example." }, expected: "invalid entry type" },
      { kind: "system", id: "Bad_ID", data: { description: "Example." }, expected: "invalid ID" },
      { kind: "system", id: "missing-description", data: { name: "No description" }, expected: "missing required field: description" },
      { kind: "system", id: "unknown-field", data: { description: "Example.", extra: true }, expected: "unknown field(s): extra" },
      { kind: "system", id: "bad-status", data: { description: "Example.", status: "paused" }, expected: "invalid status" },
      { kind: "system", id: "bad-name", data: { description: "Example.", name: false }, expected: "name must be a string" },
      { kind: "system", id: "id-in-data", data: { id: "wrong", description: "Example." }, expected: "do not include id" },
    ];
    for (const item of cases) {
      const result = add(item.kind, item.id, item.data, ["--json"]);
      assert.equal(result.result, 2, JSON.stringify(item));
      assert.ok(result.output.join("\\n").includes(item.expected), result.output.join("\\n"));
      for (const directory of ["systems", "repositories", "externals"]) {
        assert.equal(existsSync(join(root, directory, `${item.id}.toml`)), false);
      }
    }

    const malformed = capture(() => main(["add", "system", "bad-json", "--data", "{", "--json"], root));
    assert.equal(malformed.result, 2);
    assert.ok(JSON.parse(malformed.output.join("\\n")).error.includes("not valid JSON"));
    assert.equal(existsSync(join(root, "systems/bad-json.toml")), false);

    for (const value of ["[]", "null", '"text"']) {
      const result = capture(() => main(["add", "system", "not-object", "--data", value, "--json"], root));
      assert.equal(result.result, 2);
      assert.ok(JSON.parse(result.output.join("\\n")).error.includes("JSON object"));
      assert.equal(existsSync(join(root, "systems/not-object.toml")), false);
    }

    const invalidLocalPath = capture(() => main([
      "add", "external", "external-path", "--data", '{"description":"Example."}', "--local-path", "/tmp/work", "--json",
    ], root));
    assert.equal(invalidLocalPath.result, 2);
    assert.ok(JSON.parse(invalidLocalPath.output.join("\\n")).error.includes("only for repository"));
    assert.equal(existsSync(join(root, "externals/external-path.toml")), false);
  });

  test("rejects IDs used by any entry type without overwriting files", () => {
    const originalSystem = readFileSync(join(root, "systems/alpha.toml"), "utf8");
    const originalRepository = readFileSync(join(root, "repositories/alpha-app.toml"), "utf8");
    const originalExternal = readFileSync(join(root, "externals/stripe.toml"), "utf8");
    for (const [kind, id] of [["repository", "alpha"], ["external", "alpha-app"], ["system", "stripe"]]) {
      const result = add(kind, id, { description: "Must not replace." }, ["--json"]);
      assert.equal(result.result, 2);
      assert.ok(JSON.stringify(JSON.parse(result.output.join("\\n"))).includes("already exists"));
    }
    assert.equal(readFileSync(join(root, "systems/alpha.toml"), "utf8"), originalSystem);
    assert.equal(readFileSync(join(root, "repositories/alpha-app.toml"), "utf8"), originalRepository);
    assert.equal(readFileSync(join(root, "externals/stripe.toml"), "utf8"), originalExternal);
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
      assert.equal(result.result, 2, item.id);
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
    assert.equal(result.result, 1);
    assert.equal(payload.ok, false);
    assert.equal(payload.type, "repository");
    assert.equal(payload.id, "rollback-repository");
    assert.equal(payload.path, "repositories/rollback-repository.toml");
    assert.equal(payload.validation.ok, false);
    assert.ok(payload.validation.errors.some((error: string) => error.includes("path does not exist")));
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
    assert.equal(result.result, 1);
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
    assert.equal(result.result, 1);
    assert.ok(payload.validation.errors.some((error: string) => error.includes("remote does not match")));
    assert.equal(existsSync(join(root, "repositories/remote-mismatch.toml")), false);
    assert.equal(existsSync(join(root, "local/paths.toml")), false);
  });

  test("reports text success and JSON argument errors", () => {
    const text = add("external", "text-entry", { description: "Text output." });
    assert.equal(text.result, 0);
    assert.ok(text.output.join("\\n").includes("Created external text-entry at externals/text-entry.toml; validation ok"));

    const jsonError = capture(() => main(["add", "repository", "bad-json-output", "--data", "{", "--json"], root));
    const payload = JSON.parse(jsonError.output.join("\\n"));
    assert.equal(jsonError.result, 2);
    assert.equal(payload.ok, false);
    assert.ok(payload.error.includes("not valid JSON"));

    const validationFailure = capture(() => main([
      "add", "repository", "text-path-failure", "--data", '{"description":"Failure output."}',
      "--local-path", join(temporary, "missing-path"),
    ], root));
    assert.equal(validationFailure.result, 1);
    assert.ok(validationFailure.errors.some((line) => line.includes("path does not exist")));
    assert.ok(validationFailure.errors.some((line) => line.includes("validation failed")));
    assert.equal(existsSync(join(root, "repositories/text-path-failure.toml")), false);
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
      assert.equal(main(["deps", "stripe"], root), 2);
    } finally {
      console.error = original;
    }
    assert.ok(errors[0].includes("not external entries"));
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
        TSX,
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
