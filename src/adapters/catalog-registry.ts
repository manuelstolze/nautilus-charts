import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { CatalogRegistration, CatalogRegistry as CatalogRegistryPort } from "../commands/ports.ts";
import { remoteHasCredentials } from "../domain/validation.ts";

interface RegistryFile {
  version: 1;
  catalogs: Record<string, { path: string; remote: string }>;
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateName(name: string): void {
  if (!NAME_PATTERN.test(name)) throw new Error(`invalid catalog name ${JSON.stringify(name)}; use lowercase kebab-case`);
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

function validateRegistry(value: unknown): RegistryFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.catalogs)) {
    throw new Error("catalog registry must be a version 1 object with a catalogs table");
  }
  const catalogs: RegistryFile["catalogs"] = Object.create(null) as RegistryFile["catalogs"];
  for (const [name, item] of Object.entries(value.catalogs)) {
    validateName(name);
    if (!isRecord(item) || typeof item.path !== "string" || !isAbsolute(item.path) || typeof item.remote !== "string") {
      throw new Error(`catalog registry entry ${JSON.stringify(name)} must have an absolute path and a remote`);
    }
    validateRemote(item.remote);
    catalogs[name] = { path: item.path, remote: item.remote };
  }
  return { version: 1, catalogs };
}

/** Stores catalog names, local folders, and remote addresses outside the catalog repositories. */
export class FileCatalogRegistry implements CatalogRegistryPort {
  readonly path: string;

  constructor(path = defaultCatalogRegistryPath()) {
    this.path = resolve(path);
  }

  list(): CatalogRegistration[] {
    const registry = this.load();
    return Object.entries(registry.catalogs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, catalog]) => ({ name, ...catalog }));
  }

  get(name: string): CatalogRegistration | null {
    validateName(name);
    const catalog = this.load().catalogs[name];
    return catalog ? { name, ...catalog } : null;
  }

  register(catalog: CatalogRegistration): void {
    validateName(catalog.name);
    validateRemote(catalog.remote);
    if (!isAbsolute(catalog.path)) throw new Error("catalog path must be absolute");
    const path = resolve(catalog.path);
    const registry = this.load();
    if (Object.hasOwn(registry.catalogs, catalog.name)) {
      throw new Error(`catalog ${JSON.stringify(catalog.name)} is already registered`);
    }
    const duplicate = Object.entries(registry.catalogs).find(([, current]) => current.path === path || current.remote === catalog.remote);
    if (duplicate) {
      throw new Error(`catalog path or remote is already registered as ${JSON.stringify(duplicate[0])}`);
    }
    registry.catalogs[catalog.name] = { path, remote: catalog.remote };
    this.save(registry);
  }

  private load(): RegistryFile {
    if (!existsSync(this.path)) return { version: 1, catalogs: Object.create(null) as RegistryFile["catalogs"] };
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`cannot read catalog registry: ${reason}`);
    }
    return validateRegistry(value);
  }

  private save(registry: RegistryFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporaryPath, this.path);
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }
}

export function defaultCatalogRegistryPath(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const configHome = environment.XDG_CONFIG_HOME && isAbsolute(environment.XDG_CONFIG_HOME)
    ? environment.XDG_CONFIG_HOME
    : join(home, ".config");
  return join(configHome, "nautilus-charts", "catalogs.json");
}
