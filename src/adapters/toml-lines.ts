type Line = { text: string; ending: string };

export type UpsertMappingResult =
  | { text: string; replaced: boolean }
  | { error: "unsafe-mapping" };

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n" && text[index] !== "\r") continue;
    const ending = text[index] === "\r" && text[index + 1] === "\n" ? "\r\n" : text[index];
    lines.push({ text: text.slice(start, index), ending });
    index += ending.length - 1;
    start = index + 1;
  }
  if (start < text.length) lines.push({ text: text.slice(start), ending: "" });
  return lines;
}

/** Appends TOML text on a new line, adding a final newline. */
export function appendTomlText(text: string, addition: string): string {
  const separator = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
  const ending = addition.endsWith("\n") ? "" : "\n";
  return `${text}${separator}${addition}${ending}`;
}

/** Appends TOML text or replaces one single-line string mapping. */
export function upsertSingleLineMapping(text: string, key: string, valueLine: string): UpsertMappingResult {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = `(?:${escapedKey}|"${escapedKey}"|'${escapedKey}')`;
  const assignment = new RegExp(`^\\s*${token}\\s*=`);
  const singleLineMapping = new RegExp(`^\\s*${token}\\s*=\\s*(?:"(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*(?:#.*)?$`);
  const dotted = new RegExp(`^\\s*(?:${token}\\s*\\.|\\[\\[?\\s*${token}\\s*\\.)`);
  const table = new RegExp(`^\\s*(?:\\[\\s*${token}\\s*\\]|\\[\\[\\s*${token}\\s*\\]\\])\\s*(?:#.*)?$`);
  const lines = splitLines(text);
  const matches: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].text;
    if (dotted.test(line) || table.test(line)) {
      return { error: "unsafe-mapping" };
    }
    if (assignment.test(line)) matches.push(index);
  }

  if (matches.length === 0) return { text: appendTomlText(text, valueLine), replaced: false };
  if (matches.length !== 1 || !singleLineMapping.test(lines[matches[0]].text)) {
    return { error: "unsafe-mapping" };
  }

  const match = matches[0];
  lines[match] = { ...lines[match], text: valueLine };
  return { text: lines.map(({ text: line, ending }) => `${line}${ending}`).join(""), replaced: true };
}
