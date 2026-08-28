export interface GrokPptxReadResult { output: string }

const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export async function readGrokPptx(path: string, bytes: Uint8Array): Promise<GrokPptxReadResult> {
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    return { output: `PPTX file is ${(bytes.byteLength / 1_048_576).toFixed(1)} MB, exceeds the 50 MB limit.` };
  }
  try {
    const timeoutMessage = `PPTX processing timed out after 60s: ${path}`;
    const content = await withDocumentTimeout(extractPptx(bytes, Date.now() + 60_000, timeoutMessage), 60_000, timeoutMessage);
    return { output: numberEveryDocumentLine(content) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { output: detail.startsWith("PPTX processing timed out after ") ? detail : `Failed to extract text from PPTX: ${detail}` };
  }
}

async function extractPptx(bytes: Uint8Array, deadline: number, timeoutMessage: string): Promise<string> {
  const entries = await unzipEntries(bytes);
  const slideNumbers = [...entries.keys()].flatMap((name) => {
    const match = /^ppt\/slides\/slide(\d+)\.xml$/u.exec(name);
    return match ? [Number(match[1])] : [];
  }).sort((left, right) => left - right);
  if (slideNumbers.length === 0) throw new Error("No slides found in PPTX");
  const slides: string[] = [];
  for (const number of slideNumbers) {
    if (Date.now() >= deadline) throw new Error(timeoutMessage);
    const slideEntry = entries.get(`ppt/slides/slide${number}.xml`);
    if (slideEntry instanceof Error) throw slideEntry;
    if (!slideEntry) throw new Error(`Failed to read slide ${number}`);
    let slideXml: string;
    try { slideXml = decodeUtf8Strict(slideEntry); }
    catch (error) { throw new Error(`Failed to read ppt/slides/slide${number}.xml: ${message(error)}`); }
    let slide: string;
    try { slide = drawingMlText(slideXml, deadline, timeoutMessage); }
    catch (error) {
      if (error instanceof Error && error.message === timeoutMessage) throw error;
      throw new Error(`Error parsing slide ${number}: ${message(error)}`);
    }
    const notesEntry = entries.get(`ppt/notesSlides/notesSlide${number}.xml`);
    let notes = "";
    if (notesEntry && !(notesEntry instanceof Error)) {
      try { notes = drawingMlText(decodeUtf8Strict(notesEntry), deadline, timeoutMessage); }
      catch (error) {
        if (error instanceof Error && error.message === timeoutMessage) throw error;
        // Native notes extraction is best effort.
      }
    }
    slides.push(`--- Slide ${number} ---\n${slide}${notes ? `\n\nSpeaker Notes:\n${notes}` : ""}`);
  }
  return slides.join("\n\n");
}

async function unzipEntries(bytes: Uint8Array): Promise<Map<string, Uint8Array | Error>> {
  const eocd = findSignatureBackwards(bytes, 0x06054b50);
  if (eocd < 0) throw new Error("Failed to open PPTX archive: end-of-central-directory record not found");
  const count = u16(bytes, eocd + 10);
  let offset = u32(bytes, eocd + 16);
  const entries = new Map<string, Uint8Array | Error>();
  for (let index = 0; index < count; index += 1) {
    if (u32(bytes, offset) !== 0x02014b50) throw new Error("Failed to open PPTX archive: invalid central directory");
    const method = u16(bytes, offset + 10);
    const expectedCrc = u32(bytes, offset + 16);
    const compressedSize = u32(bytes, offset + 20);
    const uncompressedSize = u32(bytes, offset + 24);
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    const localOffset = u32(bytes, offset + 42);
    const name = decodeUtf8(bytes.slice(offset + 46, offset + 46 + nameLength));
    const relevant = name.startsWith("ppt/slides/") || name.startsWith("ppt/notesSlides/");
    if (uncompressedSize > MAX_ENTRY_BYTES && relevant) {
      entries.set(name, new Error(`${name} exceeds the decompressed size limit`));
      offset += 46 + nameLength + extraLength + commentLength;
      continue;
    }
    if (relevant) {
      try {
        if (u32(bytes, localOffset) !== 0x04034b50) throw new Error(`Failed to open ${name}: invalid local entry`);
        const start = localOffset + 30 + u16(bytes, localOffset + 26) + u16(bytes, localOffset + 28);
        if (start + compressedSize > bytes.length) throw new Error(`Failed to read ${name}: truncated ZIP entry`);
        const compressed = bytes.slice(start, start + compressedSize);
        const content = method === 0 ? compressed : method === 8 ? await inflateRaw(compressed) : unsupportedCompression(name, method);
        if (content.byteLength >= MAX_ENTRY_BYTES) throw new Error(`${name} exceeds the decompressed size limit`);
        if (crc32(content) !== expectedCrc) throw new Error(`Failed to read ${name}: CRC mismatch`);
        entries.set(name, content);
      } catch (error) {
        entries.set(name, error instanceof Error ? error : new Error(String(error)));
      }
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function unsupportedCompression(name: string, method: number): never {
  throw new Error(`Failed to read ${name}: unsupported ZIP compression method ${method}`);
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice().buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function drawingMlText(xml: string, deadline: number, timeoutMessage: string): string {
  let output = "";
  let cursor = 0;
  let inTextRun = false;
  const stack: string[] = [];
  while (cursor < xml.length) {
    if ((cursor & 0xffff) === 0 && Date.now() >= deadline) throw new Error(timeoutMessage);
    const open = xml.indexOf("<", cursor);
    const textEnd = open < 0 ? xml.length : open;
    if (inTextRun && textEnd > cursor) output += decodeXml(xml.slice(cursor, textEnd));
    if (open < 0) break;
    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open + 4);
      if (end < 0) throw new Error("unclosed XML comment");
      cursor = end + 3; continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const end = xml.indexOf("]]>", open + 9);
      if (end < 0) throw new Error("unclosed CDATA section");
      cursor = end + 3; continue;
    }
    if (xml.startsWith("<?", open)) {
      const end = xml.indexOf("?>", open + 2);
      if (end < 0) throw new Error("unclosed XML processing instruction");
      cursor = end + 2; continue;
    }
    const close = xmlTagEnd(xml, open + 1);
    if (close < 0) throw new Error("unclosed XML tag");
    const raw = xml.slice(open + 1, close).trim();
    if (!raw) throw new Error("empty XML tag");
    if (raw.startsWith("!")) { cursor = close + 1; continue; }
    const isEnd = raw.startsWith("/");
    const selfClosing = !isEnd && raw.endsWith("/");
    const name = raw.slice(isEnd ? 1 : 0).replace(/\/$/u, "").trim().split(/\s/u, 1)[0] ?? "";
    if (!/^[A-Za-z_][\w.:-]*$/u.test(name)) throw new Error(`invalid XML tag ${JSON.stringify(name)}`);
    const local = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
    if (isEnd) {
      const expected = stack.pop();
      if (expected !== name) throw new Error(`mismatched closing tag: expected </${expected ?? ""}> but found </${name}>`);
      if (local === "t") inTextRun = false;
      if (local === "p" && output && !output.endsWith("\n")) output += "\n";
    } else if (!selfClosing) {
      stack.push(name);
      if (local === "t") inTextRun = true;
    }
    cursor = close + 1;
  }
  if (stack.length) throw new Error(`unclosed XML tag <${stack.at(-1)}>`);
  return output.trim();
}

function xmlTagEnd(xml: string, start: number): number {
  let quote = "";
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index] ?? "";
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === ">") return index;
  }
  return -1;
}

function decodeXml(value: string): string {
  for (let index = value.indexOf("&"); index >= 0; index = value.indexOf("&", index + 1)) {
    if (!/^&(?:#x[0-9a-fA-F]+|#\d+|[A-Za-z_:][\w.:-]*);/u.test(value.slice(index))) throw new Error("malformed entity reference");
  }
  return value.replace(/&#(x[0-9a-fA-F]+|\d+);|&(amp|lt|gt|quot|apos);/gu, (whole, numeric: string | undefined, named: string | undefined) => {
    if (numeric) return String.fromCodePoint(Number.parseInt(numeric.startsWith("x") ? numeric.slice(1) : numeric, numeric.startsWith("x") ? 16 : 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[named ?? ""] ?? whole;
  });
}

async function withDocumentTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findSignatureBackwards(bytes: Uint8Array, signature: number): number {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) if (u32(bytes, offset) === signature) return offset;
  return -1;
}

function numberEveryDocumentLine(content: string): string { return content.split("\n").map((line, index) => `${index + 1}→${line}`).join("\n"); }
function decodeUtf8Strict(bytes: Uint8Array): string { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
function decodeUtf8(bytes: Uint8Array): string { return new TextDecoder().decode(bytes); }
function u16(bytes: Uint8Array, offset: number): number { return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8); }
function u32(bytes: Uint8Array, offset: number): number { return (u16(bytes, offset) | (u16(bytes, offset + 2) << 16)) >>> 0; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
