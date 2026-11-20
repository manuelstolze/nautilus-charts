#!/usr/bin/env node
// The `charts` command. It is plain JavaScript so that any Node can run it:
// it checks the running Node version against `engines` in package.json
// before it loads the rest of Charts, which needs a newer Node.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "..");

/**
 * The lowest Node version that an `engines.node` range of the form `>=X`,
 * `>=X.Y`, or `>=X.Y.Z` allows, as `X.Y.Z`.
 * @param {string} range
 * @returns {string}
 */
export function minimumNodeVersion(range) {
  const match = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  if (match === null) throw new Error(`engines.node must have the form >=X.Y.Z, not '${range}'`);
  return [match[1], match[2] ?? "0", match[3] ?? "0"].join(".");
}

/**
 * Whether `running` is at least `minimum`; both are `X.Y.Z`, and a
 * prerelease suffix such as `-nightly…` is ignored.
 * @param {string} running
 * @param {string} minimum
 * @returns {boolean}
 */
export function atLeast(running, minimum) {
  /** @param {string} version */
  const parts = (version) => version.split("-")[0].split(".").map((part) => Number(part) || 0);
  const have = parts(running);
  const need = parts(minimum);
  for (let index = 0; index < 3; index += 1) {
    const difference = (have[index] ?? 0) - (need[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

/**
 * The `unsupported-runtime` error for a Node below the minimum of `range`, or null.
 * @param {string} running
 * @param {string} range
 * @returns {{ code: "unsupported-runtime", message: string, details: { required: string, running: string } } | null}
 */
export function runtimeError(running, range) {
  const required = minimumNodeVersion(range);
  if (atLeast(running, required)) return null;
  return {
    code: "unsupported-runtime",
    message: `charts needs Node ${required} or later, but this is Node ${running}`,
    details: { required, running },
  };
}

/** The `engines.node` range from Charts's package.json. */
export function enginesRange() {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  return String(manifest.engines.node);
}

/**
 * Checks the Node version, then runs Charts's main function once.
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function run(argv) {
  /** @param {{ code: string, message: string, details: object }} error */
  const fail = (error) => {
    if (argv.includes("--json")) process.stdout.write(`${JSON.stringify({ error }, null, 2)}\n`);
    else process.stderr.write(`ERROR: ${error.message}\n`);
    return 4;
  };
  try {
    const error = runtimeError(process.versions.node, enginesRange());
    if (error !== null) return fail(error);
    const { main } = await import("../scripts/charts.ts");
    return main(argv);
  } catch (error) {
    // Anything that escapes Charts's own error handling is an external failure.
    return fail({ code: "external", message: error instanceof Error ? error.message : String(error), details: {} });
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  void run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
