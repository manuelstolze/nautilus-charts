import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { main as runCharts } from "../scripts/charts.ts";
import { CatalogGitCli } from "../src/adapters/catalog-git.ts";
import { FileCatalogRegistry } from "../src/adapters/catalog-registry.ts";

// Golden output: every command, in text and --json, against one fixture
// catalog. Set UPDATE_GOLDEN=1 to record the files from the current code.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN_DIR = join(REPO_ROOT, "tests/golden");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

type Fixture = { temporary: string; root: string; projectRoot: string; registryPath: string; work: string };
type Case = { name: string; argv: (fixture: Fixture) => string[]; setup?: (fixture: Fixture) => void; files?: string[] };

function write(root: string, relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  if (!relativePath.startsWith("local/")) {
    execFileSync("git", ["-C", root, "add", "--", relativePath]);
    execFileSync("git", ["-C", root, "-c", "user.name=Charts Test", "-c", "user.email=charts@example.com", "commit", "--quiet", "-m", "Fixture update", "--", relativePath]);
  }
}

function gitRepository(path: string, remote?: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", path]);
  if (remote) execFileSync("git", ["-C", path, "remote", "add", "origin", remote]);
}

function makeFixture(): Fixture {
  const temporary = mkdtempSync(join(tmpdir(), "charts-golden-"));
  const projectRoot = join(temporary, "charts");
  const root = join(temporary, "folio", "nautilus");
  const registryPath = join(temporary, "config", "catalogs.json");
  const work = join(temporary, "work");
  const remote = join(temporary, "nautilus.git");
  mkdirSync(join(projectRoot, "templates"), { recursive: true });
  for (const kind of ["system", "repository", "external"]) {
    copyFileSync(join(REPO_ROOT, `templates/${kind}.toml`), join(projectRoot, `templates/${kind}.toml`));
  }
  execFileSync("git", ["init", "--bare", "--quiet", remote]);
  new CatalogGitCli(REPO_ROOT).initialize(root, remote);
  new FileCatalogRegistry(registryPath).register({ name: "nautilus", path: root, remote });
  write(root, "tags.toml", 'utility = "Shared tools."\nlibrary = "Reusable code."\n');
  write(root, "systems/alpha.toml", 'name = "Alpha"\ndescription = "Alpha system."\nowner = "Team Alpha"\n');
  write(root, "systems/beta.toml", 'description = "Beta system."\nowner = "Team Beta"\n');
  write(root, "systems/gamma.toml", 'description = "Gamma system."\nstatus = "deprecated"\n');
  write(
    root,
    "repositories/alpha-app.toml",
    'name = "Alpha App"\ndescription = "Alpha application."\nkey = "ALP"\nsystem = "alpha"\n' +
      'owner = "Team Alpha"\ntags = ["utility"]\nremote = "https://example.com/shop/alpha-app.git"\n' +
      'default-branch = "main"\ndepends-on = [{ id = "beta-lib", via = "npm" }, { id = "stripe", via = "API" }]\n',
  );
  write(root, "repositories/beta-lib.toml", 'description = "Beta library."\nkey = "BET"\nsystem = "beta"\ntags = ["library"]\n');
  write(
    root,
    "repositories/gamma-app.toml",
    'description = "Gamma application."\nsystem = "gamma"\nstatus = "deprecated"\ndepends-on = [{ id = "beta-lib" }]\n',
  );
  write(root, "repositories/old-tool.toml", 'description = "Old tool."\nsystem = "alpha"\nstatus = "archived"\n');
  write(root, "externals/stripe.toml", 'description = "Payment service."\nprovider = "example"\nkind = "saas"\n');
  write(root, "externals/old-api.toml", 'description = "Retired API."\nstatus = "archived"\n');
  gitRepository(join(work, "alpha-app"), "https://example.com/shop/alpha-app.git");
  write(root, "local/paths.toml", `alpha-app = ${JSON.stringify(join(work, "alpha-app"))}\n`);
  return { temporary, root, projectRoot, registryPath, work };
}

const fixed = (...argv: string[]) => () => argv;

const CASES: Record<string, Case[]> = {
  find: [
    { name: "all entries", argv: fixed("find") },
    { name: "text", argv: fixed("find", "alpha") },
    { name: "text without match", argv: fixed("find", "nothing-matches") },
    { name: "key text", argv: fixed("find", "ALP") },
    { name: "system filter", argv: fixed("find", "--system", "alpha") },
    { name: "tag filter", argv: fixed("find", "--tag", "library") },
    { name: "status filter", argv: fixed("find", "--status", "deprecated") },
    { name: "archived status filter", argv: fixed("find", "--status", "archived") },
    { name: "owner filter", argv: fixed("find", "--owner", "team alpha") },
    { name: "combined filters", argv: fixed("find", "app", "--system", "alpha", "--status", "active") },
  ],
  show: [
    { name: "system", argv: fixed("show", "alpha") },
    { name: "repository with an ok path", argv: fixed("show", "alpha-app") },
    {
      name: "repository with an inherited ticket key",
      argv: fixed("show", "alpha-app"),
      setup: ({ root }) => write(
        root,
        "systems/alpha.toml",
        'name = "Alpha"\ndescription = "Alpha system."\nowner = "Team Alpha"\nticket-key = "ABC"\n',
      ),
    },
    { name: "repository with no path configured", argv: fixed("show", "beta-lib") },
    { name: "external", argv: fixed("show", "stripe") },
    { name: "unknown ID", argv: fixed("show", "missing") },
    {
      name: "repository with a missing path",
      argv: fixed("show", "alpha-app"),
      setup: ({ root, work }) => write(root, "local/paths.toml", `alpha-app = ${JSON.stringify(join(work, "absent"))}\n`),
    },
    {
      name: "repository with a remote mismatch",
      argv: fixed("show", "alpha-app"),
      setup: ({ work }) => execFileSync("git", ["-C", join(work, "alpha-app"), "remote", "set-url", "origin", "https://example.com/other.git"]),
    },
    {
      name: "repository path that is not a Git root",
      argv: fixed("show", "beta-lib"),
      setup: ({ root, work }) => {
        mkdirSync(join(work, "plain"), { recursive: true });
        write(root, "local/paths.toml", `beta-lib = ${JSON.stringify(join(work, "plain"))}\n`);
      },
    },
  ],
  deps: [
    { name: "repository", argv: fixed("deps", "alpha-app") },
    { name: "repository without dependencies", argv: fixed("deps", "beta-lib") },
    { name: "system", argv: fixed("deps", "alpha") },
    { name: "system without dependencies", argv: fixed("deps", "beta") },
    { name: "external", argv: fixed("deps", "stripe") },
    { name: "unknown ID", argv: fixed("deps", "missing") },
  ],
  rdeps: [
    { name: "repository", argv: fixed("rdeps", "beta-lib") },
    { name: "repository without dependents", argv: fixed("rdeps", "alpha-app") },
    { name: "external", argv: fixed("rdeps", "stripe") },
    { name: "system", argv: fixed("rdeps", "beta") },
    { name: "unknown ID", argv: fixed("rdeps", "missing") },
  ],
  check: [
    { name: "ok", argv: fixed("check") },
    {
      name: "with warnings",
      argv: fixed("check"),
      setup: ({ root }) => {
        unlinkSync(join(root, "local/paths.toml"));
        write(
          root,
          "repositories/delta-app.toml",
          'description = "Delta application."\ndepends-on = [{ id = "gamma-app" }, { id = "old-api" }, { id = "old-tool" }]\n',
        );
      },
    },
    {
      name: "with entry errors",
      argv: fixed("check"),
      setup: ({ root }) => {
        write(root, "systems/broken.toml", "description = [\n");
        write(root, "systems/unknown.toml", 'description = "Extra field."\nextra = true\n');
        write(root, "externals/no-description.toml", 'provider = 4\nkind = false\n');
        write(root, "repositories/Bad_ID.toml", 'description = "Bad ID."\n');
        write(root, "repositories/stripe.toml", 'description = "Duplicate ID across types."\n');
        write(root, "repositories/dup-key.toml", 'description = "Duplicate key."\nkey = "ALP"\n');
        write(root, "repositories/bad-key.toml", 'description = "Bad key."\nkey = "alp"\n');
        write(
          root,
          "repositories/messy.toml",
          'description = 5\nname = 1\nstatus = "paused"\nsystem = "missing-system"\ntags = ["unknown", "utility"]\n' +
            'remote = "https://user:token@example.com/messy.git"\n' +
            'depends-on = [{ id = "messy" }, { id = "missing-repo" }, { id = "alpha", extra = 1, via = 4 }, "text", { via = "x" }]\n',
        );
        write(root, "repositories/bad-lists.toml", 'description = "Bad lists."\nsystem = 3\ntags = "utility"\ndepends-on = "beta-lib"\n');
        write(root, "tags.toml", 'utility = "Shared tools."\nlibrary = 3\n');
      },
    },
    {
      name: "with local path errors",
      argv: fixed("check"),
      setup: ({ root, work }) => {
        gitRepository(join(work, "beta-lib"));
        mkdirSync(join(work, "plain"), { recursive: true });
        write(root, "repositories/beta-lib.toml", 'description = "Beta library."\nsystem = "beta"\nremote = "ssh://example.com/beta.git"\n');
        write(
          root,
          "local/paths.toml",
          `alpha-app = ${JSON.stringify(join(work, "absent"))}\n` +
            `beta-lib = ${JSON.stringify(join(work, "beta-lib"))}\n` +
            `gamma-app = ${JSON.stringify(join(work, "plain"))}\n` +
            `old-tool = 5\nstripe = ${JSON.stringify(join(work, "alpha-app"))}\nmissing = "/absent"\n`,
        );
      },
    },
    {
      name: "with invalid local paths TOML",
      argv: fixed("check"),
      setup: ({ root }) => write(root, "local/paths.toml", "alpha-app = [\n"),
    },
    {
      name: "with an unignored local paths file and no tags",
      argv: fixed("check"),
      setup: ({ root }) => {
        write(root, ".gitignore", "/systems/*.toml\n/repositories/*.toml\n/externals/*.toml\n");
        unlinkSync(join(root, "tags.toml"));
      },
    },
  ],
  add: [
    {
      name: "system success",
      argv: fixed("add", "system", "new-system", "--data", '{"description":"Line one.\\nLine two.","name":"Quoted \\"System\\"","status":"planned"}'),
      files: ["systems/new-system.toml"],
    },
    {
      name: "repository success with a local path",
      argv: ({ work }) => [
        "add", "repository", "new-repo", "--data",
        JSON.stringify({
          "depends-on": [{ id: "beta-lib", via: "npm package" }, { id: "stripe" }],
          tags: ["library", "utility"],
          system: "alpha",
          key: "NEW",
          remote: "https://example.com/shop/new-repo.git",
          description: "A new repository.",
          "default-branch": "main",
        }),
        "--local-path", join(work, "new-repo"),
      ],
      setup: ({ work }) => gitRepository(join(work, "new-repo"), "https://example.com/shop/new-repo.git"),
      files: ["repositories/new-repo.toml", "local/paths.toml"],
    },
    {
      name: "repository success creating the local paths file",
      argv: ({ work }) => ["add", "repository", "fresh-repo", "--data", '{"description":"Fresh."}', "--local-path", join(work, "fresh-repo")],
      setup: ({ root, work }) => {
        unlinkSync(join(root, "local/paths.toml"));
        gitRepository(join(work, "fresh-repo"));
      },
      files: ["repositories/fresh-repo.toml", "local/paths.toml"],
    },
    {
      name: "external success with a deprecated dependency warning",
      argv: fixed("add", "external", "new-api", "--data", '{"kind":"saas","provider":"example","description":"New API."}'),
      setup: ({ root }) => write(root, "repositories/delta-app.toml", 'description = "Delta."\ndepends-on = [{ id = "gamma-app" }]\n'),
      files: ["externals/new-api.toml"],
    },
    {
      name: "invalid input",
      argv: fixed(
        "add", "repository", "bad-input", "--data",
        '{"description":"Bad.","key":"ALP","status":"paused","tags":["unknown"],"extra":1,"depends-on":[{"id":"alpha"},{"id":"old-api"}]}',
      ),
      files: ["repositories/bad-input.toml"],
    },
    { name: "missing description", argv: fixed("add", "system", "no-description", "--data", '{"name":"No description"}'), files: ["systems/no-description.toml"] },
    { name: "duplicate ID", argv: fixed("add", "external", "alpha-app", "--data", '{"description":"Duplicate."}'), files: ["externals/alpha-app.toml"] },
    {
      name: "duplicate ID in an unreadable entry",
      argv: fixed("add", "system", "broken", "--data", '{"description":"Duplicate."}'),
      setup: ({ root }) => write(root, "repositories/broken.toml", "description = [\n"),
      files: ["systems/broken.toml"],
    },
    {
      name: "entry path not ignored",
      argv: fixed("add", "system", "unignored", "--data", '{"description":"Unignored."}'),
      setup: ({ root }) => write(root, ".gitignore", "/repositories/*.toml\n/externals/*.toml\n/local/paths.toml\n"),
      files: ["systems/unignored.toml"],
    },
    {
      name: "failed validation with rollback of an existing map",
      argv: ({ work }) => ["add", "repository", "rollback-repo", "--data", '{"description":"Rollback."}', "--local-path", join(work, "absent")],
      files: ["repositories/rollback-repo.toml", "local/paths.toml"],
    },
    {
      name: "failed validation with rollback of a new map",
      argv: ({ work }) => [
        "add", "repository", "rollback-new", "--data",
        '{"description":"Rollback.","remote":"https://example.com/wanted.git"}', "--local-path", join(work, "mismatch"),
      ],
      setup: ({ root, work }) => {
        unlinkSync(join(root, "local/paths.toml"));
        gitRepository(join(work, "mismatch"), "https://example.com/other.git");
      },
      files: ["repositories/rollback-new.toml", "local/paths.toml"],
    },
    {
      name: "failed validation of an already broken catalog",
      argv: fixed("add", "system", "after-broken", "--data", '{"description":"After broken."}'),
      setup: ({ root }) => write(root, "systems/unknown.toml", 'description = "Extra field."\nextra = true\n'),
      files: ["systems/after-broken.toml"],
    },
    {
      name: "invalid local paths file",
      argv: ({ work }) => ["add", "repository", "map-error", "--data", '{"description":"Map error."}', "--local-path", join(work, "alpha-app")],
      setup: ({ root }) => write(root, "local/paths.toml", "alpha-app = [\n"),
      files: ["repositories/map-error.toml", "local/paths.toml"],
    },
    { name: "argument error: missing data", argv: fixed("add", "system", "no-data") },
    { name: "argument error: invalid JSON", argv: fixed("add", "system", "bad-json", "--data", "{") },
    { name: "argument error: not an object", argv: fixed("add", "system", "not-object", "--data", "[]") },
    { name: "argument error: id in data", argv: fixed("add", "system", "with-id", "--data", '{"id":"x","description":"X."}') },
    { name: "argument error: invalid type", argv: fixed("add", "service", "new-entry", "--data", '{"description":"X."}') },
    { name: "argument error: invalid ID", argv: fixed("add", "system", "Bad_ID", "--data", '{"description":"X."}') },
    { name: "argument error: missing ID", argv: fixed("add", "system", "--data", '{"description":"X."}') },
    { name: "argument error: local path for external", argv: fixed("add", "external", "ext", "--data", '{"description":"X."}', "--local-path", "/absent") },
    { name: "argument error: empty local path", argv: fixed("add", "repository", "empty-path", "--data", '{"description":"X."}', "--local-path", "") },
    { name: "argument error: repeated data", argv: fixed("add", "system", "twice", "--data", "{}", "--data", "{}") },
    { name: "argument error: repeated local path", argv: fixed("add", "repository", "twice", "--data", "{}", "--local-path", "/a", "--local-path", "/b") },
    { name: "argument error: option without value", argv: fixed("add", "repository", "no-value", "--local-path") },
    { name: "argument error: unknown option", argv: fixed("add", "system", "unknown", "--force") },
  ],
  set: [
    {
      name: "success",
      argv: fixed("set", "alpha-app", "--data", '{"description":"Updated application."}'),
      files: ["repositories/alpha-app.toml"],
    },
    {
      name: "no change",
      argv: fixed("set", "alpha-app", "--data", '{"description":"Alpha application."}'),
      files: ["repositories/alpha-app.toml"],
    },
    {
      name: "refused key change",
      argv: fixed("set", "alpha-app", "--data", '{"key":"NEW"}'),
      files: ["repositories/alpha-app.toml"],
    },
    {
      name: "input error",
      argv: fixed("set", "alpha-app", "--data", "{"),
    },
  ],
  usage: [
    { name: "no command", argv: fixed() },
    { name: "unknown command", argv: fixed("list") },
    { name: "unknown option", argv: fixed("show", "alpha", "--verbose") },
    { name: "filter outside find", argv: fixed("show", "alpha", "--system", "alpha") },
    { name: "filter without value", argv: fixed("find", "--system") },
    { name: "filter followed by an option", argv: fixed("find", "--tag", "--owner", "x") },
    { name: "invalid status filter", argv: fixed("find", "--status", "paused") },
    { name: "find with two texts", argv: fixed("find", "one", "two") },
    { name: "show without ID", argv: fixed("show") },
    { name: "deps with two IDs", argv: fixed("deps", "alpha", "beta") },
    { name: "check with an argument", argv: fixed("check", "alpha") },
  ],
};

function normalize(text: string, fixture: Fixture): string {
  let result = text;
  for (const [path, placeholder] of [
    [realpathSync(fixture.temporary), "<TMP>"],
    [fixture.temporary, "<TMP>"],
  ] as const) {
    result = result.split(path).join(placeholder);
    result = result.split(JSON.stringify(path).slice(1, -1)).join(placeholder);
  }
  return result;
}

function run(item: Case, json: boolean): string {
  const fixture = makeFixture();
  try {
    item.setup?.(fixture);
    const argv = [...item.argv(fixture)];
    if (["find", "show", "deps", "rdeps", "check", "add", "set"].includes(argv[0]) && !argv.includes("--catalog")) {
      argv.push("--catalog", "nautilus");
    }
    if (json) argv.push("--json");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...values: unknown[]) => stdout.push(values.map(String).join(" "));
    console.error = (...values: unknown[]) => stderr.push(values.map(String).join(" "));
    let status: number;
    try {
      status = runCharts(argv, fixture.projectRoot, fixture.registryPath);
    } finally {
      console.log = log;
      console.error = error;
    }
    const lines = [
      `## ${item.name}${json ? " (--json)" : ""}`,
      ["$ charts", ...argv.map((argument) => JSON.stringify(argument))].join(" "),
      `exit: ${status}`,
      "--- stdout",
      ...stdout,
      "--- stderr",
      ...stderr,
    ];
    for (const file of item.files ?? []) {
      const path = join(fixture.root, file);
      lines.push(`--- file ${file}`);
      lines.push(existsSync(path) ? readFileSync(path, "utf8").replace(/\n$/, "") : "(absent)");
    }
    return normalize(lines.join("\n"), fixture);
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
}

describe("golden output", () => {
  for (const [group, cases] of Object.entries(CASES)) {
    test(group, () => {
      const actual = cases.flatMap((item) => [run(item, false), run(item, true)]).join("\n\n") + "\n";
      const path = join(GOLDEN_DIR, `${group}.txt`);
      if (UPDATE) {
        mkdirSync(GOLDEN_DIR, { recursive: true });
        writeFileSync(path, actual, "utf8");
      }
      assert.equal(actual, readFileSync(path, "utf8"));
    });
  }
});
