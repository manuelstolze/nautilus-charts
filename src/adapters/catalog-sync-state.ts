import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface SyncStateFile {
  version: 1;
  lastAttemptedAt: Record<string, number>;
}

function emptyState(): SyncStateFile {
  return { version: 1, lastAttemptedAt: Object.create(null) as Record<string, number> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Stores per-catalog read-sync attempts outside the catalog repositories. */
export class FileCatalogSyncState {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  lastAttemptedAt(name: string): number | null {
    const state = this.load();
    const timestamp = state.lastAttemptedAt[name];
    return typeof timestamp === "number" ? timestamp : null;
  }

  markAttemptedAt(name: string, timestamp: number): void {
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("catalog sync time must be a non-negative integer");
    const state = this.load();
    state.lastAttemptedAt[name] = timestamp;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporaryPath, this.path);
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }

  private load(): SyncStateFile {
    if (!existsSync(this.path)) return emptyState();
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`cannot read catalog sync state: ${reason}`);
    }
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.lastAttemptedAt)) {
      throw new Error("catalog sync state has an invalid format");
    }
    const timestamps: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const [name, timestamp] of Object.entries(value.lastAttemptedAt)) {
      if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new Error("catalog sync state has an invalid timestamp");
      }
      timestamps[name] = timestamp;
    }
    return { version: 1, lastAttemptedAt: timestamps };
  }
}
