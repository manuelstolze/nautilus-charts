import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

// Rule VI of the constitution: the core, in src/domain/ and src/commands/,
// imports only other core files and does not use console or process.
// src/domain/ is stricter still: it imports only src/domain/.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Each core folder and the folders its files may import from. */
const ALLOWED: Record<string, string[]> = {
  "src/domain": ["src/domain"],
  "src/commands": ["src/domain", "src/commands"],
};

const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']*)["']/g, // import ... from, import type ... from, export ... from
  /\bimport\s*["']([^"']*)["']/g, // side-effect import
  /\bimport\s*\(\s*["']([^"']*)["']\s*\)/g, // dynamic import
  /\brequire\s*\(\s*["']([^"']*)["']\s*\)/g,
];

function inside(path: string, folder: string): boolean {
  const offset = relative(folder, path);
  return offset !== "" && !offset.startsWith("..") && !offset.startsWith(sep) && !offset.includes(`..${sep}`);
}

/** Returns the rule VI violations in one core file. `path` is absolute. */
export function coreViolations(root: string, path: string, source: string): string[] {
  const label = relative(root, path);
  const coreFolder = Object.keys(ALLOWED).find((folder) => inside(path, join(root, folder)));
  if (!coreFolder) return [`${label}: not a core file`];
  const allowed = ALLOWED[coreFolder].map((folder) => join(root, folder));
  const violations: string[] = [];

  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        violations.push(`${label}: imports ${JSON.stringify(specifier)}, which is outside the core`);
        continue;
      }
      const target = resolve(dirname(path), specifier);
      if (!allowed.some((folder) => inside(target, folder))) {
        violations.push(`${label}: imports ${JSON.stringify(specifier)}, which ${coreFolder}/ may not use`);
      }
    }
  }
  if (/\bimport\s*\(\s*[^"'\s)]/.test(source)) violations.push(`${label}: uses a dynamic import that is not a string literal`);
  if (/\brequire\s*\(\s*[^"'\s)]/.test(source)) violations.push(`${label}: uses require with a non-literal argument`);
  for (const word of ["console", "process"]) {
    if (new RegExp(`\\b${word}\\b`).test(source)) violations.push(`${label}: uses ${word}`);
  }
  return violations;
}

function typeScriptFiles(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).flatMap((item) => {
    const path = join(folder, item.name);
    if (item.isDirectory()) return typeScriptFiles(path);
    return item.name.endsWith(".ts") ? [path] : [];
  });
}

describe("architecture", () => {
  test("core files import only core files and do no I/O", () => {
    const files = Object.keys(ALLOWED).flatMap((folder) => typeScriptFiles(join(REPO_ROOT, folder)));
    assert.ok(files.length > 0, "no core files found");
    const violations = files.flatMap((path) => coreViolations(REPO_ROOT, path, readFileSync(path, "utf8")));
    assert.deepEqual(violations, []);
  });

  test("detects each kind of violation", () => {
    const domain = join(REPO_ROOT, "src/domain/sample.ts");
    const commands = join(REPO_ROOT, "src/commands/sample.ts");
    const samples: Array<{ path: string; source: string; expected: string }> = [
      { path: domain, source: 'import { readFileSync } from "node:fs";\n', expected: '"node:fs"' },
      { path: domain, source: 'import "node:fs";\n', expected: '"node:fs"' },
      { path: domain, source: 'import { parse } from "smol-toml";\n', expected: '"smol-toml"' },
      { path: commands, source: 'import { TomlStore } from "../adapters/toml-store.ts";\n', expected: '"../adapters/toml-store.ts"' },
      { path: commands, source: 'import type { Stats } from "node:fs";\n', expected: '"node:fs"' },
      { path: commands, source: 'import type {\n  Options,\n} from "../adapters/cli.ts";\n', expected: '"../adapters/cli.ts"' },
      { path: domain, source: 'import type { Ports } from "../commands/context.ts";\n', expected: '"../commands/context.ts"' },
      { path: domain, source: 'export { main } from "../../scripts/charts.ts";\n', expected: '"../../scripts/charts.ts"' },
      { path: domain, source: 'const fs = await import("node:fs");\n', expected: '"node:fs"' },
      { path: domain, source: "const name = \"node:fs\";\nconst fs = await import(name);\n", expected: "dynamic import" },
      { path: domain, source: 'const fs = require("node:fs");\n', expected: '"node:fs"' },
      { path: domain, source: 'console.log("hello");\n', expected: "uses console" },
      { path: commands, source: "const home = process.env.HOME;\n", expected: "uses process" },
    ];
    for (const sample of samples) {
      const violations = coreViolations(REPO_ROOT, sample.path, sample.source);
      assert.ok(
        violations.some((violation) => violation.includes(sample.expected)),
        `expected a violation with ${sample.expected} for:\n${sample.source}\ngot ${JSON.stringify(violations)}`,
      );
    }
  });

  test("allows imports inside the core", () => {
    const commands = join(REPO_ROOT, "src/commands/sample.ts");
    const source = 'import { CatalogIndex } from "../domain/catalog.ts";\nimport type { Ports } from "./context.ts";\n';
    assert.deepEqual(coreViolations(REPO_ROOT, commands, source), []);
  });
});
