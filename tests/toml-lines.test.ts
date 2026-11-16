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

  test("keeps CRLF endings when it appends", () => {
    const original = 'alpha-app = "~/alpha"\r\n';
    const result = upsertSingleLineMapping(original, "new-repo", 'new-repo = "/work/new-repo"');
    assert.deepEqual(result, {
      text: `${original}new-repo = "/work/new-repo"\r\n`,
      replaced: false,
    });
  });

  test("ignores a target-like key inside a multi-line string", () => {
    const original = 'b = """\na = "/old"\n"""\n';
    const result = upsertSingleLineMapping(original, "a", 'a = "/new"');
    assert.deepEqual(result, {
      text: `${original}a = "/new"\n`,
      replaced: false,
    });
  });

  test("does not replace a key inside a table section", () => {
    const original = '[other]\na = "/old"\n';
    assert.deepEqual(upsertSingleLineMapping(original, "a", 'a = "/new"'), { error: "table-section" });
  });

  test("refuses to append after a table section", () => {
    const original = 'b = "/x"\n[meta]\nv = 1';
    assert.deepEqual(upsertSingleLineMapping(original, "a", 'a = "/new"'), { error: "table-section" });
  });

  test("replaces only the value and keeps key quotes and comments", () => {
    const original = '"new-repo" = "/old" # note\r\n';
    const result = upsertSingleLineMapping(original, "new-repo", 'new-repo = "/new"');
    assert.deepEqual(result, {
      text: '"new-repo" = "/new" # note\r\n',
      replaced: true,
    });
  });

  test("keeps a byte-order mark when it replaces a mapping", () => {
    const original = '\uFEFF"new-repo" = "/old" # note\r\n';
    const result = upsertSingleLineMapping(original, "new-repo", 'new-repo = "/new"');
    assert.deepEqual(result, {
      text: '\uFEFF"new-repo" = "/new" # note\r\n',
      replaced: true,
    });
  });

  test("replaces double-quoted and single-quoted keys and values", () => {
    for (const original of ['"new-repo" = "/old"\n', "'new-repo' = '/old'\n"]) {
      const result = upsertSingleLineMapping(original, "new-repo", 'new-repo = "/new"');
      const key = original.startsWith("'") ? "'new-repo'" : '"new-repo"';
      assert.deepEqual(result, { text: `${key} = "/new"\n`, replaced: true });
    }
  });

  test("rejects dotted keys, table keys, multi-line values, and duplicate mappings", () => {
    const cases = [
      '"new-repo".x = "old"\n',
      '[new-repo]\npath = "old"\n',
      'new-repo = """old\nvalue"""\n',
      'new-repo = "/old-one"\n"new-repo" = "/old-two"\n',
    ];
    for (const original of cases) {
      assert.deepEqual(upsertSingleLineMapping(original, "new-repo", 'new-repo = "/new"'), { error: "unsafe-mapping" }, original);
    }
  });
});
