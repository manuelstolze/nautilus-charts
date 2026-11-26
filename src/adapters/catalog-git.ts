import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { CatalogGit as CatalogGitPort } from "../commands/ports.ts";
import { remoteHasCredentials } from "../domain/validation.ts";

function runGit(args: string[], cwd?: string, timeout = 120_000): string {
  const result = spawnSync("git", args, {
    ...(cwd ? { cwd } : {}),
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw new Error(`Git could not run: ${result.error.message}`);
  if (result.status !== 0) {
    const reason = result.stderr.trim() || `Git exited with code ${result.status}`;
    throw new Error(reason);
  }
  return result.stdout.trim();
}

function validateRemote(remote: string): void {
  if (!remote.trim()) throw new Error("catalog remote must not be empty");
  if (remoteHasCredentials(remote)) throw new Error("catalog remote must not contain credentials");
  if (/^https?:\/\//i.test(remote)) {
    try {
      new URL(remote);
    } catch {
      throw new Error("catalog remote must be a valid Git address");
    }
  }
}

function assertEmptyOrMissing(path: string): void {
  if (!existsSync(path)) return;
  if (!statSync(path).isDirectory()) throw new Error("catalog path must be a directory");
  if (readdirSync(path).length > 0) throw new Error("catalog path must be empty");
}

function assertSingleRemote(path: string, remote: string): void {
  const remotes = runGit(["remote"], path).split("\n").filter(Boolean);
  if (remotes.length !== 1 || remotes[0] !== "origin") {
    throw new Error("catalog must have exactly one Git remote named origin");
  }
  const configured = runGit(["remote", "get-url", "origin"], path);
  if (configured !== remote) throw new Error("catalog origin does not match the requested remote");
}

const INITIAL_FILES = [
  ".gitignore",
  "tags.toml",
  "templates/system.toml",
  "templates/repository.toml",
  "templates/external.toml",
];

function hasCommit(path: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: path, encoding: "utf8" });
  return result.status === 0;
}

/** Git setup for named catalog repositories. Never used for listed code repositories. */
export class CatalogGitCli implements CatalogGitPort {
  readonly templatesRoot: string;

  constructor(templatesRoot: string) {
    this.templatesRoot = resolve(templatesRoot);
  }

  initialize(rawPath: string, remote: string): void {
    validateRemote(remote);
    const path = resolve(rawPath);
    assertEmptyOrMissing(path);
    mkdirSync(path, { recursive: true });
    for (const directory of ["systems", "repositories", "externals", "local", "templates"]) {
      mkdirSync(join(path, directory), { recursive: true });
    }
    for (const kind of ["system", "repository", "external"]) {
      copyFileSync(join(this.templatesRoot, "templates", `${kind}.toml`), join(path, "templates", `${kind}.toml`));
    }
    writeFileSync(join(path, "tags.toml"), "", { encoding: "utf8", flag: "wx" });
    writeFileSync(join(path, ".gitignore"), "/local/paths.toml\n", { encoding: "utf8", flag: "wx" });
    runGit(["init", "--quiet", path]);
    runGit(["remote", "add", "origin", remote], path);
    assertSingleRemote(path, remote);
  }

  clone(rawPath: string, remote: string): void {
    validateRemote(remote);
    const path = resolve(rawPath);
    assertEmptyOrMissing(path);
    mkdirSync(join(path, ".."), { recursive: true });
    runGit(["clone", "--quiet", "--", remote, path]);
    assertSingleRemote(path, remote);
  }

  assertWriteClean(rawPath: string, files: readonly string[]): void {
    const path = resolve(rawPath);
    const initial = !hasCommit(path);
    for (const file of new Set(files)) {
      if (initial && INITIAL_FILES.includes(file)) continue;
      if (runGit(["status", "--porcelain", "--untracked-files=all", "--", file], path)) {
        throw new Error("catalog has uncommitted changes to an entry or tag file");
      }
    }
  }

  commit(rawPath: string, files: readonly string[], message: string): void {
    const path = resolve(rawPath);
    const initial = !hasCommit(path);
    const paths = [...new Set([...files, ...(initial ? INITIAL_FILES : [])])]
      .filter((file) => existsSync(join(path, file)));
    if (paths.length === 0) throw new Error("catalog commit has no files");
    try {
      runGit(["add", "--", ...paths], path);
      runGit(["commit", "--only", "-m", message, "--", ...paths], path);
    } catch (error) {
      try {
        runGit(["reset", "--quiet", "--", ...paths], path);
      } catch {
        // Keep the commit failure as the useful error. The caller rolls back its files.
      }
      throw error;
    }
  }

  syncRead(rawPath: string, remote: string): void {
    validateRemote(remote);
    const path = resolve(rawPath);
    assertSingleRemote(path, remote);
    const branch = hasCommit(path) ? runGit(["branch", "--show-current"], path) : "";
    const remoteHead = runGit(["ls-remote", "--symref", "origin", "HEAD"], path, 30_000);
    if (!branch) {
      if (remoteHead) throw new Error("catalog has no local commit for its remote history");
      return;
    }
    if (!remoteHead) return;
    const remoteBranch = remoteHead.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/m)?.[1];
    if (remoteBranch && remoteBranch !== branch) throw new Error("catalog branch does not match the remote default branch");
    const remoteRef = `refs/heads/${branch}`;
    if (!runGit(["ls-remote", "--heads", "origin", remoteRef], path, 30_000)) return;
    runGit(["fetch", "--quiet", "origin", remoteRef], path, 30_000);
    runGit(["merge", "--ff-only", "--no-edit", "FETCH_HEAD"], path);
  }

  syncWrite(rawPath: string, remote: string): void {
    validateRemote(remote);
    const path = resolve(rawPath);
    this.syncRead(path, remote);
    assertSingleRemote(path, remote);
    if (!hasCommit(path)) throw new Error("catalog has no local commit to sync");
    const branch = runGit(["branch", "--show-current"], path);
    if (!branch) throw new Error("catalog is not on a branch");
    runGit(["push", "--porcelain", "origin", `HEAD:refs/heads/${branch}`], path, 30_000);
  }
}
