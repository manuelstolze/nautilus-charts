import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { add } from "../src/commands/add.ts";
import { check } from "../src/commands/check.ts";
import { deps, rdeps } from "../src/commands/deps.ts";
import { set } from "../src/commands/set.ts";
import { show } from "../src/commands/show.ts";
import { validateCatalog } from "../src/domain/validation.ts";
import type { Snapshot } from "../src/domain/catalog.ts";
import { FakeGit } from "./fakes/fake-git.ts";
import { MemoryStore } from "./fakes/memory-store.ts";
import type { ChartsError, ErrorCode } from "../src/domain/errors.ts";

/** The typed error of a failed result, after checking its code. */
function failed(result: { ok: true } | { ok: false; error: ChartsError }, code: ErrorCode, message: string = code): ChartsError {
  assert.equal(result.ok, false, message);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.error.code, code, message);
  return result.error;
}

/** The validation errors and warnings in a failure's details. */
function details(error: ChartsError): { errors: string[]; warnings: string[] } {
  return error.details as { errors: string[]; warnings: string[] };
}

function snapshot(entries: Snapshot["entries"], loadErrors: string[] = []): Snapshot {
  return { entries, tags: {}, tagsExists: true, localPaths: null, localPathsExists: false, loadErrors };
}

// Use cases run against in-memory fakes: no temporary folders and no Git.

function catalog(localPaths: Record<string, string> | null = { "alpha-app": "/work/alpha-app" }) {
  const store = new MemoryStore({
    entries: [
      { kind: "system", id: "alpha", data: { description: "Alpha system." } },
      { kind: "repository", id: "alpha-app", data: { description: "Alpha application.", system: "alpha", key: "ALP" } },
      { kind: "external", id: "stripe", data: { description: "Payment service." } },
    ],
    tags: { utility: "Shared tools." },
    localPaths,
  });
  const git = new FakeGit({
    repositories: {
      "/work/alpha-app": [],
      "/work/new-repo": ["https://example.com/shop/new-repo.git"],
    },
  });
  return { store, git };
}

describe("show use case", () => {
  test("reports resolved ticket keys for repositories only", () => {
    const store = new MemoryStore({
      entries: [
        { kind: "system", id: "alpha", data: { description: "Alpha.", "ticket-key": "ABC" } },
        { kind: "system", id: "beta", data: { description: "Beta." } },
        { kind: "repository", id: "own", data: { description: "Own key.", system: "alpha", "ticket-key": "XYZ" } },
        { kind: "repository", id: "inherited", data: { description: "Inherited key.", system: "alpha" } },
        { kind: "repository", id: "independent", data: { description: "Independent." } },
        { kind: "repository", id: "no-system-key", data: { description: "No system key.", system: "beta" } },
        { kind: "external", id: "tracker", data: { description: "Tracker." } },
      ],
      localPaths: null,
    });
    const git = new FakeGit();
    const own = show({ store, git }, "own");
    assert.equal(own.ok, true);
    if (own.ok) {
      assert.equal(own.data["ticket-key"], "XYZ");
      assert.equal(own.data.resolved_ticket_key, "XYZ");
      assert.equal(own.data.ticket_key_source, "repository");
    }
    const inherited = show({ store, git }, "inherited");
    assert.equal(inherited.ok, true);
    if (inherited.ok) {
      assert.equal(inherited.data.resolved_ticket_key, "ABC");
      assert.equal(inherited.data.ticket_key_source, "system");
    }
    for (const id of ["independent", "no-system-key"]) {
      const result = show({ store, git }, id);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.data.resolved_ticket_key, null, id);
        assert.equal(result.data.ticket_key_source, null, id);
      }
    }
    for (const id of ["alpha", "tracker"]) {
      const result = show({ store, git }, id);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal("resolved_ticket_key" in result.data, false, id);
        assert.equal("ticket_key_source" in result.data, false, id);
      }
    }
  });

  test("reports an unknown ID as entry-not-found with the ID", () => {
    const result = show(catalog(), "missing");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual([result.error.code, result.error.category, result.error.message], ["entry-not-found", "not-found", "unknown entry ID: missing"]);
      assert.deepEqual(result.error.details, { id: "missing" });
    }
  });
});

describe("deps use cases", () => {
  test("report an unknown ID as entry-not-found and deps on an external as usage", () => {
    const ports = catalog();
    for (const result of [deps(ports, "missing"), rdeps(ports, "missing")]) {
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "entry-not-found");
        assert.deepEqual(result.error.details, { id: "missing" });
      }
    }
    const external = deps(ports, "stripe");
    assert.equal(external.ok, false);
    if (!external.ok) {
      assert.deepEqual([external.error.code, external.error.category], ["usage", "usage"]);
      assert.deepEqual(external.error.details, { id: "stripe" });
    }
    assert.equal(rdeps(ports, "stripe").ok, true);
  });
});

describe("relationships across named catalogs", () => {
  const facts = { localPaths: new Map(), localPathsIgnored: { ignored: true } };

  test("resolves dependency IDs in another registered catalog", () => {
    const work = snapshot([{
      kind: "repository",
      id: "app",
      data: { description: "Application.", "depends-on": [{ id: "shared-lib" }] },
      file: "repositories/app.toml",
    }]);
    const shared = snapshot([{
      kind: "repository",
      id: "shared-lib",
      data: { description: "Shared library." },
      file: "repositories/shared-lib.toml",
    }]);
    const result = validateCatalog(work, facts, { catalogName: "work", catalogs: [{ name: "shared", snapshot: shared }] });
    assert.deepEqual(result.errors, []);
  });

  test("rejects duplicate IDs across catalogs and cross-catalog system links", () => {
    const work = snapshot([
      { kind: "system", id: "shared-id", data: { description: "Local system." }, file: "systems/shared-id.toml" },
      { kind: "repository", id: "app", data: { description: "Application.", system: "shared-system" }, file: "repositories/app.toml" },
    ]);
    const shared = snapshot([
      { kind: "system", id: "shared-id", data: { description: "Other system." }, file: "systems/shared-id.toml" },
      { kind: "system", id: "shared-system", data: { description: "Other system." }, file: "systems/shared-system.toml" },
    ]);
    const result = validateCatalog(work, facts, { catalogName: "work", catalogs: [{ name: "shared", snapshot: shared }] });
    assert.ok(result.errors.some((error) => error.includes('duplicate ID "shared-id"') && error.includes('catalog "shared"')));
    assert.ok(result.errors.some((error) => error.includes('system "shared-system" names a system in another catalog')));
  });

  test("reports missing or unreadable registered catalogs during dependency lookup", () => {
    const work = snapshot([{
      kind: "repository",
      id: "app",
      data: { description: "Application.", "depends-on": [{ id: "missing" }] },
      file: "repositories/app.toml",
    }]);
    const missing = validateCatalog(work, facts, { catalogName: "work" });
    assert.ok(missing.errors.some((error) => error.includes('ID "missing" does not exist in any registered catalog')));

    const unreadable = validateCatalog(work, facts, {
      catalogName: "work",
      catalogs: [{ name: "shared", snapshot: snapshot([], ["repository files could not be read"]) }],
    });
    assert.ok(unreadable.errors.some((error) => error.includes('catalog(s) could not be read') && error.includes('"shared"')));
  });
});

describe("add use case", () => {
  test("fake store appends new tags and restores them on rollback", () => {
    const store = new MemoryStore({ tags: { utility: "Shared tools." } });
    const originalTags = structuredClone(store.tags);
    const created = store.createEntry(
      "repository",
      "tagged-repo",
      { description: "Tagged repository.", tags: ["data-pipeline"] },
      undefined,
      [{ name: "data-pipeline", description: "Moves data." }],
    );
    assert.equal(created.status, "created");
    assert.deepEqual(store.tags, { utility: "Shared tools.", "data-pipeline": "Moves data." });
    assert.deepEqual(created.rollback(), []);
    assert.deepEqual(store.tags, originalTags);
    assert.equal(store.entries.some((entry) => entry.id === "tagged-repo"), false);
  });

  test("creates an entry and adds its new tags", () => {
    const ports = catalog();
    const result = add(ports, {
      kind: "repository",
      id: "tagged-repo",
      data: { description: "Tagged repository.", tags: ["data-pipeline", "event-stream"] },
      newTags: [
        { name: "data-pipeline", description: "Moves data." },
        { name: "event-stream", description: "Processes events." },
      ],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.newTags, ["data-pipeline", "event-stream"]);
    assert.deepEqual(ports.store.tags, {
      utility: "Shared tools.",
      "data-pipeline": "Moves data.",
      "event-stream": "Processes events.",
    });
    assert.deepEqual(check(ports).finding.errors, []);
  });

  test("rejects invalid new tags without changing the store", () => {
    const ports = catalog();
    Object.defineProperty(ports.store.tags!, "constructor", { value: "Builds things.", enumerable: true });
    const originalTags = structuredClone(ports.store.tags);
    const cases = [
      { name: "Data_Pipeline", tags: ["Data_Pipeline"] },
      { name: "toString", tags: ["toString"] },
      { name: "utility", tags: ["utility"] },
      { name: "constructor", tags: ["constructor"] },
      { name: "unused-tag", tags: [] },
    ];
    for (const item of cases) {
      const result = add(ports, {
        kind: "repository",
        id: `bad-${item.name.toLowerCase().replaceAll("_", "-")}`,
        data: { description: "Invalid tag.", tags: item.tags },
        newTags: [{ name: item.name, description: "New description." }],
      });
      const error = failed(result, "invalid-entry", item.name);
      assert.equal(error.category, "refused", item.name);
      assert.ok(details(error).errors.length > 0, item.name);
      assert.equal(ports.store.entries.some((entry) => entry.id === `bad-${item.name.toLowerCase().replaceAll("_", "-")}`), false);
      assert.deepEqual(ports.store.tags, originalTags);
    }
  });

  test("fake store does not restore tags changed before rollback", () => {
    const store = new MemoryStore({ tags: { utility: "Shared tools." } });
    store.changeBeforeRollback = new Set(["tags"]);
    const created = store.createEntry(
      "repository",
      "tagged-repo",
      { description: "Tagged repository.", tags: ["data-pipeline"] },
      undefined,
      [{ name: "data-pipeline", description: "Moves data." }],
    );
    assert.equal(created.status, "created");
    assert.deepEqual(created.rollback(), ["the tag list changed during rollback and could not be restored"]);
    assert.deepEqual(store.tags, { utility: "Shared tools.", "data-pipeline": "Moves data.", other: "changed" });
  });

  test("creates an entry and records its local path", () => {
    const ports = catalog();
    const result = add(ports, {
      kind: "repository",
      id: "new-repo",
      data: { description: "New.", remote: "https://example.com/shop/new-repo.git", tags: ["utility"] },
      localPath: "/work/new-repo",
    });
    assert.deepEqual(result, {
      ok: true,
      type: "repository",
      id: "new-repo",
      validation: { errors: [], warnings: [] },
      newTags: [],
    });
    assert.ok(ports.store.files.has("repositories/new-repo.toml"));
    assert.deepEqual(ports.store.localPaths, { "alpha-app": "/work/alpha-app", "new-repo": "/work/new-repo" });
    assert.deepEqual(check(ports).finding.errors, []);
  });

  test("reports a stale local path after catalog warnings", () => {
    const ports = catalog({ "alpha-app": "/work/alpha-app", "new-repo": "/work/old-repo" });
    ports.store.entries.push({
      kind: "external",
      id: "old-service",
      data: { description: "Old service.", status: "deprecated" },
      file: "externals/old-service.toml",
    });
    const result = add(ports, {
      kind: "repository",
      id: "new-repo",
      data: { description: "New.", "depends-on": [{ id: "old-service" }] },
      localPath: "/work/new-repo",
    });
    assert.ok(result.ok);
    const catalogWarning = result.validation.warnings.findIndex((warning) => warning.includes('deprecated entry "old-service"'));
    const pathWarning = result.validation.warnings.findIndex((warning) => warning === 'replaced the existing local path for "new-repo" in the local paths');
    assert.ok(catalogWarning >= 0);
    assert.ok(pathWarning > catalogWarning);
    assert.deepEqual(ports.store.localPaths, { "alpha-app": "/work/alpha-app", "new-repo": "/work/new-repo" });
    assert.deepEqual(check(ports).finding.errors, []);
  });

  test("rolls back a replaced local path after failed revalidation", () => {
    const ports = catalog({ "alpha-app": "/work/alpha-app", "rollback-repo": "/work/old-repo" });
    const original = structuredClone(ports.store.localPaths);
    const result = add(ports, {
      kind: "repository",
      id: "rollback-repo",
      data: { description: "Rollback." },
      localPath: "/work/absent",
    });
    const error = details(failed(result, "invalid-entry"));
    assert.ok(error.errors.some((message) => message.includes("path does not exist")));
    assert.deepEqual(error.warnings, ['replaced the existing local path for "rollback-repo" in the local paths']);
    assert.deepEqual(ports.store.localPaths, original);
    assert.equal(ports.store.entries.some((entry) => entry.id === "rollback-repo"), false);
  });

  test("rejects an ID used by another entry type", () => {
    const ports = catalog();
    const result = add(ports, { kind: "external", id: "alpha-app", data: { description: "Duplicate." } });
    const error = failed(result, "invalid-entry");
    assert.equal(error.message, "could not add external alpha-app: validation failed");
    assert.deepEqual(error.details, { errors: ['ID "alpha-app" already exists'], warnings: [] });
    assert.equal(ports.store.files.size, 0);
  });

  test("rejects an ID whose entry file exists but cannot be read", () => {
    const ports = catalog();
    ports.store.unreadable.push("systems/broken.toml");
    const result = add(ports, { kind: "repository", id: "broken", data: { description: "Duplicate." } });
    assert.deepEqual(details(failed(result, "invalid-entry")).errors, ['ID "broken" already exists']);
    assert.equal(ports.store.files.size, 0);
  });

  test("rejects an entry path that Git does not ignore", () => {
    const ports = catalog();
    ports.git.notIgnored.add("systems/new-system.toml");
    const result = add(ports, { kind: "system", id: "new-system", data: { description: "New." } });
    const error = failed(result, "refused");
    assert.equal(error.message, "could not add system new-system: Git does not ignore the entry");
    assert.deepEqual(details(error).errors, ["system new-system is not ignored by Git"]);
    assert.equal(ports.store.files.size, 0);
  });

  test("rejects invalid input before writing", () => {
    const ports = catalog();
    const result = add(ports, { kind: "repository", id: "bad", data: { description: "Bad.", key: "ALP", tags: ["unknown"] } });
    assert.deepEqual(details(failed(result, "invalid-entry")).errors, [
      'repository bad: duplicate key "ALP"; also used by repository alpha-app',
      'repository bad: tag "unknown" is not defined in the tag list',
    ]);
    assert.equal(ports.store.files.size, 0);
  });

  test("rejects a tag that the tags table only inherits", () => {
    const ports = catalog();
    const result = add(ports, {
      kind: "repository",
      id: "inherited-tag",
      data: { description: "Inherited tag.", tags: ["toString"] },
      localPath: "/work/new-repo",
    });
    assert.deepEqual(details(failed(result, "invalid-entry")).errors, ['repository inherited-tag: tag "toString" is not defined in the tag list']);
    assert.ok(!ports.store.entries.some((entry) => entry.id === "inherited-tag"));
    assert.equal(ports.store.files.size, 0);
    assert.deepEqual(ports.store.localPaths, { "alpha-app": "/work/alpha-app" });
  });

  test("rolls back a failed revalidation and restores tags and local paths", () => {
    const ports = catalog();
    const originalTags = structuredClone(ports.store.tags);
    const result = add(ports, {
      kind: "repository",
      id: "rollback-repo",
      data: { description: "Rollback.", tags: ["data-pipeline"] },
      localPath: "/work/absent",
      newTags: [{ name: "data-pipeline", description: "Moves data." }],
    });
    assert.deepEqual(details(failed(result, "invalid-entry")).errors, ['the local paths: path does not exist: /work/absent for "rollback-repo"']);
    assert.ok(!ports.store.entries.some((entry) => entry.id === "rollback-repo"));
    assert.equal(ports.store.files.size, 0);
    assert.deepEqual(ports.store.localPaths, { "alpha-app": "/work/alpha-app" });
    assert.deepEqual(ports.store.tags, originalTags);
  });

  test("rolls back a failed revalidation when no local paths existed", () => {
    const ports = catalog(null);
    const result = add(ports, {
      kind: "repository",
      id: "rollback-new",
      data: { description: "Rollback.", remote: "https://example.com/wanted.git" },
      localPath: "/work/new-repo",
    });
    assert.deepEqual(details(failed(result, "invalid-entry")).errors, ['the local paths: remote does not match "https://example.com/wanted.git" for "rollback-new"']);
    assert.ok(!ports.store.entries.some((entry) => entry.id === "rollback-new"));
    assert.equal(ports.store.localPaths, null);
  });

  test("reports a failed rollback as external with its errors", () => {
    const ports = catalog();
    ports.store.changeBeforeRollback = new Set(["entry", "localPaths"]);
    const result = add(ports, {
      kind: "repository",
      id: "changed",
      data: { description: "Changed." },
      localPath: "/work/absent",
    });
    const error = failed(result, "external");
    assert.equal(error.message, "could not add repository changed: validation failed, and the rollback failed");
    assert.deepEqual(details(error).errors, [
      'the local paths: path does not exist: /work/absent for "changed"',
      "the local paths changed during rollback and could not be restored",
      "repository changed changed during rollback and was not removed",
    ]);
    assert.ok(ports.store.entries.some((entry) => entry.id === "changed"));
  });

  test("reports a failed write as external", () => {
    const ports = catalog();
    ports.store.failWrite = "disk full";
    const result = add(ports, { kind: "system", id: "new-system", data: { description: "New." } });
    const error = failed(result, "external");
    assert.equal(error.category, "external");
    assert.equal(error.message, "could not add system new-system: a write failed");
    assert.deepEqual(error.details, { errors: ["could not write system new-system: disk full"], warnings: [] });
  });
});

describe("set use case", () => {
  test("protects an existing key and allows a deliberate replacement", () => {
    const ports = catalog();
    const same = set(ports, { id: "alpha-app", data: { key: "ALP" } });
    assert.ok(same.ok);
    assert.deepEqual(same.changed, []);

    const refused = set(ports, { id: "alpha-app", data: { key: "BET" } });
    assert.deepEqual(details(failed(refused, "invalid-entry")).errors, [
      "repository alpha-app: changing an existing key requires --replace-key",
    ]);
    assert.equal(ports.store.entries.find((entry) => entry.id === "alpha-app")?.data.key, "ALP");

    const missingKey = set(ports, { id: "alpha-app", data: { description: "Updated." }, replaceKey: true });
    assert.equal(failed(missingKey, "usage").message, "--replace-key requires key in --data");

    const replaced = set(ports, { id: "alpha-app", data: { key: "BET" }, replaceKey: true });
    assert.ok(replaced.ok);
    assert.deepEqual(replaced.changed, ["key"]);
    assert.equal(ports.store.entries.find((entry) => entry.id === "alpha-app")?.data.key, "BET");
  });

  test("rejects invalid merged data without changing the store", () => {
    const ports = catalog();
    ports.store.entries.push({
      kind: "repository",
      id: "beta-lib",
      data: { description: "Beta library." },
      file: "repositories/beta-lib.toml",
    });
    const cases = [
      { data: { extra: true }, expected: "repository beta-lib: unknown field(s): extra" },
      { data: { tags: ["missing"] }, expected: 'repository beta-lib: tag "missing" is not defined in the tag list' },
      { data: { system: "missing" }, expected: 'repository beta-lib: system "missing" does not name a system' },
      { data: { "depends-on": [{ id: "missing" }] }, expected: 'repository beta-lib: depends-on[0] ID "missing" does not exist' },
      { data: { key: "ALP" }, replaceKey: true, expected: 'repository beta-lib: duplicate key "ALP"; also used by repository alpha-app' },
    ];
    for (const item of cases) {
      const entriesBefore = structuredClone(ports.store.entries);
      const filesBefore = new Map(ports.store.files);
      const result = set(ports, { id: "beta-lib", ...item });
      const { errors } = details(failed(result, "invalid-entry", item.expected));
      assert.ok(errors.includes(item.expected), JSON.stringify(errors));
      assert.deepEqual(ports.store.entries, entriesBefore);
      assert.deepEqual(ports.store.files, filesBefore);
    }
  });

  test("refuses options that do not fit the data or the entry as usage errors", () => {
    const ports = catalog();
    const cases = [
      { options: { data: { id: "other" } }, expected: "--data must not contain id" },
      { options: { data: { description: null } }, expected: "--data must not contain JSON null values" },
      { options: { id: "stripe", localPath: "/work/new-repo" }, expected: "--local-path is valid only for a repository" },
      { options: {}, expected: "set requires --data or --local-path" },
    ];
    for (const item of cases) {
      const error = failed(set(ports, { id: "alpha-app", ...item.options }), "usage", item.expected);
      assert.deepEqual([error.message, error.details], [item.expected, {}]);
    }
  });

  test("reports unknown and unreadable IDs", () => {
    const ports = catalog();
    const unknown = failed(set(ports, { id: "missing", data: { description: "No entry." } }), "entry-not-found");
    assert.deepEqual([unknown.message, unknown.details], ["unknown entry ID: missing", { id: "missing" }]);

    ports.store.unreadable.push("repositories/broken.toml");
    const unreadable = failed(set(ports, { id: "broken", data: { description: "No entry." } }), "invalid-entry");
    assert.equal(unreadable.message, "could not set entry broken: validation failed");
    assert.deepEqual(details(unreadable).errors, ["repository broken: invalid TOML: unreadable"]);
  });

  test("reports a failed write as external", () => {
    const ports = catalog();
    ports.store.failWrite = "disk full";
    const error = failed(set(ports, { id: "alpha-app", data: { description: "Updated." } }), "external");
    assert.match(error.message, /^could not set repository alpha-app: /);
    assert.ok(details(error).errors.length > 0);
  });

  test("returns success and does not write when current values are supplied", () => {
    const ports = catalog();
    const result = set(ports, {
      id: "alpha-app",
      data: { description: "Alpha application.", key: "ALP", system: "alpha" },
    });
    assert.ok(result.ok);
    assert.deepEqual(result.changed, []);
    assert.equal(ports.store.files.size, 0);
  });

  test("adds a key to a repository that does not have one", () => {
    const ports = catalog();
    ports.store.entries.push({
      kind: "repository",
      id: "beta-lib",
      data: { description: "Beta library." },
      file: "repositories/beta-lib.toml",
    });
    const result = set(ports, { id: "beta-lib", data: { key: "BET" } });
    assert.ok(result.ok);
    assert.deepEqual(result.changed, ["key"]);
    assert.equal(ports.store.entries.find((entry) => entry.id === "beta-lib")?.data.key, "BET");
  });
});
