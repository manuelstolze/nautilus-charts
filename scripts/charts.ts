#!/usr/bin/env node
// The composition root: it wires the adapters to the use cases.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseArgs,
  readInvocation,
  renderAdd,
  renderCheck,
  renderDescribe,
  renderEdges,
  renderError,
  renderFind,
  renderHelp,
  renderShow,
  renderSet,
  renderUsageError,
  type ModuleInfo,
  type Options,
} from "../src/adapters/cli.ts";
import { GitCli } from "../src/adapters/git-cli.ts";
import { TomlStore } from "../src/adapters/toml-store.ts";
import { add } from "../src/commands/add.ts";
import { check } from "../src/commands/check.ts";
import type { Ports } from "../src/commands/context.ts";
import { deps, rdeps } from "../src/commands/deps.ts";
import { find } from "../src/commands/find.ts";
import { show } from "../src/commands/show.ts";
import { set } from "../src/commands/set.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The module's name and version from `package.json`, the one place that holds the version. */
export function moduleInfo(): ModuleInfo {
  const { version } = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { version: string };
  return { module: "charts", version };
}

export function main(argv = process.argv.slice(2), root = ROOT): number {
  if (readInvocation(argv).help) return renderHelp();
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    return renderUsageError(argv, error);
  }
  try {
    const ports: Ports = { store: new TomlStore(root), git: new GitCli(root) };
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
      case "find":
        return renderFind(options.json, find(ports, options));
      case "show":
        return renderShow(options.json, show(ports, options.id!));
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
