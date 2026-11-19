type Line = { text: string; ending: string; start: number };
type Quote = { mark: "\"" | "'"; multiline: boolean };
type ValueState = { quote: Quote | null; arrays: number; tables: number };

export type UpsertMappingResult =
  | { text: string; replaced: boolean }
  | { error: "unsafe-mapping" | "table-section" };

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n" && text[index] !== "\r") continue;
    const ending = text[index] === "\r" && text[index + 1] === "\n" ? "\r\n" : text[index];
    lines.push({ text: text.slice(start, index), ending, start });
    index += ending.length - 1;
    start = index + 1;
  }
  if (start < text.length) lines.push({ text: text.slice(start), ending: "", start });
  return lines;
}

function newlineFor(text: string): string {
  return text.match(/\r\n|\n|\r/)?.[0] ?? "\n";
}

export type SetTomlFieldsResult =
  | { text: string }
  | { error: "duplicate-field" | "dotted-key" | "table-section" | "unsafe-value" };

type Assignment = { key: string; dotted: boolean; start: number; end: number; prefix: string };

/** Renders a TOML key, quoting it when a bare key is not valid. */
export function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

/** Renders the JSON values accepted by the catalog as TOML values. */
export function tomlValue(value: unknown): string {
  if (value === null || value === undefined) throw new Error("JSON null values cannot be written to TOML");
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("number is outside the TOML range");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (typeof value === "object") {
    const pairs = Object.entries(value).map(([key, item]) => `${tomlKey(key)} = ${tomlValue(item)}`);
    return `{ ${pairs.join(", ")} }`;
  }
  throw new Error(`unsupported TOML value: ${String(value)}`);
}

function readKeyPrefix(left: string): { key: string; rest: string; length: number } | null {
  const source = left.trimStart();
  const leading = left.length - source.length;
  if (source.startsWith('"')) {
    let end = 1;
    for (; end < source.length; end += 1) {
      if (source[end] === "\\") end += 1;
      else if (source[end] === '"') break;
    }
    if (end >= source.length) return null;
    const token = source.slice(0, end + 1);
    try {
      const key: unknown = JSON.parse(token);
      if (typeof key !== "string") return null;
      return { key, rest: source.slice(end + 1), length: leading + end + 1 };
    } catch {
      return null;
    }
  }
  if (source.startsWith("'")) {
    const end = source.indexOf("'", 1);
    if (end < 0) return null;
    return { key: source.slice(1, end), rest: source.slice(end + 1), length: leading + end + 1 };
  }
  const bare = /^[A-Za-z0-9_-]+/.exec(source);
  if (!bare) return null;
  return { key: bare[0], rest: source.slice(bare[0].length), length: leading + bare[0].length };
}

function assignmentFor(line: string): (Assignment & { valueStart: number }) | null {
  const equals = findAssignmentEquals(line);
  if (equals < 0) return null;
  const parsed = readKeyPrefix(line.slice(0, equals));
  if (!parsed) return null;
  const rest = parsed.rest.trimStart();
  if (rest !== "" && !rest.startsWith(".")) return null;
  let valueStart = equals + 1;
  while (line[valueStart] === " " || line[valueStart] === "\t") valueStart += 1;
  return {
    key: parsed.key,
    dotted: rest.startsWith("."),
    start: 0,
    end: 0,
    prefix: line.slice(0, valueStart),
    valueStart,
  };
}

function trailingCommentSuffix(line: string): string {
  const state: ValueState = { quote: null, arrays: 0, tables: 0 };
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (state.quote !== null) {
      if (state.quote.multiline) {
        if (state.quote.mark === '"' && character === "\\") index += 1;
        else if (line.startsWith(state.quote.mark.repeat(3), index)) {
          state.quote = null;
          index += 2;
        }
      } else if (state.quote.mark === '"' && character === "\\") index += 1;
      else if (character === state.quote.mark) state.quote = null;
      continue;
    }
    if (character === "#") {
      let start = index;
      while (start > 0 && (line[start - 1] === " " || line[start - 1] === "\t")) start -= 1;
      return line.slice(start);
    }
    if (character === '"' || character === "'") {
      const multiline = line.startsWith(character.repeat(3), index);
      state.quote = { mark: character, multiline };
      if (multiline) index += 2;
    } else if (character === "[") state.arrays += 1;
    else if (character === "]") state.arrays = Math.max(0, state.arrays - 1);
    else if (character === "{") state.tables += 1;
    else if (character === "}") state.tables = Math.max(0, state.tables - 1);
  }
  return "";
}

/** Replaces or inserts root fields without rewriting the other TOML lines. */
export function setTomlFields(text: string, fields: Record<string, unknown>, order: readonly string[]): SetTomlFieldsResult {
  const originalLines = splitLines(text);
  const hasBom = text.startsWith("\uFEFF");
  const lines = originalLines.map(({ ...line }) => line);
  if (hasBom && lines[0]) lines[0].text = lines[0].text.slice(1);
  const targets = new Set(Object.keys(fields));
  const assignments: Assignment[] = [];
  const state: ValueState = { quote: null, arrays: 0, tables: 0 };
  const sectionHeader = /^\s*\[{1,2}/;

  for (let index = 0; index < lines.length; ) {
    const view = lines[index].text;
    if (state.quote !== null || state.arrays > 0 || state.tables > 0) {
      scanValue(view, 0, state);
      index += 1;
      continue;
    }
    if (sectionHeader.test(view)) return { error: "table-section" };
    const parsed = assignmentFor(view);
    if (!parsed) {
      index += 1;
      continue;
    }

    const assignment: Assignment = { ...parsed, start: index, end: index };
    scanValue(view, parsed.valueStart, state);
    while (state.quote !== null || state.arrays > 0 || state.tables > 0) {
      if (assignment.end + 1 >= lines.length) return { error: "unsafe-value" };
      assignment.end += 1;
      scanValue(lines[assignment.end].text, 0, state);
    }
    assignments.push(assignment);
    index = assignment.end + 1;
  }

  const matches = new Map<string, Assignment[]>();
  for (const assignment of assignments) {
    if (!targets.has(assignment.key)) continue;
    if (assignment.dotted) return { error: "dotted-key" };
    const list = matches.get(assignment.key) ?? [];
    list.push(assignment);
    matches.set(assignment.key, list);
  }
  for (const [field, list] of matches) {
    if (list.length > 1) return { error: "duplicate-field" };
    if (!targets.has(field)) continue;
  }

  const replacements = new Map<number, { end: number; line: Line }>();
  const insertions = new Map<number, string[]>();
  const orderIndex = (key: string) => order.indexOf(key);
  for (const [field, value] of Object.entries(fields)) {
    const existing = matches.get(field)?.[0];
    let rendered: string;
    try {
      rendered = tomlValue(value);
    } catch {
      return { error: "unsafe-value" };
    }
    if (existing) {
      const endingLine = lines[existing.end];
      const suffix = trailingCommentSuffix(endingLine.text);
      replacements.set(existing.start, {
        end: existing.end,
        line: {
          text: `${existing.prefix}${rendered}${suffix}`,
          ending: endingLine.ending,
          start: lines[existing.start].start,
        },
      });
      continue;
    }

    const fieldOrder = orderIndex(field);
    const ordered = assignments
      .filter(({ dotted, key }) => !dotted && orderIndex(key) >= 0)
      .map((assignment) => ({ assignment, position: orderIndex(assignment.key) }));
    const before = ordered.filter(({ position }) => position < fieldOrder).sort((a, b) => b.position - a.position)[0];
    const after = ordered.filter(({ position }) => position > fieldOrder).sort((a, b) => a.position - b.position)[0];
    const boundary = before ? before.assignment.end + 1 : after ? after.assignment.start : lines.length;
    const list = insertions.get(boundary) ?? [];
    list.push(`${tomlKey(field)} = ${rendered}`);
    insertions.set(boundary, list);
  }

  for (const list of insertions.values()) {
    list.sort((a, b) => orderIndex(a.slice(0, a.indexOf(" ="))) - orderIndex(b.slice(0, b.indexOf(" ="))));
  }
  const newline = newlineFor(text);
  const finalNewline = text.endsWith("\n") || text.endsWith("\r");
  const output: Line[] = [];
  let index = 0;
  while (index <= lines.length) {
    const additions = insertions.get(index);
    if (additions?.length) {
      if (output.length > 0 && output.at(-1)!.ending === "") output[output.length - 1].ending = newline;
      additions.forEach((value, additionIndex) => {
        const lastAtEnd = index === lines.length && additionIndex === additions.length - 1;
        output.push({
          text: value,
          ending: lastAtEnd && !finalNewline ? "" : newline,
          start: -1,
        });
      });
    }
    if (index === lines.length) break;
    const replacement = replacements.get(index);
    if (replacement) {
      output.push(replacement.line);
      index = replacement.end + 1;
    } else {
      output.push(lines[index]);
      index += 1;
    }
  }
  const updated = output.map(({ text: content, ending }) => `${content}${ending}`).join("");
  return { text: `${hasBom ? "\uFEFF" : ""}${updated}` };
}

/** Appends TOML lines and keeps the file's line ending. */
export function appendTomlLines(text: string, additions: readonly string[]): string {
  if (additions.length === 0) return text;
  const newline = newlineFor(text);
  const endsWithNewline = text.endsWith("\n") || text.endsWith("\r");
  const separator = text.length > 0 && !endsWithNewline && text !== "\uFEFF" ? newline : "";
  return `${text}${separator}${additions.join(newline)}${newline}`;
}

function findAssignmentEquals(line: string): number {
  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote !== null) {
      if (quote === "\"" && character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "#") return -1;
    if (character === "\"" || character === "'") quote = character;
    else if (character === "=") return index;
  }
  return -1;
}

function scanValue(line: string, start: number, state: ValueState): void {
  for (let index = start; index < line.length; index += 1) {
    const character = line[index];
    if (state.quote !== null) {
      if (state.quote.multiline) {
        if (state.quote.mark === "\"" && character === "\\") {
          index += 1;
        } else if (line.startsWith(state.quote.mark.repeat(3), index)) {
          state.quote = null;
          index += 2;
        }
      } else if (state.quote.mark === "\"" && character === "\\") {
        index += 1;
      } else if (character === state.quote.mark) {
        state.quote = null;
      }
      continue;
    }

    if (character === "#") return;
    if (character === "\"" || character === "'") {
      const multiline = line.startsWith(character.repeat(3), index);
      state.quote = { mark: character, multiline };
      if (multiline) index += 2;
    } else if (character === "[") {
      state.arrays += 1;
    } else if (character === "]") {
      state.arrays = Math.max(0, state.arrays - 1);
    } else if (character === "{") {
      state.tables += 1;
    } else if (character === "}") {
      state.tables = Math.max(0, state.tables - 1);
    }
  }
}

/** Adds a root mapping or replaces one single-line string mapping. */
export function upsertSingleLineMapping(text: string, key: string, valueLine: string): UpsertMappingResult {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = `(?:${escapedKey}|"${escapedKey}"|'${escapedKey}')`;
  const targetAssignment = new RegExp(`^(\\s*${token}\\s*=\\s*)`);
  const targetDotted = new RegExp(`^\\s*${token}\\s*\\.`);
  const targetSection = new RegExp(`^\\s*\\[\\[?\\s*${token}(?=\\s*(?:\\.|\\]))`);
  const sectionHeader = /^\s*\[{1,2}/;
  const singleLineMapping = new RegExp(
    `^(\\s*${token}\\s*=\\s*)("(?:[^"\\\\]|\\\\.)*"|'[^']*')(\\s*(?:#.*)?)$`,
  );
  const lines = splitLines(text);
  const matches: Array<{ index: number; groups: RegExpExecArray }> = [];
  const state: ValueState = { quote: null, arrays: 0, tables: 0 };
  let inSection = false;
  let hasSection = false;
  const bom = "\uFEFF";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const view = index === 0 && line.text.startsWith(bom) ? line.text.slice(1) : line.text;
    const continuingValue = state.quote !== null || state.arrays > 0 || state.tables > 0;

    if (!continuingValue) {
      if (sectionHeader.test(view)) {
        hasSection = true;
        inSection = true;
        if (targetSection.test(view)) return { error: "unsafe-mapping" };
        continue;
      }
      if (!inSection) {
        if (targetDotted.test(view)) return { error: "unsafe-mapping" };
        const assignment = targetAssignment.exec(view);
        if (assignment) {
          const mapping = singleLineMapping.exec(view);
          if (!mapping) return { error: "unsafe-mapping" };
          matches.push({ index, groups: mapping });
        }
      }
      const equals = findAssignmentEquals(view);
      if (equals >= 0) scanValue(view, equals + 1, state);
    } else {
      scanValue(view, 0, state);
    }
  }

  if (hasSection) return { error: "table-section" };
  if (matches.length > 1) return { error: "unsafe-mapping" };
  if (matches.length === 0) return { text: appendTomlLines(text, [valueLine]), replaced: false };

  const { index, groups } = matches[0];
  const valueStart = valueLine.indexOf("=");
  if (valueStart < 0) return { error: "unsafe-mapping" };
  const value = valueLine.slice(valueStart + 1).trim();
  const line = lines[index];
  const prefixBom = index === 0 && line.text.startsWith(bom) ? bom : "";
  lines[index] = {
    ...line,
    text: `${prefixBom}${groups[1]}${value}${groups[3]}`,
  };
  return { text: lines.map(({ text: content, ending }) => `${content}${ending}`).join(""), replaced: true };
}
