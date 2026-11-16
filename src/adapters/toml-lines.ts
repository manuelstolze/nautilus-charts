type Line = { text: string; ending: string };

export type UpsertLineResult =
  | { text: string; replaced: boolean }
  | { error: string };

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

/** Appends a TOML key or replaces one simple, single-line string mapping. */
export function upsertSimpleLine(text: string, key: string, valueLine: string): UpsertLineResult {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = `(?:${escapedKey}|"${escapedKey}"|'${escapedKey}')`;
  const assignment = new RegExp(`^\\s*${token}\\s*=`);
  const simpleLine = new RegExp(`^\\s*${token}\\s*=\\s*(?:"(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*(?:#.*)?$`);
  const dotted = new RegExp(`^\\s*(?:${token}\\s*\\.|\\[\\[?\\s*${token}\\s*\\.)`);
  const table = new RegExp(`^\\s*(?:\\[\\s*${token}\\s*\\]|\\[\\[\\s*${token}\\s*\\]\\])\\s*(?:#.*)?$`);
  const lines = splitLines(text);
  const matches: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].text;
    if (dotted.test(line) || table.test(line)) {
      return { error: `cannot safely replace the existing mapping for "${key}"` };
    }
    if (assignment.test(line)) matches.push(index);
  }

  if (matches.length === 0) {
    const separator = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
    return { text: `${text}${separator}${valueLine}\n`, replaced: false };
  }
  if (matches.length !== 1 || !simpleLine.test(lines[matches[0]].text)) {
    return { error: `cannot safely replace the existing mapping for "${key}"` };
  }

  const match = matches[0];
  lines[match] = { ...lines[match], text: valueLine };
  return { text: lines.map(({ text: line, ending }) => `${line}${ending}`).join(""), replaced: true };
}
