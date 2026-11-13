import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { add } from "../src/commands/add.ts";
import { check } from "../src/commands/check.ts";
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
      status: 0,
    });
    assert.ok(ports.store.files.has("repositories/new-repo.toml"));
    assert.deepEqual(ports.store.localPaths, { "alpha-app": "/work/alpha-app", "new-repo": "/work/new-repo" });
    assert.equal(check(ports).status, 0);
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

  test("rolls back a failed revalidation and restores the previous local paths", () => {
    const ports = catalog();
    const result = add(ports, {
      kind: "repository",
      id: "rollback-repo",
      data: { description: "Rollback." },
      localPath: "/work/absent",
    });
    assert.equal(result.status, 1);
    assert.equal(result.ok, false);
    assert.deepEqual(result.validation.errors, ['local/paths.toml: path does not exist: /work/absent for "rollback-repo"']);
    assert.ok(!ports.store.entries.some((entry) => entry.id === "rollback-repo"));
    assert.equal(ports.store.files.size, 0);
    assert.deepEqual(ports.store.localPaths, { "alpha-app": "/work/alpha-app" });
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
      "new entry changed during rollback and was not removed",
      "local/paths.toml changed during rollback and was not restored",
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
