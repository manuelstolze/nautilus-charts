import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { CatalogGit as CatalogGitPort } from "../commands/ports.ts";

function runGit(args: string[], cwd?: string): string {
  const result = spawnSync("git", args, {
    ...(cwd ? { cwd } : {}),
    encoding: "utf8",
    timeout: 120_000,
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
  if (/^https?:\/\//i.test(remote)) {
    try {
      const address = new URL(remote);
      if (address.username || address.password) throw new Error("catalog remote must not contain credentials");
    } catch (error) {
      if (error instanceof Error && error.message === "catalog remote must not contain credentials") throw error;
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
}
