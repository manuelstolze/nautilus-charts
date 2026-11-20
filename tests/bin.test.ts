import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { atLeast, enginesRange, minimumNodeVersion, runtimeError } from "../bin/charts.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Node version check", () => {
  test("compares a lower, an equal, and a higher version", () => {
    assert.equal(atLeast("25.9.9", "26.0.0"), false);
    assert.equal(atLeast("26.0.0", "26.0.0"), true);
    assert.equal(atLeast("26.0.1", "26.0.0"), true);
    assert.equal(atLeast("27.0.0", "26.4.0"), true);
    assert.equal(atLeast("26.3.9", "26.4.0"), false);
    assert.equal(atLeast("100.0.0", "99.0.0"), true);
    assert.equal(atLeast("26.1.0-nightly20261101abc", "26.0.0"), true);
    assert.equal(atLeast("25.9.0-pre", "26.0.0"), false);
  });

  test("reads the minimum from a >= range", () => {
    assert.equal(minimumNodeVersion(">=26"), "26.0.0");
    assert.equal(minimumNodeVersion(">= 26.4"), "26.4.0");
    assert.equal(minimumNodeVersion(">=26.4.1"), "26.4.1");
    assert.throws(() => minimumNodeVersion("^26"), /engines\.node must have the form/);
  });

  test("gives unsupported-runtime with both versions only below the minimum", () => {
    assert.deepEqual(runtimeError("25.1.0", ">=26"), {
      code: "unsupported-runtime",
      message: "charts needs Node 26.0.0 or later, but this is Node 25.1.0",
      details: { required: "26.0.0", running: "25.1.0" },
    });
    assert.equal(runtimeError("26.0.0", ">=26"), null);
    assert.equal(runtimeError("26.5.0", ">=26"), null);
  });

  test("takes the minimum from engines in package.json, which this Node meets", () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { engines: { node: string } };
    assert.equal(enginesRange(), manifest.engines.node);
    assert.equal(minimumNodeVersion(enginesRange()), "26.0.0");
    assert.equal(runtimeError(process.versions.node, enginesRange()), null);
  });

  test("package.json declares the charts command", () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { bin: Record<string, string> };
    assert.deepEqual(manifest.bin, { charts: "bin/charts.js" });
  });
});
