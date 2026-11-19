import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setTomlFields, upsertSingleLineMapping } from "../src/adapters/toml-lines.ts";

describe("TOML field updates", () => {
  test("replaces a single-line field and keeps its trailing comment", () => {
    const original = 'description   = "Old."  # keep this\n# after\n';
    const result = setTomlFields(original, { description: "New." }, ["description"]);
    assert.deepEqual(result, {
      text: 'description   = "New."  # keep this\n# after\n',
    });
  });

  test("replaces a multi-line value and keeps comments outside it", () => {
    const original = [
      "# before",
      "depends-on = [",
      '  { id = "old#id", via = "[] # text" }, # inside value',
      "]",
      "# after",
      'description = "Keep."',
      "",
    ].join("\n");
    const result = setTomlFields(original, { "depends-on": [{ id: "new" }] }, ["description", "depends-on"]);
    assert.deepEqual(result, {
      text: '# before\ndepends-on = [{ id = "new" }]\n# after\ndescription = "Keep."\n',
    });
  });

  test("inserts missing fields in template order", () => {
    const cases = [
      { text: 'description = "Text"\nremote = "https://example.com/a.git"\n', field: "key", order: ["key", "description", "remote"], expected: 'key = "ABC"\ndescription = "Text"\nremote = "https://example.com/a.git"\n' },
      { text: 'description = "Text"\nremote = "https://example.com/a.git"\n', field: "system", order: ["description", "system", "remote"], expected: 'description = "Text"\nsystem = "shop"\nremote = "https://example.com/a.git"\n' },
      { text: 'description = "Text"', field: "status", order: ["description", "status"], expected: 'description = "Text"\nstatus = "active"' },
    ];
    for (const item of cases) {
      const result = setTomlFields(item.text, { [item.field]: item.field === "key" ? "ABC" : item.field === "system" ? "shop" : "active" }, item.order);
      assert.deepEqual(result, { text: item.expected });
    }
  });

  test("keeps a BOM, CRLF endings, and a missing final newline", () => {
    const original = '\uFEFFdescription = "Old."\r\nstatus = "active"';
    const result = setTomlFields(original, { description: "New." }, ["description", "status"]);
    assert.deepEqual(result, { text: '\uFEFFdescription = "New."\r\nstatus = "active"' });
  });

  test("refuses duplicate fields, dotted fields, and table sections", () => {
    const cases = [
      { text: 'description = "One"\ndescription = "Two"\n', error: "duplicate-field" },
      { text: 'description.extra = "One"\n', error: "dotted-key" },
      { text: '[meta]\ndescription = "One"\n', error: "table-section" },
    ] as const;
    for (const item of cases) {
      assert.deepEqual(setTomlFields(item.text, { description: "New" }, ["description"]), { error: item.error });
    }
  });
});

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
