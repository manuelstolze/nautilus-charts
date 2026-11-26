import type { CatalogRegistration, CatalogGit } from "../commands/ports.ts";

export interface CatalogSyncState {
  lastAttemptedAt(name: string): number | null;
  markAttemptedAt(name: string, timestamp: number): void;
}

/** Syncs every due registered catalog and keeps going after a failure. */
export function syncDueCatalogs(
  catalogs: readonly CatalogRegistration[],
  git: CatalogGit,
  state: CatalogSyncState,
  intervalMs: number,
  now = Date.now(),
): string[] {
  const warnings: string[] = [];
  for (const catalog of catalogs) {
    let lastAttemptedAt: number | null = null;
    try {
      lastAttemptedAt = state.lastAttemptedAt(catalog.name);
    } catch {
      warnings.push(`catalog ${JSON.stringify(catalog.name)} sync state could not be read; sync was attempted`);
    }
    if (lastAttemptedAt !== null && now - lastAttemptedAt < intervalMs) continue;
    try {
      git.syncRead(catalog.path, catalog.remote);
    } catch {
      warnings.push(`catalog ${JSON.stringify(catalog.name)} could not sync; local data was kept`);
    }
    try {
      state.markAttemptedAt(catalog.name, now);
    } catch {
      warnings.push(`catalog ${JSON.stringify(catalog.name)} sync time could not be saved`);
    }
  }
  return warnings;
}
