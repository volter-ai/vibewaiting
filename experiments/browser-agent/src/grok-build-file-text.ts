import { normalize } from "./grok-build-file-tree.js";

export function resolveReadStartLine(content: string, offset: number | undefined): number {
  const raw = offset ?? 1;
  if (raw === 0) return 1;
  if (raw > 0) return raw;
  let totalFields = content.split("\n").length;
  if (content !== "" && !content.endsWith("\n")) totalFields += 1;
  return Math.max(1, totalFields + raw + 1);
}

export function grokReadWindow(content: string, startLine: number, limit: number): { output: string; images: string[] } {
  const images: string[] = [];
  const output = lineFields(content).slice(startLine - 1, startLine - 1 + limit).map((line, index) => {
    // Native read_file scans each visible line independently. Consequently the
    // five-image safety cap also resets per line; preserve that observable edge.
    const extracted = extractInlineAttachments(line);
    images.push(...extracted.images.map(({ mime, payload }) => `data:${mime};base64,${payload}`));
    const lineNumber = startLine + index;
    return index === 0 || lineNumber % 10 === 0 ? `${lineNumber}→${extracted.text}` : extracted.text;
  }).join("\n");
  return { output, images };
}

const INLINE_IMAGE_MIN_PAYLOAD = 1_024;
const INLINE_IMAGE_MAX_PAYLOAD = 10 * 1_024 * 1_024;
const INLINE_GROSS_PAYLOAD_CAP = INLINE_IMAGE_MAX_PAYLOAD * 2;
const INLINE_MAX_IMAGES = 5;

interface InlinePrefix {
  start: number;
  end: number;
  kind: "image" | "pdf";
  mime: string;
}

/** Browser translation of util/base64_images.rs, including its replacement text. */
function extractInlineAttachments(text: string): { text: string; images: Array<{ mime: string; payload: string }> } {
  const pdfStripped = stripInlinePdfUris(text);
  const input = pdfStripped.modified ? pdfStripped.text : text;
  if (!input.includes("data:image")) return { text: input, images: [] };
  const prefixes = inlinePrefixes(input);
  const imagePrefixes = prefixes.filter((prefix) => prefix.kind === "image");
  if (imagePrefixes.length === 0) return { text: input, images: [] };
  const images: Array<{ mime: string; payload: string }> = [];
  let result = "";
  let lastEnd = 0;
  for (const prefix of imagePrefixes) {
    const nextStart = prefixes.find((candidate) => candidate.start > prefix.start)?.start ?? input.length;
    const payloadEnd = inlinePayloadEnd(input, prefix.end, nextStart);
    const span = input.slice(prefix.end, payloadEnd);
    if (span.length > INLINE_GROSS_PAYLOAD_CAP) {
      result += `${input.slice(lastEnd, prefix.start)}[large image removed]`;
      lastEnd = payloadEnd;
      continue;
    }
    const cleaned = span.replace(/[\t\n\r\f ]/gu, "");
    const payloadLength = cleaned.length - (cleaned.length % 4);
    if (payloadLength < INLINE_IMAGE_MIN_PAYLOAD) continue;
    result += input.slice(lastEnd, prefix.start);
    if (payloadLength > INLINE_IMAGE_MAX_PAYLOAD) result += "[large image removed]";
    else if (images.length >= INLINE_MAX_IMAGES) result += "[additional image omitted]";
    else {
      images.push({ mime: prefix.mime, payload: cleaned.slice(0, payloadLength) });
      result += "[image content will be provided separately]";
    }
    lastEnd = payloadEnd;
  }
  if (lastEnd === 0) return { text: input, images: [] };
  return { text: result + input.slice(lastEnd), images };
}

function stripInlinePdfUris(text: string): { text: string; modified: boolean } {
  if (!text.toLowerCase().includes("data:application/pdf")) return { text, modified: false };
  const prefixes = inlinePrefixes(text);
  const pdfPrefixes = prefixes.filter((prefix) => prefix.kind === "pdf");
  if (pdfPrefixes.length === 0) return { text, modified: false };
  let result = "";
  let lastEnd = 0;
  for (const prefix of pdfPrefixes) {
    const nextStart = prefixes.find((candidate) => candidate.start > prefix.start)?.start ?? text.length;
    const payloadEnd = inlinePayloadEnd(text, prefix.end, nextStart);
    const span = text.slice(prefix.end, payloadEnd);
    const payloadLength = span.length > INLINE_GROSS_PAYLOAD_CAP ? span.length : span.replace(/[\t\n\r\f ]/gu, "").length;
    result += `${text.slice(lastEnd, prefix.start)}[PDF attachment removed — ${Math.floor(payloadLength * 3 / 4 / 1_024)} KB]`;
    lastEnd = payloadEnd;
  }
  return { text: result + text.slice(lastEnd), modified: true };
}

function inlinePrefixes(text: string): InlinePrefix[] {
  const prefixes: InlinePrefix[] = [];
  const patterns: Array<{ kind: InlinePrefix["kind"]; regex: RegExp }> = [
    { kind: "image", regex: /(^|[^a-zA-Z0-9])(data:(image\/(?:png|jpeg|gif|webp|bmp|tiff))(?:;[^\s,;]{1,120})*;base64,)/giu },
    { kind: "pdf", regex: /(^|[^a-zA-Z0-9])(data:(application\/pdf)(?:;[^\s,;]{1,120})*;base64,)/giu },
  ];
  for (const { kind, regex } of patterns) {
    for (const match of text.matchAll(regex)) {
      const leading = match[1] ?? "";
      const prefix = match[2] ?? "";
      const start = (match.index ?? 0) + leading.length;
      prefixes.push({ start, end: start + prefix.length, kind, mime: match[3] ?? "" });
    }
  }
  return prefixes.sort((left, right) => left.start - right.start);
}

function inlinePayloadEnd(text: string, start: number, endCap: number): number {
  let index = start;
  const isBase64 = (value: string | undefined): boolean => value !== undefined && /[a-zA-Z0-9+/=]/u.test(value);
  while (index < endCap && isBase64(text[index])) index += 1;
  if (index > start && text[index - 1] === "=") return index;
  for (;;) {
    let next = index;
    if (next < endCap && text[next] === "\r") next += 1;
    if (next >= endCap || text[next] !== "\n") break;
    next += 1;
    while (next < endCap && (text[next] === " " || text[next] === "\t")) next += 1;
    const chunkStart = next;
    while (next < endCap && isBase64(text[next])) next += 1;
    if (next === chunkStart) break;
    index = next;
    if (text[next - 1] === "=") break;
  }
  return index;
}

export function lenientSignedInteger(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`expected number, got ${JSON.stringify(value)}`);
  }
  if (typeof value === "string" && value.length === 0) throw new Error('expected number, got string ""');
  const number = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(number)) throw new Error(`expected number, got string "${value}"`);
  if (!Number.isFinite(number)) throw new Error("expected finite number");
  if (!Number.isInteger(number)) throw new Error(`expected whole number, got ${number}`);
  const exactLimit = 9_007_199_254_740_992;
  if (Math.abs(number) > exactLimit) {
    throw new Error(`number ${number} exceeds f64 integer precision (whole floats above ${exactLimit} may be inaccurate)`);
  }
  return number;
}

export function grokRawReadLineCount(content: string, startLine: number, limit: number): number {
  return lineFields(content).slice(startLine - 1, startLine - 1 + limit).length;
}

function lineFields(content: string): string[] {
  if (content === "") return [];
  const fields: string[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "\n") continue;
    const line = content.slice(start, index);
    fields.push(line.endsWith("\r") ? line.slice(0, -1) : line);
    start = index + 1;
  }
  if (start < content.length) fields.push(content.slice(start));
  else if (content.endsWith("\n")) fields.push("");
  return fields;
}

export function isSkillMarkdown(path: string): boolean {
  const parts = normalize(path).split("/").filter(Boolean);
  const name = parts.at(-1) ?? "";
  return name === "SKILL.md" || (/\.md$/iu.test(name) && parts.includes("skills"));
}

export function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) >= 0) { count += 1; offset += needle.length; }
  return count;
}

export function nearestMatchHint(content: string, oldText: string): string {
  const keyword = (oldText.split(/\r?\n/u)[0] ?? "").split(/\s+/u).filter(Boolean).sort((a, b) => b.length - a.length)[0] ?? "";
  if (!keyword) return "";
  const lines = content.split("\n");
  const index = lines.findIndex((line) => line.includes(keyword));
  if (index < 0) return "";
  const full = `\n\nNearest match: line ${index + 1}: ${lines[index]?.replace(/\s+$/u, "") ?? ""}`;
  return full.length <= 200 ? full : `${full.slice(0, 199)}…`;
}
