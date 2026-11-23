import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";

// scripts/tag-version.mjs against a temporary repository whose origin is a
// local bare repository, so the test needs no network and no GitHub.

const SCRIPT = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "scripts", "tag-version.mjs");

let temporary: string;
let work: string;
let remote: string;
let env: NodeJS.ProcessEnv;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

function commit(message: string): string {
  writeFileSync(join(work, "file.txt"), `${message}\n`, "utf8");
  git(work, "add", "file.txt");
  git(work, "commit", "-q", "-m", message);
  return git(work, "rev-parse", "HEAD");
}

/** The tags in the bare remote, as "name sha" lines sorted by name. */
function remoteTags(): string[] {
  const output = git(remote, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/tags");
  return output === "" ? [] : output.split("\n").sort();
}

function runScript() {
  return spawnSync(process.execPath, [SCRIPT], { cwd: work, env, encoding: "utf8" });
}

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "charts-tag-version-"));
  work = join(temporary, "work");
  remote = join(temporary, "remote.git");
  const globalConfig = join(temporary, "gitconfig");
  writeFileSync(globalConfig, "", "utf8");
  env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  git(temporary, "init", "-q", "--bare", remote);
  git(temporary, "init", "-q", "-b", "main", work);
  writeFileSync(join(work, "package.json"), `${JSON.stringify({ name: "shop", version: "1.2.3" })}\n`, "utf8");
  git(work, "add", "package.json");
  git(work, "commit", "-q", "-m", "first");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-q", "origin", "main");
});

afterEach(() => {
  rmSync(temporary, { recursive: true, force: true });
});

describe("tag-version script", () => {
  test("creates v<version> on HEAD and pushes it when the remote has no such tag", () => {
    const head = commit("second");
    const result = runScript();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /created and pushed v1\.2\.3/);
    assert.deepEqual(remoteTags(), [`v1.2.3 ${head}`]);
  });

  test("leaves the tags unchanged and succeeds when v<version> is already on HEAD", () => {
    const head = commit("second");
    git(work, "tag", "v1.2.3");
    git(work, "push", "-q", "origin", "v1.2.3");
    const before = remoteTags();
    const result = runScript();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /v1\.2\.3 already exists/);
    assert.deepEqual(remoteTags(), before);
    assert.deepEqual(before, [`v1.2.3 ${head}`]);
  });

  test("leaves the tags unchanged and succeeds when v<version> is on another commit", () => {
    const tagged = git(work, "rev-parse", "HEAD");
    git(work, "tag", "v1.2.3");
    git(work, "push", "-q", "origin", "v1.2.3");
    git(work, "tag", "-d", "v1.2.3");
    commit("second");
    const result = runScript();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /v1\.2\.3 already exists/);
    assert.deepEqual(remoteTags(), [`v1.2.3 ${tagged}`]);
    assert.equal(git(work, "tag", "--list"), "");
  });

  test("fails with a non-zero exit when a Git command fails", () => {
    git(work, "remote", "set-url", "origin", join(temporary, "missing.git"));
    const result = runScript();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tag-version:/);
  });
});
