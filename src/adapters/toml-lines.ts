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
