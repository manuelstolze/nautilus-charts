#!/usr/bin/env node
// The composition root: it wires the adapters to the use cases.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseArgs,
  readInvocation,
  renderAdd,
  renderCatalog,
  renderCheck,
  renderDescribe,
  renderEdges,
  renderError,
  renderFind,
  renderHelp,
  renderMigrate,
  renderShow,
  renderSet,
  renderUsageError,
  renderVersion,
  type ModuleInfo,
  type Options,
} from "../src/adapters/cli.ts";
import { CatalogGitCli } from "../src/adapters/catalog-git.ts";
import { FileCatalogRegistry, defaultCatalogRegistryPath } from "../src/adapters/catalog-registry.ts";
import { syncDueCatalogs } from "../src/adapters/catalog-sync.ts";
import { FileCatalogSyncState } from "../src/adapters/catalog-sync-state.ts";
import { GitCli } from "../src/adapters/git-cli.ts";
import { TomlStore } from "../src/adapters/toml-store.ts";
import { add } from "../src/commands/add.ts";
import { check } from "../src/commands/check.ts";
import { migrate } from "../src/commands/migrate.ts";
import type { Ports } from "../src/commands/context.ts";
import { deps, rdeps } from "../src/commands/deps.ts";
import { find } from "../src/commands/find.ts";
import { show } from "../src/commands/show.ts";
import { set } from "../src/commands/set.ts";
import type { CatalogRegistration, CatalogStore, GitInspector } from "../src/commands/ports.ts";
import { CatalogIndex, type Snapshot } from "../src/domain/catalog.ts";
import { ChartsError } from "../src/domain/errors.ts";
import { ID_PATTERN } from "../src/domain/entry.ts";
import type { LocalPathFact } from "../src/domain/validation.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The module's name and version from `package.json`, the one place that holds the version. */
export function moduleInfo(): ModuleInfo {
  const { version } = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { version: string };
  return { module: "charts", version };
}

class IndexedCatalogStore implements CatalogStore {
  private readonly base: TomlStore;
  private readonly registration: CatalogRegistration | undefined;
  private readonly related: CatalogRegistration[];

  constructor(base: TomlStore, registration: CatalogRegistration | undefined, related: CatalogRegistration[]) {
    this.base = base;
    this.registration = registration;
    this.related = related;
  }

  load(): Snapshot {
    const snapshot = this.base.load();
    if (this.registration) {
      snapshot.catalogName = this.registration.name;
      snapshot.catalogs = this.related.map((catalog) => ({
        name: catalog.name,
        snapshot: new TomlStore(catalog.path).load(),
      }));
    }
    return snapshot;
  }

  entryFileExists(id: string): boolean {
    return this.base.entryFileExists(id);
  }

  createEntry(...args: Parameters<CatalogStore["createEntry"]>): ReturnType<CatalogStore["createEntry"]> {
    return this.base.createEntry(...args);
  }

  updateEntry(...args: Parameters<CatalogStore["updateEntry"]>): ReturnType<CatalogStore["updateEntry"]> {
    return this.base.updateEntry(...args);
  }
}

class CatalogPathInspector implements GitInspector {
  private readonly primary: GitCli;
  private readonly byName: Map<string, GitCli>;

  constructor(root: string, registration: CatalogRegistration | undefined, catalogs: CatalogRegistration[]) {
    this.primary = new GitCli(registration?.path ?? root);
    this.byName = new Map(catalogs.map((catalog) => [catalog.name, new GitCli(catalog.path)]));
  }

  inspectLocalPath(rawPath: string, remote?: unknown, catalogName?: string): LocalPathFact {
    const inspector = catalogName === undefined ? this.primary : this.byName.get(catalogName);
    if (!inspector) return { resolved: rawPath, error: `catalog ${JSON.stringify(catalogName)} is not registered` };
    return inspector.inspectLocalPath(rawPath, remote);
  }

  isIgnored(relativePath: string) {
    return this.primary.isIgnored(relativePath);
  }
}

function bridgeLookupError(index: CatalogIndex): ChartsError | null {
  const unreadable = index.unreadableCatalogs();
  if (unreadable.length === 0) return null;
  const details = unreadable.map(({ name, snapshot }) => `${JSON.stringify(name)}: ${snapshot.loadErrors.join("; ")}`).join(", ");
  return new ChartsError("external", `cannot search registered catalogs because they could not be read: ${details}`);
}

function buildPorts(options: Options, root: string, registry: FileCatalogRegistry): Ports {
  const registrations = registry.list();
  let registration: CatalogRegistration | undefined;
  let includeRelated = false;
  let allCatalogs = false;

  if (options.catalogName !== undefined) {
    registration = registry.get(options.catalogName) ?? undefined;
    if (!registration) throw new ChartsError("usage", `unknown catalog: ${options.catalogName}`);
  } else if (registrations.length > 0) {
    if (options.command === "show") {
      registration = registrations[0];
      includeRelated = true;
      allCatalogs = true;
    } else if (options.command === "find") {
      if (!options.text || !ID_PATTERN.test(options.text)) {
        throw new ChartsError("usage", "find requires --catalog, except for an exact entry ID lookup");
      }
      if (options.system || options.tag || options.status || options.owner) {
        throw new ChartsError("usage", "Bridge ID lookup does not accept find filters");
      }
      registration = registrations[0];
      includeRelated = true;
      allCatalogs = true;
    } else if (["add", "set", "check", "deps", "rdeps"].includes(options.command)) {
      throw new ChartsError("usage", `--catalog is required for ${options.command}`);
    }
  }

  const related = includeRelated && registration
    ? registrations.filter((catalog) => catalog.name !== registration!.name)
    : options.catalogName && registration && ["add", "set", "check", "deps", "rdeps", "migrate"].includes(options.command)
      ? registrations.filter((catalog) => catalog.name !== registration!.name)
      : [];
  const base = new TomlStore(registration?.path ?? root);
  const store = new IndexedCatalogStore(base, registration, related);
  const git = new CatalogPathInspector(root, registration, registrations);
  return {
    store,
    git,
    ...(registration ? {
      catalogGit: new CatalogGitCli(root),
      catalogPath: registration.path,
      catalogRemote: registration.remote,
    } : {}),
    catalogName: registration?.name,
    catalogs: [],
    allCatalogs,
  };
}

function readSyncInterval(override?: number): number {
  const raw = override === undefined ? process.env.CHARTS_READ_SYNC_INTERVAL_MS : String(override);
  if (raw === undefined) return 15 * 60 * 1000;
  const interval = Number(raw);
  if (!Number.isSafeInteger(interval) || interval < 0) {
    throw new Error("CHARTS_READ_SYNC_INTERVAL_MS must be a non-negative integer");
  }
  return interval;
}

function createOrCloneCatalog(options: Options, root: string, registry: FileCatalogRegistry): number {
  const name = options.catalogName!;
  if (options.catalogAction === "sync") {
    const catalog = registry.get(name);
    if (!catalog) throw new ChartsError("usage", `unknown catalog: ${name}`);
    const warnings: string[] = [];
    try {
      new CatalogGitCli(root).syncWrite(catalog.path, catalog.remote);
    } catch {
      warnings.push(`catalog ${JSON.stringify(name)} could not sync; local data was kept`);
    }
    try {
      new FileCatalogSyncState(`${registry.path}.sync-state.json`).markAttemptedAt(name, Date.now());
    } catch {
      warnings.push(`catalog ${JSON.stringify(name)} sync time could not be saved`);
    }
    return renderCatalog(options.json, "sync", name, catalog.remote, warnings);
  }
  const remote = options.remote!;
  const path = resolve(options.path!);
  const existing = registry.list().find((catalog) => catalog.name === name || catalog.path === path || catalog.remote === remote);
  if (existing) throw new ChartsError("usage", `catalog name, path, or remote is already registered as ${JSON.stringify(existing.name)}`);
  const catalogGit = new CatalogGitCli(root);
  if (options.catalogAction === "create") catalogGit.initialize(path, remote);
  else catalogGit.clone(path, remote);
  registry.register({ name, path, remote });
  return renderCatalog(options.json, options.catalogAction!, name, remote);
}

/** The command entry point. The optional paths support isolated local tests. */
export function main(argv = process.argv.slice(2), root = ROOT, registryPath?: string, readSyncIntervalMs?: number): number {
  const invocation = readInvocation(argv);
  if (invocation.help) return renderHelp();
  if (invocation.version) {
    try {
      return renderVersion(invocation.json, moduleInfo());
    } catch (error) {
      return renderError(invocation.json, error);
    }
  }
  let options: Options;
  try {
    options = { ...parseArgs(invocation.args), json: invocation.json };
  } catch (error) {
    return renderUsageError(argv, error);
  }
  try {
    const resolvedRoot = resolve(root);
    const localRegistryPath = registryPath ?? (resolvedRoot === ROOT
      ? defaultCatalogRegistryPath()
      : join(resolvedRoot, "local", "catalogs.json"));
    const registry = new FileCatalogRegistry(localRegistryPath);
    if (options.command === "catalog") return createOrCloneCatalog(options, resolvedRoot, registry);

    const ports = buildPorts(options, resolvedRoot, registry);
    if (["find", "show", "deps", "rdeps", "check"].includes(options.command)) {
      const syncWarnings = syncDueCatalogs(
        registry.list(),
        new CatalogGitCli(resolvedRoot),
        new FileCatalogSyncState(`${registry.path}.sync-state.json`),
        readSyncInterval(readSyncIntervalMs),
      );
      for (const warning of syncWarnings) console.error(`WARNING: ${warning}`);
    }
    if (ports.allCatalogs) {
      const error = bridgeLookupError(new CatalogIndex(ports.store.load()));
      if (error) throw error;
    }
    switch (options.command) {
      case "add":
        return renderAdd(options.json, add(ports, {
          kind: options.kind!,
          id: options.id!,
          data: options.data!,
          localPath: options.localPath,
          newTags: options.newTags,
        }));
      case "set":
        return renderSet(options.json, set(ports, {
          id: options.id!,
          data: options.data,
          localPath: options.localPath,
          newTags: options.newTags,
          replaceKey: options.replaceKey,
        }));
      case "check":
        return renderCheck(options.json, check(ports));
      case "migrate":
        return renderMigrate(options.json, migrate({
          source: new TomlStore(resolvedRoot),
          sourceGit: new GitCli(resolvedRoot),
          destination: ports,
        }, options.id!));
      case "find": {
        const result = find(ports, options);
        if (!ports.allCatalogs) return renderFind(options.json, result);
        const index = new CatalogIndex(ports.store.load());
        const matches = index.entries.filter((entry) => entry.id === options.text);
        if (matches.length > 1) throw new ChartsError("refused", `entry ID ${JSON.stringify(options.text)} is not unique across registered catalogs`);
        if (matches.length === 0) return renderFind(options.json, { entries: [] });
        const shown = show(ports, options.text!);
        return renderFind(options.json, { entries: [matches[0]] }, shown.ok ? shown.data : undefined);
      }
      case "show": {
        if (options.catalogName === undefined && ports.catalogName !== undefined) {
          const index = new CatalogIndex(ports.store.load());
          const duplicates = index.entries.filter((entry) => entry.id === options.id);
          if (duplicates.length > 1) throw new ChartsError("refused", `entry ID ${JSON.stringify(options.id)} is not unique across registered catalogs`);
        }
        return renderShow(options.json, show(ports, options.id!));
      }
      case "deps":
        return renderEdges(options.json, deps(ports, options.id!), false);
      case "rdeps":
        return renderEdges(options.json, rdeps(ports, options.id!), true);
      case "describe":
        return renderDescribe(options.json, moduleInfo());
    }
  } catch (error) {
    return renderError(options.json, error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
