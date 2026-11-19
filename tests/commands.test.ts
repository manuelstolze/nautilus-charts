import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { add } from "../src/commands/add.ts";
import { check } from "../src/commands/check.ts";
import { set } from "../src/commands/set.ts";
import { FakeGit } from "./fakes/fake-git.ts";
import { MemoryStore } from "./fakes/memory-store.ts";

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
    assert.deepEqual(result.newTags, ["data-pipeline", "event-stream"]);
    assert.deepEqual(ports.store.tags, {
      utility: "Shared tools.",
      "data-pipeline": "Moves data.",
      "event-stream": "Processes events.",
    });
    assert.equal(check(ports).status, 0);
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
      assert.equal(result.status, 2, item.name);
      assert.equal(result.ok, false, item.name);
      assert.ok(result.validation.errors.length > 0, item.name);
      assert.equal(ports.store.entries.some((entry) => entry.id === result.id), false);
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
    assert.deepEqual(created.rollback(), ["tags.toml changed during rollback and was not restored"]);
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
      path: "repositories/new-repo.toml",
      validation: { errors: [], warnings: [] },
      newTags: [],
      status: 0,
    });
    assert.ok(ports.store.files.has("repositories/new-repo.toml"));
    assert.deepEqual(ports.store.localPaths, { "alpha-app": "/work/alpha-app", "new-repo": "/work/new-repo" });
    assert.equal(check(ports).status, 0);
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
    const catalogWarning = result.validation.warnings.findIndex((warning) => warning.includes('deprecated entry "old-service"'));
    const pathWarning = result.validation.warnings.findIndex((warning) => warning === 'replaced the existing local path for "new-repo" in local/paths.toml');
    assert.equal(result.ok, true);
    assert.ok(catalogWarning >= 0);
    assert.ok(pathWarning > catalogWarning);
    assert.deepEqual(ports.store.localPaths, { "alpha-app": "/work/alpha-app", "new-repo": "/work/new-repo" });
    assert.equal(check(ports).status, 0);
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
    assert.equal(result.status, 1);
    assert.ok(result.validation.errors.some((error) => error.includes("path does not exist")));
    assert.deepEqual(result.validation.warnings, ['replaced the existing local path for "rollback-repo" in local/paths.toml']);
    assert.deepEqual(ports.store.localPaths, original);
    assert.equal(ports.store.entries.some((entry) => entry.id === "rollback-repo"), false);
  });

  test("rejects an ID used by another entry type", () => {
    const ports = catalog();
    const result = add(ports, { kind: "external", id: "alpha-app", data: { description: "Duplicate." } });
    assert.equal(result.status, 2);
    assert.deepEqual(result.validation.errors, ['ID "alpha-app" already exists']);
    assert.equal(result.path, "externals/alpha-app.toml");
    assert.equal(ports.store.files.size, 0);
  });

  test("rejects an ID whose entry file exists but cannot be read", () => {
    const ports = catalog();
    ports.store.unreadable.push("systems/broken.toml");
    const result = add(ports, { kind: "repository", id: "broken", data: { description: "Duplicate." } });
    assert.equal(result.status, 2);
    assert.deepEqual(result.validation.errors, ['ID "broken" already exists']);
    assert.equal(ports.store.files.size, 0);
  });

  test("rejects an entry path that Git does not ignore", () => {
    const ports = catalog();
    ports.git.notIgnored.add("systems/new-system.toml");
    const result = add(ports, { kind: "system", id: "new-system", data: { description: "New." } });
    assert.equal(result.status, 2);
    assert.deepEqual(result.validation.errors, ["systems/new-system.toml is not ignored by Git"]);
    assert.equal(ports.store.files.size, 0);
  });

  test("rejects invalid input before writing", () => {
    const ports = catalog();
    const result = add(ports, { kind: "repository", id: "bad", data: { description: "Bad.", key: "ALP", tags: ["unknown"] } });
    assert.equal(result.status, 2);
    assert.deepEqual(result.validation.errors, [
      'repositories/bad.toml: duplicate key "ALP"; also used by repositories/alpha-app.toml',
      'repositories/bad.toml: tag "unknown" is not defined in tags.toml',
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
    assert.equal(result.status, 2);
    assert.equal(result.ok, false);
    assert.deepEqual(result.validation.errors, ['repositories/inherited-tag.toml: tag "toString" is not defined in tags.toml']);
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
    assert.equal(result.status, 1);
    assert.equal(result.ok, false);
    assert.deepEqual(result.validation.errors, ['local/paths.toml: path does not exist: /work/absent for "rollback-repo"']);
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
    assert.equal(result.status, 1);
    assert.deepEqual(result.validation.errors, ['local/paths.toml: remote does not match "https://example.com/wanted.git" for "rollback-new"']);
    assert.ok(!ports.store.entries.some((entry) => entry.id === "rollback-new"));
    assert.equal(ports.store.localPaths, null);
  });

  test("reports rollback errors when files changed before the rollback", () => {
    const ports = catalog();
    ports.store.changeBeforeRollback = new Set(["entry", "localPaths"]);
    const result = add(ports, {
      kind: "repository",
      id: "changed",
      data: { description: "Changed." },
      localPath: "/work/absent",
    });
    assert.equal(result.status, 1);
    assert.deepEqual(result.validation.errors, [
      'local/paths.toml: path does not exist: /work/absent for "changed"',
      "local/paths.toml changed during rollback and was not restored",
      "new entry changed during rollback and was not removed",
    ]);
    assert.ok(ports.store.entries.some((entry) => entry.id === "changed"));
  });

  test("reports a failed write with exit status 1", () => {
    const ports = catalog();
    ports.store.failWrite = "disk full";
    const result = add(ports, { kind: "system", id: "new-system", data: { description: "New." } });
    assert.equal(result.status, 1);
    assert.deepEqual(result.validation.errors, ["could not write entry: disk full"]);
  });
});

describe("set use case", () => {
  test("protects an existing key and allows a deliberate replacement", () => {
    const ports = catalog();
    const same = set(ports, { id: "alpha-app", data: { key: "ALP" } });
    assert.equal(same.ok, true);
    assert.deepEqual(same.changed, []);

    const refused = set(ports, { id: "alpha-app", data: { key: "BET" } });
    assert.equal(refused.status, 2);
    assert.deepEqual(refused.validation.errors, [
      "repositories/alpha-app.toml: changing an existing key requires --replace-key",
    ]);
    assert.equal(ports.store.entries.find((entry) => entry.id === "alpha-app")?.data.key, "ALP");

    const missingKey = set(ports, { id: "alpha-app", data: { description: "Updated." }, replaceKey: true });
    assert.equal(missingKey.status, 2);
    assert.deepEqual(missingKey.validation.errors, ["--replace-key requires key in --data"]);

    const replaced = set(ports, { id: "alpha-app", data: { key: "BET" }, replaceKey: true });
    assert.equal(replaced.ok, true);
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
      { data: { extra: true }, expected: "repositories/beta-lib.toml: unknown field(s): extra" },
      { data: { id: "other" }, expected: "--data must not contain id" },
      { data: { description: null }, expected: "--data must not contain JSON null values" },
      { data: { tags: ["missing"] }, expected: 'repositories/beta-lib.toml: tag "missing" is not defined in tags.toml' },
      { data: { system: "missing" }, expected: 'repositories/beta-lib.toml: system "missing" does not name a system' },
      { data: { "depends-on": [{ id: "missing" }] }, expected: 'repositories/beta-lib.toml: depends-on[0] ID "missing" does not exist' },
      { data: { key: "ALP" }, replaceKey: true, expected: 'repositories/beta-lib.toml: duplicate key "ALP"; also used by repositories/alpha-app.toml' },
    ];
    for (const item of cases) {
      const entriesBefore = structuredClone(ports.store.entries);
      const filesBefore = new Map(ports.store.files);
      const result = set(ports, { id: "beta-lib", ...item });
      assert.equal(result.status, 2, item.expected);
      assert.ok(result.validation.errors.includes(item.expected), JSON.stringify(result.validation.errors));
      assert.deepEqual(ports.store.entries, entriesBefore);
      assert.deepEqual(ports.store.files, filesBefore);
    }
  });

  test("reports unknown and unreadable IDs", () => {
    const ports = catalog();
    const unknown = set(ports, { id: "missing", data: { description: "No entry." } });
    assert.equal(unknown.status, 2);
    assert.equal(unknown.type, null);
    assert.deepEqual(unknown.validation.errors, ['unknown ID "missing"']);

    ports.store.unreadable.push("repositories/broken.toml");
    const unreadable = set(ports, { id: "broken", data: { description: "No entry." } });
    assert.equal(unreadable.status, 2);
    assert.equal(unreadable.path, "repositories/broken.toml");
    assert.deepEqual(unreadable.validation.errors, ["cannot read entry repositories/broken.toml"]);
  });

  test("returns success and does not write when current values are supplied", () => {
    const ports = catalog();
    const result = set(ports, {
      id: "alpha-app",
      data: { description: "Alpha application.", key: "ALP", system: "alpha" },
    });
    assert.equal(result.ok, true);
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
    assert.equal(result.ok, true);
    assert.deepEqual(result.changed, ["key"]);
    assert.equal(ports.store.entries.find((entry) => entry.id === "beta-lib")?.data.key, "BET");
  });
});
