import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CatalogIndex, type Snapshot } from "../src/domain/catalog.ts";
import { dependenciesFor, resolveTicketKey, reverseDependencies, showEntry } from "../src/domain/dependencies.ts";
import { entryFile, type Data, type Kind } from "../src/domain/entry.ts";
import {
  mergeEntryData,
  remoteHasCredentials,
  validateCatalog,
  validateEntryData,
  validateNewTags,
  validationMaps,
  type CatalogFacts,
} from "../src/domain/validation.ts";

// Pure domain tests: snapshot literals, no temporary folders and no Git.

function entry(kind: Kind, id: string, data: Data) {
  return { kind, id, data, file: entryFile(kind, id) };
}

function snapshot(entries: ReturnType<typeof entry>[], overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    entries,
    tags: { utility: "Shared tools.", library: "Reusable code." },
    tagsExists: true,
    localPaths: {},
    localPathsExists: true,
    loadErrors: [],
    ...overrides,
  };
}

const NO_FACTS: CatalogFacts = { localPaths: new Map(), localPathsIgnored: { ignored: true } };

const BASE = [
  entry("system", "alpha", { description: "Alpha system.", name: "Alpha" }),
  entry("system", "beta", { description: "Beta system." }),
  entry("system", "gamma", { description: "Gamma system." }),
  entry("repository", "alpha-app", {
    description: "Alpha application.",
    system: "alpha",
    "depends-on": [{ id: "beta-lib", via: "npm" }, { id: "stripe", via: "API" }],
  }),
  entry("repository", "alpha-tool", { description: "Alpha tool.", system: "alpha", "depends-on": [{ id: "beta-lib" }] }),
  entry("repository", "beta-lib", { description: "Beta library.", system: "beta" }),
  entry("repository", "gamma-app", { description: "Gamma application.", system: "gamma", "depends-on": [{ id: "beta-lib" }] }),
  entry("external", "stripe", { description: "Payment service." }),
];

describe("validation", () => {
  test("validates new tags in input order against own keys and entry tags", () => {
    const tags: Record<string, unknown> = { utility: "Shared tools." };
    Object.defineProperty(tags, "constructor", { value: "Builds things.", enumerable: true });
    const newTags = [
      { name: "data-pipeline", description: "Moves data." },
      { name: "Data_Pipeline", description: "Bad name." },
      { name: "toString", description: "Bad name." },
      { name: "utility", description: "Existing." },
      { name: "constructor", description: "Existing own key." },
      { name: "unused-tag", description: "Not used." },
    ];
    assert.deepEqual(validateNewTags(tags, newTags, ["data-pipeline", "Data_Pipeline", "toString", "utility", "constructor"]), [
      'new tag "Data_Pipeline" must be lowercase kebab-case',
      'new tag "toString" must be lowercase kebab-case',
      'tag "utility" is already defined in tags.toml',
      'tag "constructor" is already defined in tags.toml',
      'new tag "unused-tag" is not used by the entry',
    ]);
    assert.deepEqual(validateNewTags(tags, [newTags[0]], ["data-pipeline"]), []);
  });

  test("does not treat inherited names as tags unless tags.toml defines them", () => {
    assert.deepEqual(
      validateNewTags({}, [{ name: "constructor", description: "Builds things." }], ["constructor"]),
      [],
    );
  });

  test("accepts a valid catalog", () => {
    assert.deepEqual(validateCatalog(snapshot(BASE), NO_FACTS), { errors: [], warnings: [] });
  });

  test("allows ticket-key on systems and repositories, but not externals", () => {
    const { errors } = validateCatalog(snapshot([
      entry("system", "alpha", { description: "Alpha system.", "ticket-key": "ABC" }),
      entry("repository", "alpha-app", { description: "Alpha application.", "ticket-key": "ABC" }),
      entry("external", "tracker", { description: "Tracker service.", "ticket-key": "ABC" }),
    ]), NO_FACTS);
    assert.deepEqual(errors, ["externals/tracker.toml: unknown field(s): ticket-key"]);
  });

  test("checks ticket-key form on systems and repositories", () => {
    const invalidValues: unknown[] = ["A", "abc", "1AB", "AB-C", "ABCDEFGHIJK", 12];
    const entries = [
      entry("system", "short-key", { description: "Short key.", "ticket-key": "AB" }),
      entry("repository", "long-key", { description: "Long key.", "ticket-key": "ABCDEFGHIJ" }),
      ...invalidValues.flatMap((value, index) => [
        entry("system", `bad-system-${index}`, { description: "Invalid key.", "ticket-key": value }),
        entry("repository", `bad-repository-${index}`, { description: "Invalid key.", "ticket-key": value }),
      ]),
    ];
    const form = "ticket-key must be 2–10 characters: an uppercase letter, then uppercase letters or digits";
    assert.deepEqual(validateCatalog(snapshot(entries), NO_FACTS).errors, invalidValues.flatMap((_, index) => [
      `systems/bad-system-${index}.toml: ${form}`,
      `repositories/bad-repository-${index}.toml: ${form}`,
    ]));
  });

  test("does not require ticket keys to be unique or different from repository keys", () => {
    const { errors } = validateCatalog(snapshot([
      entry("system", "alpha", { description: "Alpha system.", "ticket-key": "ABC" }),
      entry("system", "beta", { description: "Beta system.", "ticket-key": "ABC" }),
      entry("repository", "alpha-app", { description: "Alpha app.", system: "alpha", "ticket-key": "ABC" }),
      entry("repository", "key-owner", { description: "Key owner.", key: "XYZ" }),
      entry("repository", "ticket-owner", { description: "Ticket owner.", "ticket-key": "XYZ" }),
    ]), NO_FACTS);
    assert.deepEqual(errors, []);
  });

  test("checks IDs, keys, and duplicate keys", () => {
    const { errors } = validateCatalog(snapshot([
      entry("repository", "Bad_ID", { description: "Bad ID." }),
      entry("repository", "first", { description: "First.", key: "NBR" }),
      entry("repository", "second", { description: "Second.", key: "NBR" }),
      entry("repository", "lower", { description: "Lower.", key: "nb" }),
      entry("repository", "number", { description: "Number.", key: 12 }),
      entry("system", "with-key", { description: "System key.", key: "SYS" }),
    ]), NO_FACTS);
    const form = "key must be 2–5 characters: an uppercase letter, then uppercase letters or digits";
    assert.deepEqual(errors, [
      'repositories/Bad_ID.toml: ID "Bad_ID" is not lowercase kebab-case',
      'repositories/second.toml: duplicate key "NBR"; also used by repositories/first.toml',
      `repositories/lower.toml: ${form}`,
      `repositories/number.toml: ${form}`,
      "systems/with-key.toml: unknown field(s): key",
    ]);
  });

  test("checks unknown and missing fields, statuses, and tags", () => {
    const { errors } = validateCatalog(snapshot([
      entry("system", "extra", { description: "Extra.", extra: true, another: 1 }),
      entry("external", "no-description", { provider: 4 }),
      entry("repository", "paused", { description: "Paused.", status: "paused", tags: ["unknown", "utility"] }),
      entry("repository", "bad-tags", { description: 5, tags: "utility" }),
    ]), NO_FACTS);
    assert.deepEqual(errors, [
      "systems/extra.toml: unknown field(s): another, extra",
      "externals/no-description.toml: missing required field: description",
      "externals/no-description.toml: provider must be a string",
      'repositories/paused.toml: invalid status "paused"',
      'repositories/paused.toml: tag "unknown" is not defined in tags.toml',
      "repositories/bad-tags.toml: description must be a string",
      "repositories/bad-tags.toml: tags must be a list of strings",
    ]);
  });

  test("rejects tags that the tags table only inherits", () => {
    const inherited = ["toString", "constructor", "hasOwnProperty", "__proto__"];
    // A plain object built without a __proto__ literal, so no inherited name is an own key.
    const tags: Record<string, unknown> = { utility: "Shared tools." };
    assert.deepEqual(inherited.filter((name) => Object.hasOwn(tags, name)), []);
    const { errors } = validateCatalog(snapshot([
      entry("repository", "tagged", { description: "Tagged.", tags: [...inherited, "utility"] }),
    ], { tags }), NO_FACTS);
    assert.deepEqual(errors, inherited.map((name) => `repositories/tagged.toml: tag ${JSON.stringify(name)} is not defined in tags.toml`));
  });

  test("accepts an inherited name that the tags table defines as its own key", () => {
    const tags: Record<string, unknown> = { utility: "Shared tools." };
    Object.defineProperty(tags, "constructor", { value: "Builds things.", enumerable: true });
    const { errors } = validateCatalog(snapshot([
      entry("repository", "builder", { description: "Builder.", tags: ["constructor", "utility"] }),
    ], { tags }), NO_FACTS);
    assert.deepEqual(errors, []);
  });

  test("checks system references, dependency references, and self-dependencies", () => {
    const { errors } = validateCatalog(snapshot([
      ...BASE,
      entry("repository", "loop", {
        description: "Loop.",
        system: "missing-system",
        "depends-on": [{ id: "loop" }, { id: "missing" }, { id: "alpha", extra: 1, via: 4 }, "text", { via: "x" }],
      }),
    ]), NO_FACTS);
    assert.deepEqual(errors, [
      'repositories/loop.toml: system "missing-system" does not name a system',
      "repositories/loop.toml: depends-on[0] cannot point to the same repository",
      'repositories/loop.toml: depends-on[1] ID "missing" does not exist',
      "repositories/loop.toml: depends-on[2] has unknown field(s): extra",
      'repositories/loop.toml: depends-on[2] ID "alpha" is not a repository or external',
      "repositories/loop.toml: depends-on[2] via must be a string",
      "repositories/loop.toml: depends-on[3] must be a table",
      "repositories/loop.toml: depends-on[4] requires a string id",
    ]);
  });

  test("warns on dependencies to deprecated and archived entries", () => {
    const result = validateCatalog(snapshot([
      entry("repository", "old-lib", { description: "Old.", status: "deprecated" }),
      entry("repository", "user", { description: "User.", "depends-on": [{ id: "old-lib" }, { id: "old-api" }] }),
      entry("repository", "other-user", { description: "Other user.", "depends-on": [{ id: "old-lib" }] }),
      entry("external", "old-api", { description: "Retired.", status: "archived" }),
    ]), NO_FACTS);
    assert.deepEqual(result, {
      errors: [],
      warnings: [
        'repositories/other-user.toml: depends-on[0] points to deprecated entry "old-lib"',
        'repositories/user.toml: depends-on[0] points to deprecated entry "old-lib"',
        'repositories/user.toml: depends-on[1] points to archived entry "old-api"',
      ],
    });
  });

  test("rejects credentials in remotes", () => {
    assert.equal(remoteHasCredentials("https://user:token@example.com/repo.git"), true);
    assert.equal(remoteHasCredentials("https://user@example.com/repo.git"), true);
    assert.equal(remoteHasCredentials("https://example.com/repo.git?access_token=x"), true);
    assert.equal(remoteHasCredentials("ssh://git@example.com/repo.git"), false);
    assert.equal(remoteHasCredentials("git@example.com:repo.git"), false);
    const { errors } = validateCatalog(snapshot([
      entry("repository", "secret", { description: "Secret.", remote: "https://user:token@example.com/repo.git" }),
    ]), NO_FACTS);
    assert.deepEqual(errors, ["repositories/secret.toml: remote must not contain credentials"]);
  });

  test("reports duplicate IDs across types and keeps the first entry", () => {
    const duplicate = snapshot([
      entry("system", "shared", { description: "The system." }),
      entry("repository", "shared", { description: "The repository." }),
      entry("repository", "user", { description: "User.", system: "shared" }),
    ]);
    assert.deepEqual(validateCatalog(duplicate, NO_FACTS).errors, [
      'repositories/shared.toml: duplicate ID "shared"; also used by systems/shared.toml',
    ]);
    assert.equal(new CatalogIndex(duplicate).get("shared")?.kind, "system");
  });

  test("reports load errors, tags, local paths, and the ignore rule", () => {
    const result = validateCatalog(
      snapshot([entry("repository", "alpha-app", { description: "Alpha." })], {
        loadErrors: ["systems/broken.toml: invalid TOML: bad"],
        tags: { library: 3 },
        tagsExists: false,
        localPaths: { "alpha-app": "/work/alpha-app", stripe: "/work/stripe", other: 5 },
      }),
      {
        localPaths: new Map([["alpha-app", { resolved: "/work/alpha-app", error: "path does not exist: /work/alpha-app" }]]),
        localPathsIgnored: { ignored: false },
      },
    );
    assert.deepEqual(result.errors, [
      "systems/broken.toml: invalid TOML: bad",
      "tags.toml is missing",
      'tags.toml: description for "library" must be a string',
      'local/paths.toml: path does not exist: /work/alpha-app for "alpha-app"',
      'local/paths.toml: "stripe" does not name a repository',
      'local/paths.toml: path for "other" must be a string',
      "local/paths.toml is not ignored by Git",
    ]);
    assert.deepEqual(
      validateCatalog(snapshot([], { localPaths: null, localPathsExists: false }), { ...NO_FACTS, localPathsIgnored: { error: "spawn failed" } }),
      { errors: ["could not check Git ignore rule: spawn failed"], warnings: ["local/paths.toml is missing; local path checks were skipped"] },
    );
  });
});

describe("entry updates", () => {
  test("merges fields and reports only deep value changes", () => {
    const current: Data = {
      description: "Old.",
      tags: ["utility"],
      "depends-on": [{ id: "beta-lib", via: "npm" }],
      options: { enabled: true, retry: 2 },
    };
    const updates: Data = {
      description: "New.",
      tags: ["library"],
      "depends-on": [{ id: "beta-lib", via: "npm" }],
      options: { retry: 2, enabled: true },
      name: "Renamed label",
    };

    const result = mergeEntryData(current, updates);
    assert.deepEqual(result, {
      data: {
        description: "New.",
        tags: ["library"],
        "depends-on": [{ id: "beta-lib", via: "npm" }],
        options: { enabled: true, retry: 2 },
        name: "Renamed label",
      },
      changed: ["description", "tags", "name"],
    });
    assert.deepEqual(current.description, "Old.");
    assert.deepEqual(current.tags, ["utility"]);
  });

  test("validates an entry without treating its own ID or key as a duplicate", () => {
    const entries = [
      entry("repository", "alpha-app", { description: "Alpha.", key: "ALP" }),
      entry("repository", "beta-lib", { description: "Beta.", key: "BET" }),
    ];
    const index = new CatalogIndex(snapshot(entries));
    const merged = entry("repository", "beta-lib", { description: "Updated beta.", key: "BET" });
    const maps = validationMaps(index, "beta-lib");
    assert.deepEqual(validateEntryData(index, merged, maps.seen, maps.keys), { errors: [], warnings: [] });

    const conflicting = entry("repository", "beta-lib", { description: "Updated beta.", key: "ALP" });
    const conflictMaps = validationMaps(index, "beta-lib");
    assert.deepEqual(validateEntryData(index, conflicting, conflictMaps.seen, conflictMaps.keys).errors, [
      'repositories/beta-lib.toml: duplicate key "ALP"; also used by repositories/alpha-app.toml',
    ]);
  });
});

describe("dependencies", () => {
  const index = new CatalogIndex(snapshot(BASE));

  test("derives system dependencies from repository dependencies", () => {
    assert.deepEqual([...index.systemEdges()].map(([source, targets]) => [source, [...targets].map(([target, via]) => [target, [...via]])]), [
      ["alpha", [["beta", ["alpha-app", "alpha-tool"]]]],
      ["gamma", [["beta", ["gamma-app"]]]],
    ]);
  });

  test("lists a repository's dependencies", () => {
    assert.deepEqual(dependenciesFor(index, index.get("alpha-app")!), {
      id: "alpha-app",
      type: "repository",
      dependencies: [
        { id: "beta-lib", type: "repository", name: "beta-lib", via: "npm" },
        { id: "stripe", type: "external", name: "stripe", via: "API" },
      ],
    });
  });

  test("lists a system's dependencies and derived system dependencies", () => {
    assert.deepEqual(dependenciesFor(index, index.get("alpha")!), {
      id: "alpha",
      type: "system",
      dependencies: [
        { id: "beta-lib", type: "repository", name: "beta-lib", via: "npm", from: "alpha-app" },
        { id: "stripe", type: "external", name: "stripe", via: "API", from: "alpha-app" },
        { id: "beta-lib", type: "repository", name: "beta-lib", from: "alpha-tool" },
      ],
      system_dependencies: [{ id: "beta", type: "system", via_repositories: ["alpha-app", "alpha-tool"] }],
    });
  });

  test("lists reverse dependencies for a system", () => {
    assert.deepEqual(reverseDependencies(index, index.get("beta")!), {
      id: "beta",
      type: "system",
      dependents: [
        { id: "alpha-app", type: "repository", name: "alpha-app" },
        { id: "alpha-tool", type: "repository", name: "alpha-tool" },
        { id: "gamma-app", type: "repository", name: "gamma-app" },
        { id: "alpha", type: "system", name: "Alpha", via_repositories: ["alpha-app", "alpha-tool"] },
        { id: "gamma", type: "system", name: "gamma", via_repositories: ["gamma-app"] },
      ],
    });
    assert.deepEqual(reverseDependencies(index, index.get("stripe")!).dependents, [
      { id: "alpha-app", type: "repository", name: "alpha-app" },
    ]);
  });

  test("resolves ticket keys from repositories and their systems", () => {
    const index = new CatalogIndex(snapshot([
      entry("system", "alpha", { description: "Alpha.", "ticket-key": "ABC" }),
      entry("system", "beta", { description: "Beta." }),
      entry("system", "invalid-system", { description: "Invalid.", "ticket-key": "abc" }),
      entry("external", "tracker", { description: "Tracker.", "ticket-key": "ABC" }),
      entry("repository", "own", { description: "Own key.", system: "alpha", "ticket-key": "XYZ" }),
      entry("repository", "inherited", { description: "Inherited key.", system: "alpha" }),
      entry("repository", "independent", { description: "Independent." }),
      entry("repository", "no-key", { description: "No system key.", system: "beta" }),
      entry("repository", "missing-system", { description: "Missing system.", system: "missing" }),
      entry("repository", "external-system", { description: "External system.", system: "tracker" }),
      entry("repository", "invalid-system-key", { description: "Invalid system key.", system: "invalid-system" }),
      entry("repository", "invalid-own", { description: "Invalid own key.", system: "alpha", "ticket-key": "abc" }),
    ]));
    assert.deepEqual(resolveTicketKey(index, index.get("own")!), { key: "XYZ", source: "repository" });
    assert.deepEqual(resolveTicketKey(index, index.get("inherited")!), { key: "ABC", source: "system" });
    for (const id of ["independent", "no-key", "missing-system", "external-system", "invalid-system-key"]) {
      assert.deepEqual(resolveTicketKey(index, index.get(id)!), { key: null, source: null }, id);
    }
    assert.deepEqual(resolveTicketKey(index, index.get("invalid-own")!), { key: "ABC", source: "system" });
    assert.deepEqual(resolveTicketKey(index, index.get("alpha")!), { key: null, source: null });
  });

  test("shows a local path only when its check passed", () => {
    const withPaths = new CatalogIndex(snapshot(BASE, { localPaths: { "alpha-app": "~/alpha", "beta-lib": "/absent" } }));
    const facts = new Map([
      ["alpha-app", { resolved: "/home/user/alpha", error: null }],
      ["beta-lib", { resolved: "/absent", error: "path does not exist: /absent" }],
    ]);
    assert.deepEqual(showEntry(withPaths, withPaths.get("alpha-app")!, facts), {
      ...BASE[3].data, type: "repository", id: "alpha-app", name: "alpha-app",
      local_path: "/home/user/alpha", local_path_status: "ok",
    });
    assert.equal(showEntry(withPaths, withPaths.get("beta-lib")!, facts).local_path, null);
    assert.equal(showEntry(withPaths, withPaths.get("beta-lib")!, facts).local_path_status, "path does not exist: /absent");
    assert.equal(showEntry(withPaths, withPaths.get("gamma-app")!, facts).local_path_status, "not configured");
    assert.equal("local_path" in showEntry(withPaths, withPaths.get("alpha")!, facts), false);
  });
});
