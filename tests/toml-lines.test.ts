import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { upsertSingleLineMapping } from "../src/adapters/toml-lines.ts";

describe("TOML mapping updates", () => {
  test("appends after existing text with a final newline", () => {
    const original = '# local paths\nalpha-app = "~/alpha"\n';
    const result = upsertSingleLineMapping(original, "new-repo", 'new-repo = "/work/new-repo"');
    assert.deepEqual(result, {
      text: `${original}new-repo = "/work/new-repo"\n`,
      replaced: false,
    });
  });

  test("adds a newline before appending when the text has none", () => {
    const original = 'alpha-app = "~/alpha"';
    const result = upsertSingleLineMapping(original, "new-repo", 'new-repo = "/work/new-repo"');
    assert.deepEqual(result, {
      text: `${original}\nnew-repo = "/work/new-repo"\n`,
      replaced: false,
    });
  });

  test("replaces a one-line mapping and keeps every other byte", () => {
    const original = '# paths\n\n"alpha-app" = "~/alpha"\nnew-repo = "/old"  # stale\n';
    const result = upsertSingleLineMapping(original, "new-repo", 'new-repo = "/work/new-repo"');
    assert.deepEqual(result, {
      text: '# paths\n\n"alpha-app" = "~/alpha"\nnew-repo = "/work/new-repo"\n',
      replaced: true,
    });
  });

  test("replaces double-quoted and single-quoted keys and values", () => {
    for (const original of ['"new-repo" = "/old"\n', "'new-repo' = '/old'\n"]) {
      const result = upsertSingleLineMapping(original, "new-repo", 'new-repo = "/new"');
      assert.deepEqual(result, { text: 'new-repo = "/new"\n', replaced: true });
    }
  });

  test("rejects dotted and table keys, multi-line values, and duplicate mappings", () => {
    const cases = [
      '"new-repo".x = "old"\n',
      '[new-repo]\npath = "old"\n',
      'new-repo = """old\nvalue"""\n',
      'new-repo = "/old-one"\n"new-repo" = "/old-two"\n',
    ];
    for (const original of cases) {
      const result = upsertSingleLineMapping(original, "new-repo", 'new-repo = "/new"');
      assert.deepEqual(result, { error: "unsafe-mapping" }, original);
    }
  });
});
