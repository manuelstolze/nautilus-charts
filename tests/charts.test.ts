import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  Catalog,
  dependenciesFor,
  main,
  reverseDependencies,
  showEntry,
  validateCatalog,
} from "../scripts/charts.ts";

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
  for (const directory of ["systems", "repositories", "externals", "local"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(join(root, ".gitignore"), "/local/paths.toml\n", "utf8");
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

function capture<T>(action: () => T): { result: T; output: string[] } {
  const output: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
  try {
    return { result: action(), output };
  } finally {
    console.log = original;
  }
}

beforeEach(makeFixture);
afterEach(() => rmSync(temporary, { recursive: true, force: true }));

describe("catalog validation", () => {
  test("accepts a missing local paths file", () => {
    const result = validateCatalog(new Catalog(root));
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((warning) => warning.includes("local/paths.toml is missing")));
  });

  test("reports invalid TOML, unknown fields, and missing required fields", () => {
    write("systems/broken.toml", "description = [\n");
    write("systems/unknown.toml", 'description = "Extra field."\nextra = true\n');
    write("externals/no-description.toml", 'provider = "vendor"\n');
    const { errors } = validateCatalog(new Catalog(root));
    assert.ok(errors.some((error) => error.includes("systems/broken.toml: invalid TOML")));
    assert.ok(errors.some((error) => error.includes("unknown field(s): extra")));
    assert.ok(errors.some((error) => error.includes("missing required field: description")));
  });

  test("checks kebab-case IDs and uniqueness across entry types", () => {
    write("repositories/Bad_ID.toml", 'description = "Bad ID."\n');
    write("repositories/shared-id.toml", 'description = "A repository."\n');
    write("externals/shared-id.toml", 'description = "An external."\n');
    const { errors } = validateCatalog(new Catalog(root));
    assert.ok(errors.some((error) => error.includes("ID \"Bad_ID\" is not lowercase kebab-case")));
    assert.ok(errors.some((error) => error.includes("duplicate ID \"shared-id\"")));
  });

  test("checks status values and tags", () => {
    write(
      "repositories/alpha-app.toml",
      'description = "Alpha application."\nsystem = "alpha"\nstatus = "paused"\ntags = ["unknown"]\n',
    );
    const { errors } = validateCatalog(new Catalog(root));
    assert.ok(errors.some((error) => error.includes("invalid status \"paused\"")));
    assert.ok(errors.some((error) => error.includes("tag \"unknown\" is not defined")));
  });

  test("checks system references, dependency references, and self-dependencies", () => {
    write(
      "repositories/alpha-app.toml",
      'description = "Alpha application."\nsystem = "missing-system"\n' +
        'depends-on = [{ id = "alpha-app" }, { id = "missing-repo" }, { id = "beta-lib", extra = true, via = 4 }]\n',
    );
    const { errors } = validateCatalog(new Catalog(root));
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
    const result = validateCatalog(new Catalog(root));
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
    const { errors } = validateCatalog(new Catalog(root));
    assert.ok(errors.some((error) => error.includes("not a Git repository root")));
    assert.ok(errors.some((error) => error.includes("path does not exist")));
    assert.ok(errors.some((error) => error.includes("remote does not match") && error.includes("gamma-app")));
    assert.ok(errors.some((error) => error.includes("remote must not contain credentials")));
  });

  test("requires Git to ignore local/paths.toml", () => {
    writeFileSync(join(root, ".gitignore"), "", "utf8");
    write("local/paths.toml", 'alpha-app = "/missing"\n');
    const { errors } = validateCatalog(new Catalog(root));
    assert.ok(errors.some((error) => error.includes("local/paths.toml is not ignored")));
  });

  test("accepts a repository key and returns it from show and find", () => {
    write("repositories/alpha-app.toml", 'description = "Alpha application."\nkey = "NBR"\nsystem = "alpha"\n');
    assert.deepEqual(validateCatalog(new Catalog(root)).errors, []);

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
    const { errors } = validateCatalog(new Catalog(root));

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

describe("catalog commands", () => {
  test("derives system dependencies from repository dependencies", () => {
    const catalog = new Catalog(root);
    const result = dependenciesFor(catalog, catalog.get("alpha")!);
    assert.deepEqual(result.system_dependencies, [
      { id: "beta", type: "system", via_repositories: ["alpha-app"] },
    ]);
    assert.deepEqual((result.dependencies as Array<{ id: string }>).map((edge) => edge.id), ["beta-lib", "stripe"]);
  });

  test("finds reverse dependencies for repositories, externals, and systems", () => {
    const catalog = new Catalog(root);
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
    const result = showEntry(new Catalog(root), new Catalog(root).get("alpha-app")!);
    assert.equal(result.local_path, work);
    assert.equal(result.local_path_status, "ok");
  });

  test("returns JSON from find", () => {
    const { result, output } = capture(() => main(["find", "alpha", "--json"], root));
    const payload = JSON.parse(output.join("\n"));
    assert.equal(result, 0);
    assert.deepEqual(payload.entries.map((entry: { id: string }) => entry.id), ["alpha-app", "alpha"]);
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
