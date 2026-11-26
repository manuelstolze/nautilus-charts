import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { isString } from "../domain/entry.ts";
import type { IgnoreCheck, LocalPathFact } from "../domain/validation.ts";
import type { GitInspector } from "../commands/ports.ts";

// Local Git only: no command here contacts a remote (constitution rule III).

function gitOutput(path: string, ...args: string[]): string | null {
  const result = spawnSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    timeout: 5000,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitRemotes(path: string): Set<string> {
  const output = gitOutput(path, "remote", "-v");
  if (!output) return new Set();
  const remotes = new Set<string>();
  for (const line of output.split("\n")) {
    const match = line.match(/^\S+\s+(\S+)\s+\(/);
    if (match) remotes.add(match[1]);
  }
  return remotes;
}

function localPathError(path: string, remote?: unknown): string | null {
  if (!existsSync(path)) return `path does not exist: ${path}`;
  try {
    if (!statSync(path).isDirectory()) return `not a Git repository root: ${path}`;
  } catch {
    return `cannot read local path: ${path}`;
  }
  const gitRoot = gitOutput(path, "rev-parse", "--show-toplevel");
  try {
    if (!gitRoot || realpathSync(gitRoot) !== realpathSync(path)) return `not a Git repository root: ${path}`;
  } catch {
    return `not a Git repository root: ${path}`;
  }
  if (isString(remote) && !gitRemotes(path).has(remote)) return `remote does not match ${JSON.stringify(remote)}`;
  return null;
}

export class GitCli implements GitInspector {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Expands `~` and resolves relative paths against the catalog root. */
  private resolveLocalPath(rawPath: string): string {
    if (rawPath === "~") return homedir();
    if (rawPath.startsWith("~/")) return resolve(homedir(), rawPath.slice(2));
    return isAbsolute(rawPath) ? resolve(rawPath) : resolve(this.root, rawPath);
  }

  inspectLocalPath(rawPath: string, remote?: unknown, _catalogName?: string): LocalPathFact {
    const resolved = this.resolveLocalPath(rawPath);
    return { resolved, error: localPathError(resolved, remote) };
  }

  isIgnored(relativePath: string): IgnoreCheck {
    const result = spawnSync("git", ["check-ignore", "-q", relativePath], {
      cwd: this.root,
      encoding: "utf8",
    });
    if (result.error) return { error: result.error.message };
    return { ignored: result.status === 0 };
  }
}
