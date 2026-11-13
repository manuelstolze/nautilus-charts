import type { GitInspector } from "../../src/commands/ports.ts";
import { isString } from "../../src/domain/entry.ts";
import type { IgnoreCheck, LocalPathFact } from "../../src/domain/validation.ts";

/** A fake Git adapter that answers from configured repositories and ignore rules. */
export class FakeGit implements GitInspector {
  /** Local repository roots and their remotes. */
  readonly repositories: Map<string, string[]>;
  /** Paths that Git does not ignore. All other paths are ignored. */
  readonly notIgnored: Set<string>;

  constructor(options: { repositories?: Record<string, string[]>; notIgnored?: string[] } = {}) {
    this.repositories = new Map(Object.entries(options.repositories ?? {}));
    this.notIgnored = new Set(options.notIgnored ?? []);
  }

  inspectLocalPath(rawPath: string, remote?: unknown): LocalPathFact {
    const remotes = this.repositories.get(rawPath);
    if (!remotes) return { resolved: rawPath, error: `path does not exist: ${rawPath}` };
    if (isString(remote) && !remotes.includes(remote)) {
      return { resolved: rawPath, error: `remote does not match ${JSON.stringify(remote)}` };
    }
    return { resolved: rawPath, error: null };
  }

  isIgnored(relativePath: string): IgnoreCheck {
    return { ignored: !this.notIgnored.has(relativePath) };
  }
}
