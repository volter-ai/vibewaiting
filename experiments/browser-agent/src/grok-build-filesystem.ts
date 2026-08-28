import type { VirtualFS } from "almostnode";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

export type FileToolInput = Record<string, unknown>;

export interface GrokBuildFileReadResult {
  output: string;
  /** Data URLs attached inline to the Responses API function result. */
  images?: string[];
}

/** Native-shaped Grok Build file, tree, and grep tools over the browser VFS. */
export class GrokBuildFileSystemTools {
  constructor(private readonly vfs: VirtualFS, private readonly workspacePath = "/") {}

  async readFile(input: FileToolInput): Promise<GrokBuildFileReadResult> {
    const path = this.resolve(requiredString(input.target_file, "target_file"));
    if (!this.vfs.existsSync(path)) throw new Error(`Error: ${path} does not exist.`);
    if (this.vfs.statSync(path).isDirectory()) throw new Error(`Error: ${path} is a directory, not a file.`);
    const bytes = bytesOf(this.vfs.readFileSync(path));
    const mime = imageMime(path, bytes);
    if (mime) return readImage(path, bytes, mime);
    if (isPdf(path, bytes)) return readPdf(path, bytes, input);
    if (/\.pptx$/iu.test(path)) return readPptx(path, bytes);
    if (isBinary(path, bytes)) return { output: `Cannot read binary file: ${path}` };
    const content = this.vfs.readFileSync(path, "utf8");
    if (content === "") return { output: "File is empty." };

    const skillMarkdown = isSkillMarkdown(path);
    const requestedOffset = input.offset === undefined ? undefined : integer(input.offset, 1);
    const offset = skillMarkdown ? undefined : requestedOffset;
    const limit = skillMarkdown ? Number.MAX_SAFE_INTEGER : Math.min(
      input.limit === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, integer(input.limit, 0)),
      1_000,
    );
    const startLine = resolveReadStartLine(content, offset);
    const totalLines = occurrences(content, "\n") + 1;
    const selected = grokReadLines(content, startLine, limit);
    if (selected === "") {
      if (requestedOffset !== undefined && requestedOffset >= 0 && requestedOffset > totalLines) {
        return { output: `(no lines returned: the requested window is past the end of the file; the file has ${totalLines} lines)` };
      }
      return { output: "(no lines returned)" };
    }
    const tokenCount = new TextEncoder().encode(selected).byteLength >> 2;
    if (!skillMarkdown && tokenCount > 25_000) {
      const rangeSpecified = input.offset !== undefined || input.limit !== undefined;
      const singleLineHint = grokRawReadLineCount(content, startLine, limit) <= 1
        ? "\nNote: the requested read is a single very long line, so line-based offset/limit cannot narrow it further. Use the 'run_terminal_command' tool to extract the parts you need (e.g. `jq`, `python3`, or `cut -c`)."
        : "";
      if (rangeSpecified) {
        return { output: `The requested line range (offset=${requestedOffset ?? 1}, limit=${input.limit ?? "to end"}) contains ${tokenCount} tokens, which exceeds the maximum allowed tokens (25000 tokens).\nTry a smaller \`limit\`, a different starting \`offset\`, or use the 'grep' tool to search for specific content.${singleLineHint}` };
      }
      return { output: `File content (${tokenCount} tokens) exceeds maximum allowed tokens (25000 tokens).\nPlease use offset and limit parameters to read a shorter range, or use the 'grep' to search for specific content.${singleLineHint}` };
    }
    return { output: selected };
  }

  searchReplace(input: FileToolInput): string {
    const inputPath = requiredString(input.file_path, "file_path");
    for (const component of inputPath.split("/").filter((value) => value && value !== "." && value !== "..")) {
      if (component.length > 255) throw new Error(`Error: file name exceeds the 255-character limit (${component.length} characters). Please use a shorter file name.`);
    }
    const path = this.resolve(inputPath);
    const oldText = requiredString(input.old_string, "old_string", true);
    const newText = requiredString(input.new_string, "new_string", true);
    if (oldText === newText) throw new Error("Old string and new string are the same");
    if (oldText === "") {
      this.vfs.writeFileSync(path, newText);
      return `The file ${inputPath} has been created successfully.`;
    }
    const original = this.vfs.readFileSync(path, "utf8");
    const hasCrLf = original.includes("\r\n");
    const content = hasCrLf ? original.replaceAll("\r\n", "\n") : original;
    const count = occurrences(content, oldText);
    if (count === 0) {
      throw new Error(`The string to replace was not found in the file, use the read_file tool to see the correct string. The user may have changed the file since you last read it.${nearestMatchHint(content, oldText)}`);
    }
    const replaceAll = bool(input.replace_all, false);
    if (!replaceAll && count !== 1) {
      throw new Error("The string to replace was found multiple times in the file. Use replace_all to replace all occurrences, or include more context to only edit one occurrence.");
    }
    const updated = replaceAll ? content.replaceAll(oldText, newText) : content.replace(oldText, newText);
    this.vfs.writeFileSync(path, hasCrLf ? updated.replaceAll("\n", "\r\n") : updated);
    return replaceAll && count > 1
      ? `The file ${inputPath} has been updated. All occurrences were successfully replaced.`
      : `The file ${inputPath} has been updated successfully.`;
  }

  listDir(input: FileToolInput): string {
    const path = this.resolve(requiredString(input.target_directory, "target_directory"));
    if (!this.vfs.existsSync(path)) throw new Error(`Error: ${path} does not exist.`);
    if (!this.vfs.statSync(path).isDirectory()) throw new Error(`Error: ${path} is a file, not a directory.`);
    const body = renderDirectory(this.vfs, path, 10_000, this.workspacePath);
    return `- ${path.endsWith("/") ? path : `${path}/`}${body ? `\n${body}` : ""}`;
  }

  grep(input: FileToolInput): string {
    const root = this.resolve(typeof input.path === "string" ? input.path : ".");
    if (!this.vfs.existsSync(root)) throw new Error(`Error: ${root} does not exist.`);
    const multiline = bool(input.multiline, false);
    const flags = `${bool(input["-i"], false) ? "i" : ""}${multiline ? "s" : ""}u`;
    let regex: RegExp;
    try {
      regex = new RegExp(requiredString(input.pattern, "pattern"), flags);
    } catch (error) {
      throw new Error(`Error calling tool: ${error instanceof Error ? error.message : String(error)} (exit 2, root: ${root})`);
    }
    const glob = typeof input.glob === "string" ? input.glob : undefined;
    const fileType = typeof input.type === "string" ? input.type : undefined;
    const outputMode = typeof input.output_mode === "string" ? input.output_mode : "content";
    const fileMode = outputMode === "files_with_matches" || outputMode === "count";
    const headLimit = Math.max(0, Math.min(integer(input.head_limit, fileMode ? 500 : 200), fileMode ? 10_000 : 2_000));
    const context = Math.max(0, integer(input["-C"], 0));
    const before = Math.max(0, integer(input["-B"], context));
    const after = Math.max(0, integer(input["-A"], context));
    const fileResults: Array<{ file: string; lines: string[]; matchCount: number }> = [];
    for (const file of this.files(root)) {
      if (glob && !globMatches(file, glob)) continue;
      if (fileType && !matchesFileType(file, fileType)) continue;
      const content = this.vfs.readFileSync(file, "utf8");
      if (content.includes("\0")) continue;
      const lines = content.split(/\r?\n/u);
      const matched = new Set<number>();
      if (multiline) {
        const global = new RegExp(regex.source, `${regex.flags}g`);
        for (const match of content.matchAll(global)) {
          const start = countNewlines(content, match.index ?? 0);
          const end = start + countNewlines(match[0], match[0].length);
          for (let index = start; index <= end; index += 1) matched.add(index);
          if (match[0] === "") global.lastIndex += 1;
        }
      } else {
        for (let index = 0; index < lines.length; index += 1) {
          regex.lastIndex = 0;
          if (regex.test(lines[index] ?? "")) matched.add(index);
        }
      }
      if (matched.size === 0) continue;
      const selected = new Set<number>();
      for (const index of matched) {
        for (let candidate = Math.max(0, index - before); candidate <= Math.min(lines.length - 1, index + after); candidate += 1) selected.add(candidate);
      }
      const rendered: string[] = [];
      let prior = -2;
      for (const index of [...selected].sort((left, right) => left - right)) {
        if (prior >= 0 && index > prior + 1) rendered.push("--");
        rendered.push(`${index + 1}${matched.has(index) ? ":" : "-"}${truncateUtf16(lines[index] ?? "", 1_000)}`);
        prior = index;
      }
      fileResults.push({ file, lines: rendered, matchCount: matched.size });
    }
    if (fileResults.length === 0) return `<workspace_result workspace_path="${escapeAttribute(root)}">\nNo matches found\n</workspace_result>`;

    let raw: string[];
    let summary: string;
    if (outputMode === "files_with_matches") {
      raw = fileResults.map((result) => result.file);
      const truncated = raw.length > headLimit;
      raw = raw.slice(0, headLimit);
      summary = `Found ${truncated ? "at least " : ""}${raw.length} files`;
    } else if (outputMode === "count") {
      raw = fileResults.map((result) => `${result.file}:${result.matchCount}`);
      const truncated = raw.length > headLimit;
      raw = raw.slice(0, headLimit);
      const sum = raw.reduce((total, line) => total + Number.parseInt(line.slice(line.lastIndexOf(":") + 1), 10), 0);
      summary = `Found ${sum} across ${truncated ? "at least " : ""}${raw.length} files`;
    } else {
      raw = fileResults.flatMap((result, index) => [...(index > 0 ? [""] : []), result.file, ...result.lines]);
      const truncated = raw.length > headLimit;
      raw = raw.slice(0, headLimit);
      summary = `Found ${truncated ? "at least " : ""}${raw.filter((line) => /^\d+:/u.test(line)).length} matching lines`;
    }
    return `<workspace_result workspace_path="${escapeAttribute(root)}">\n${fitGrepOutput([summary, ...raw], 40 * 1_024)}\n</workspace_result>`;
  }

  write(input: FileToolInput): string {
    const path = this.resolve(requiredString(input.file_path, "file_path"));
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    this.vfs.mkdirSync(parent, { recursive: true });
    this.vfs.writeFileSync(path, requiredString(input.content, "content", true));
    return `Wrote ${path}`;
  }

  private *files(path: string): Generator<string> {
    if (this.vfs.statSync(path).isFile()) { yield path; return; }
    for (const name of this.vfs.readdirSync(path).filter((entry: string) => !entry.startsWith(".")).sort()) {
      const child = join(path, name);
      if (isGitignored(this.vfs, this.workspacePath, child)) continue;
      yield* this.files(child);
    }
  }

  private resolve(path: string): string {
    return normalize(path.startsWith("/") ? path : join(this.workspacePath, path));
  }
}

const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_RAW_BYTES = 768 * 1024 * 3 / 4;
const MAX_IMAGE_PIXELS = 1_048_576;
const MAX_IMAGE_DIMENSION = 2_000;

async function readImage(path: string, bytes: Uint8Array, mime: string): Promise<GrokBuildFileReadResult> {
  try {
    const dimensions = imageDimensions(bytes, mime);
    if (dimensions && (dimensions.width < 8 || dimensions.height < 8 || dimensions.width * dimensions.height < 512)) {
      return { output: `[Image from ${path} was not attached: too small for vision models]` };
    }
    const prepared = await prepareImage(bytes, mime);
    return {
      output: `Read image file: ${path}`,
      images: [`data:${prepared.mime};base64,${base64(prepared.bytes)}`],
    };
  } catch (error) {
    return { output: `Could not embed image in conversation: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function prepareImage(bytes: Uint8Array, mime: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const endpointNative = mime === "image/png" || mime === "image/jpeg" || mime === "image/webp";
  if (endpointNative && bytes.byteLength <= MAX_IMAGE_RAW_BYTES) return { bytes, mime };
  if (typeof createImageBitmap !== "function") {
    throw new Error("image requires browser canvas transcoding but the canvas decoder is unavailable");
  }
  const bitmap = await createImageBitmap(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }));
  try {
    const scale = Math.min(
      1,
      MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height),
      Math.sqrt(MAX_IMAGE_PIXELS / Math.max(1, bitmap.width * bitmap.height)),
    );
    let width = Math.max(1, Math.floor(bitmap.width * scale));
    let height = Math.max(1, Math.floor(bitmap.height * scale));
    for (const quality of [0.85, 0.7, 0.5, 0.4]) {
      const rendered = await renderBitmap(bitmap, width, height, "image/jpeg", quality);
      if (rendered.byteLength <= MAX_IMAGE_RAW_BYTES) return { bytes: rendered, mime: "image/jpeg" };
      width = Math.max(128, Math.floor(width * 0.8));
      height = Math.max(128, Math.floor(height * 0.8));
    }
    throw new Error(`compressed image still exceeds the ${768 * 1024}-byte conversation payload cap`);
  } finally {
    bitmap.close();
  }
}

async function renderBitmap(bitmap: ImageBitmap, width: number, height: number, mime: string, quality: number): Promise<Uint8Array> {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("image canvas context is unavailable");
    context.drawImage(bitmap, 0, 0, width, height);
    return new Uint8Array(await (await canvas.convertToBlob({ type: mime, quality })).arrayBuffer());
  }
  if (typeof document === "undefined") throw new Error("image canvas is unavailable");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("image canvas context is unavailable");
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("image encoding failed")), mime, quality));
  return new Uint8Array(await blob.arrayBuffer());
}

async function readPdf(path: string, bytes: Uint8Array, input: FileToolInput): Promise<GrokBuildFileReadResult> {
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    return { output: `PDF file is ${(bytes.byteLength / 1_048_576).toFixed(1)} MB, exceeds the 50 MB limit.` };
  }
  const format = typeof input.format === "string" ? input.format : "image";
  if (format !== "image" && format !== "text") {
    return { output: `Invalid format '${format}'. Supported values: 'image' (default), 'text'.` };
  }
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = typeof window === "undefined"
      ? new URL("../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).href
      : pdfWorkerUrl;
    const documentHandle = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true }).promise;
    let pageIndices: number[];
    try {
      pageIndices = parsePdfPages(typeof input.pages === "string" ? input.pages : undefined, documentHandle.numPages);
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error) };
    }
    if (format === "text") {
      const pageText: string[] = [];
      for (const index of pageIndices) {
        const page = await documentHandle.getPage(index + 1);
        const content = await page.getTextContent();
        pageText.push(`--- Page ${index + 1} ---\n${content.items.map((item) => "str" in item ? item.str : "").join(" ")}`);
      }
      return { output: numberEveryDocumentLine(pageText.join("\n")) };
    }
    if (typeof document === "undefined") throw new Error("PDF page rendering requires a browser canvas");
    const images: string[] = [];
    for (const index of pageIndices) {
      const page = await documentHandle.getPage(index + 1);
      const viewport = page.getViewport({ scale: 150 / 72 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("PDF canvas context is unavailable");
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PDF page encoding failed")), "image/jpeg", 0.85));
      images.push(`data:image/jpeg;base64,${base64(new Uint8Array(await blob.arrayBuffer()))}`);
    }
    return { output: `Read PDF file: ${path} (${images.length} pages rendered, ${documentHandle.numPages} total)`, images };
  } catch (error) {
    return { output: `Failed to open PDF: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function parsePdfPages(spec: string | undefined, pageCount: number): number[] {
  if (pageCount === 0) throw new Error("PDF has no pages");
  if (!spec) {
    if (pageCount > 10) {
      throw new Error(`PDF has ${pageCount} pages which exceeds the 10 page auto-read limit. Use the \`pages\` parameter to specify which pages to read (e.g. pages="1-5"). Maximum 20 pages per call.`);
    }
    return Array.from({ length: pageCount }, (_, index) => index);
  }
  const pages: number[] = [];
  for (const rawPart of spec.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    if (part.includes("-")) {
      const [rawStart = "", rawEnd = ""] = part.split("-", 2);
      const start = pdfPageNumber(rawStart.trim());
      const end = rawEnd.trim() ? pdfPageNumber(rawEnd.trim()) : pageCount;
      if (start < 1 || start > pageCount) throw new Error(`page ${start} out of range (document has ${pageCount} pages)`);
      if (start > end) throw new Error(`invalid page range: ${start}-${end} (start must be ≤ end)`);
      for (let page = start; page <= Math.min(end, pageCount); page += 1) pages.push(page - 1);
    } else {
      const page = pdfPageNumber(part);
      if (page < 1 || page > pageCount) throw new Error(`page ${page} out of range (document has ${pageCount} pages)`);
      pages.push(page - 1);
    }
  }
  const unique = [...new Set(pages)].sort((left, right) => left - right);
  if (unique.length > 20) throw new Error(`requested ${unique.length} pages, maximum is 20 per call`);
  if (unique.length === 0) throw new Error("no pages specified");
  return unique;
}

function pdfPageNumber(value: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`invalid page number: '${value}'`);
  const page = Number(value);
  if (!Number.isSafeInteger(page)) throw new Error(`invalid page number: '${value}'`);
  return page;
}

async function readPptx(path: string, bytes: Uint8Array): Promise<GrokBuildFileReadResult> {
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    return { output: `PPTX file is ${(bytes.byteLength / 1_048_576).toFixed(1)} MB, exceeds the 50 MB limit.` };
  }
  try {
    const entries = await unzipEntries(bytes);
    const slideNumbers = [...entries.keys()].flatMap((name) => {
      const match = /^ppt\/slides\/slide(\d+)\.xml$/u.exec(name);
      return match ? [Number(match[1])] : [];
    }).sort((left, right) => left - right);
    if (slideNumbers.length === 0) throw new Error("No slides found in PPTX");
    const slides: string[] = [];
    for (const number of slideNumbers) {
      const slide = drawingMlText(decodeUtf8(entries.get(`ppt/slides/slide${number}.xml`)!));
      const notesBytes = entries.get(`ppt/notesSlides/notesSlide${number}.xml`);
      const notes = notesBytes ? drawingMlText(decodeUtf8(notesBytes)) : "";
      slides.push(`--- Slide ${number} ---\n${slide}${notes ? `\n\nSpeaker Notes:\n${notes}` : ""}`);
    }
    return { output: numberEveryDocumentLine(slides.join("\n\n")) };
  } catch (error) {
    return { output: `Failed to extract text from PPTX: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function unzipEntries(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const eocd = findSignatureBackwards(bytes, 0x06054b50);
  if (eocd < 0) throw new Error("Failed to open PPTX archive: end-of-central-directory record not found");
  const count = u16(bytes, eocd + 10);
  let offset = u32(bytes, eocd + 16);
  const entries = new Map<string, Uint8Array>();
  let expandedBytes = 0;
  for (let index = 0; index < count; index += 1) {
    if (u32(bytes, offset) !== 0x02014b50) throw new Error("Failed to open PPTX archive: invalid central directory");
    const method = u16(bytes, offset + 10);
    const compressedSize = u32(bytes, offset + 20);
    const uncompressedSize = u32(bytes, offset + 24);
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    const localOffset = u32(bytes, offset + 42);
    const name = decodeUtf8(bytes.slice(offset + 46, offset + 46 + nameLength));
    expandedBytes += uncompressedSize;
    if (uncompressedSize > 64 * 1024 * 1024 || expandedBytes > 256 * 1024 * 1024) throw new Error("PPTX archive exceeds the decompressed size limit");
    if (name.startsWith("ppt/slides/") || name.startsWith("ppt/notesSlides/")) {
      if (u32(bytes, localOffset) !== 0x04034b50) throw new Error("Failed to open PPTX archive: invalid local entry");
      const localNameLength = u16(bytes, localOffset + 26);
      const localExtraLength = u16(bytes, localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.slice(start, start + compressedSize);
      entries.set(name, method === 0 ? compressed : method === 8 ? await inflateRaw(compressed) : (() => { throw new Error(`unsupported ZIP compression method ${method}`); })());
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice().buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function drawingMlText(xml: string): string {
  const paragraphs = xml.match(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/giu) ?? [];
  return paragraphs.map((paragraph) => [...paragraph.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/giu)]
    .map((match) => decodeXml(match[1] ?? "")).join("")).filter(Boolean).join("\n").trim();
}

function decodeXml(value: string): string {
  return value.replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/giu, (_whole, numeric: string | undefined, named: string | undefined) => {
    if (numeric) return String.fromCodePoint(Number.parseInt(numeric.startsWith("x") ? numeric.slice(1) : numeric, numeric.startsWith("x") ? 16 : 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[named?.toLowerCase() ?? ""] ?? _whole;
  });
}

function numberEveryDocumentLine(content: string): string {
  return content.split("\n").map((line, index) => `${index + 1}→${line}`).join("\n");
}

function imageMime(path: string, bytes: Uint8Array): string | undefined {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (decodeAscii(bytes.slice(0, 6)) === "GIF87a" || decodeAscii(bytes.slice(0, 6)) === "GIF89a") return "image/gif";
  if (decodeAscii(bytes.slice(0, 4)) === "RIFF" && decodeAscii(bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (starts(bytes, [0x42, 0x4d])) return "image/bmp";
  const extension = path.split(".").pop()?.toLowerCase();
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", svg: "image/svg+xml" } as Record<string, string>)[extension ?? ""];
}

function imageDimensions(bytes: Uint8Array, mime: string): { width: number; height: number } | undefined {
  if (mime === "image/png" && bytes.length >= 24) return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  if (mime === "image/gif" && bytes.length >= 10) return { width: u16(bytes, 6), height: u16(bytes, 8) };
  if (mime === "image/jpeg") {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1] ?? 0;
      const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { height: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0), width: ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0) };
      }
      if (length < 2) break;
      offset += length + 2;
    }
  }
  return undefined;
}

function isPdf(path: string, bytes: Uint8Array): boolean {
  return /\.pdf$/iu.test(path) || decodeAscii(bytes.slice(0, 5)) === "%PDF-";
}

function isBinary(path: string, bytes: Uint8Array): boolean {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (["zip", "gz", "tar", "exe", "dll", "so", "wasm", "mp3", "mp4", "mov", "avi"].includes(extension)) return true;
  return bytes.slice(0, Math.min(bytes.length, 8_192)).includes(0);
}

function bytesOf(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeUtf8(bytes: Uint8Array): string { return new TextDecoder().decode(bytes); }
function decodeAscii(bytes: Uint8Array): string { return String.fromCharCode(...bytes); }
function starts(bytes: Uint8Array, prefix: number[]): boolean { return prefix.every((value, index) => bytes[index] === value); }
function u16(bytes: Uint8Array, offset: number): number { return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8); }
function u32(bytes: Uint8Array, offset: number): number { return (u16(bytes, offset) | (u16(bytes, offset + 2) << 16)) >>> 0; }
function u32be(bytes: Uint8Array, offset: number): number { return (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0; }
function findSignatureBackwards(bytes: Uint8Array, signature: number): number {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) if (u32(bytes, offset) === signature) return offset;
  return -1;
}

function resolveReadStartLine(content: string, offset: number | undefined): number {
  const raw = offset ?? 1;
  if (raw === 0) return 1;
  if (raw > 0) return raw;
  let totalFields = content.split("\n").length;
  if (content !== "" && !content.endsWith("\n")) totalFields += 1;
  return Math.max(1, totalFields + raw + 1);
}

function grokReadLines(content: string, startLine: number, limit: number): string {
  return lineFields(content).slice(startLine - 1, startLine - 1 + limit).map((line, index) => {
    const lineNumber = startLine + index;
    return index === 0 || lineNumber % 10 === 0 ? `${lineNumber}→${line}` : line;
  }).join("\n");
}

function grokRawReadLineCount(content: string, startLine: number, limit: number): number {
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

function isSkillMarkdown(path: string): boolean {
  const parts = normalize(path).split("/").filter(Boolean);
  const name = parts.at(-1) ?? "";
  return name === "SKILL.md" || (/\.md$/iu.test(name) && parts.includes("skills"));
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) >= 0) { count += 1; offset += needle.length; }
  return count;
}

function nearestMatchHint(content: string, oldText: string): string {
  const keyword = (oldText.split(/\r?\n/u)[0] ?? "").split(/\s+/u).filter(Boolean).sort((a, b) => b.length - a.length)[0] ?? "";
  if (!keyword) return "";
  const lines = content.split("\n");
  const index = lines.findIndex((line) => line.includes(keyword));
  if (index < 0) return "";
  const full = `\n\nNearest match: line ${index + 1}: ${lines[index]?.replace(/\s+$/u, "") ?? ""}`;
  return full.length <= 200 ? full : `${full.slice(0, 199)}…`;
}

interface DirectoryNode {
  depth: number;
  files: string[];
  directories: string[];
  children: Map<string, DirectoryNode>;
  extensions: Map<string, number>;
  totalFiles: number;
  expanded: boolean;
}

function renderDirectory(vfs: VirtualFS, root: string, maxChars: number, workspace: string): string {
  const tree = directoryNode(0);
  let deepItems = 0;
  let truncated = false;
  const visit = (path: string, node: DirectoryNode, depth: number): void => {
    const names = vfs.readdirSync(path).filter((name: string) => !name.startsWith("."))
      .filter((name: string) => !isGitignored(vfs, workspace, join(path, name)))
      .sort((a: string, b: string) => a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase()));
    for (const name of names) {
      if (depth >= 1 && ++deepItems > 100_000) { truncated = true; return; }
      const childPath = join(path, name);
      if (vfs.statSync(childPath).isDirectory()) {
        const key = `${name}/`;
        const child = directoryNode(node.depth + 1);
        node.directories.push(key);
        node.children.set(key, child);
        visit(childPath, child, depth + 1);
        mergeExtensions(node, child);
      } else {
        node.files.push(name);
        addExtension(node, name);
      }
      if (truncated) return;
    }
  };
  visit(root, tree, 0);
  sortNode(tree);
  tree.expanded = true;
  const cutoff = truncated ? "\nNote: there are more than 100000 items in the directory, so not all files may be shown.\n" : "";
  const initial = renderExpanded(tree);
  if (initial.length > maxChars) return `${renderTruncatedRoot(tree, maxChars)}${cutoff}`.trimEnd();
  let remaining = maxChars - initial.length;
  const queue = tree.directories.map((name) => [name]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const node = navigateNode(tree, path);
    if (!node) continue;
    node.expanded = true;
    const expanded = renderExpanded(node);
    const summaryCost = directorySummaryCost(node);
    if (expanded.length > remaining + summaryCost) { node.expanded = false; continue; }
    remaining += summaryCost - expanded.length;
    for (const name of node.directories) queue.push([...path, name]);
  }
  return `${renderExpanded(tree)}${cutoff}`.trimEnd();
}

function directoryNode(depth: number): DirectoryNode {
  return { depth, files: [], directories: [], children: new Map(), extensions: new Map(), totalFiles: 0, expanded: false };
}

function addExtension(node: DirectoryNode, name: string): void {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLocaleLowerCase() : "no-ext";
  node.totalFiles += 1;
  node.extensions.set(extension, (node.extensions.get(extension) ?? 0) + 1);
}

function mergeExtensions(parent: DirectoryNode, child: DirectoryNode): void {
  parent.totalFiles += child.totalFiles;
  for (const [extension, count] of child.extensions) parent.extensions.set(extension, (parent.extensions.get(extension) ?? 0) + count);
}

function sortNode(node: DirectoryNode): void {
  const compare = (a: string, b: string): number => a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase());
  node.files.sort(compare);
  node.directories.sort(compare);
  for (const child of node.children.values()) sortNode(child);
}

function directoryItems(node: DirectoryNode): string[] {
  return [...node.files, ...node.directories].sort((a, b) => a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase()));
}

function directorySummary(node: DirectoryNode): string {
  if (node.extensions.size === 0) return "";
  const entries = [...node.extensions].sort(([a, left], [b, right]) => right - left || a.localeCompare(b));
  const top = entries.slice(0, 3);
  const shown = top.reduce((sum, [, count]) => sum + count, 0);
  const parts = top.map(([extension, count]) => `${count} *${extension === "no-ext" ? "no-ext" : `.${extension}`}`);
  return `[${node.totalFiles} ${node.totalFiles === 1 ? "file" : "files"} in subtree: ${parts.join(", ")}${shown < node.totalFiles ? ", ..." : ""}]`;
}

function renderExpanded(node: DirectoryNode): string {
  let output = "";
  for (const name of directoryItems(node)) {
    output += `${"  ".repeat(node.depth + 1)}- ${name}\n`;
    const child = node.children.get(name);
    if (child) output += child.expanded ? renderExpanded(child) : renderSummary(child);
  }
  return output;
}

function renderSummary(node: DirectoryNode): string {
  const summary = directorySummary(node);
  return summary ? `${"  ".repeat(node.depth + 1)}${summary}\n` : "";
}

function directorySummaryCost(node: DirectoryNode): number {
  const summary = directorySummary(node);
  return summary ? (node.depth + 1) * 2 + summary.length + 1 : 0;
}

function navigateNode(root: DirectoryNode, path: readonly string[]): DirectoryNode | undefined {
  let node = root;
  for (const name of path) {
    const child = node.children.get(name);
    if (!child) return;
    node = child;
  }
  return node;
}

function renderTruncatedRoot(root: DirectoryNode, maxChars: number): string {
  let output = "";
  for (const name of directoryItems(root)) {
    let chunk = `  - ${name}\n`;
    const child = root.children.get(name);
    const summary = child ? directorySummary(child) : "";
    if (summary) chunk += `    ${summary}\n`;
    if (output.length + chunk.length > maxChars) break;
    output += chunk;
  }
  return `${output}    ...\n\n    Note: this directory is too large to list fully. Try list_dir on a narrower path, or use grep / run_terminal_command.`;
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function join(left: string, right: string): string {
  return normalize(`${left}/${right}`);
}

function globMatches(path: string, glob: string): boolean {
  return expandBraceGlob(glob).some((candidate) => {
    const pattern = candidate.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("**", "\u0000")
      .replaceAll("*", "[^/]*").replaceAll("?", "[^/]").replaceAll("\u0000", ".*");
    return new RegExp(`(?:^|/)${pattern}$`, "u").test(path);
  });
}

function expandBraceGlob(glob: string): string[] {
  const match = /\{([^{}]+)\}/u.exec(glob);
  if (!match || match.index === undefined) return [glob];
  return match[1]!.split(",").flatMap((choice) => expandBraceGlob(`${glob.slice(0, match.index)}${choice}${glob.slice(match.index + match[0].length)}`));
}

const FILE_TYPE_EXTENSIONS: Record<string, readonly string[]> = {
  c: ["c", "h"], cpp: ["cc", "cpp", "cxx", "h", "hpp"], css: ["css"], go: ["go"],
  html: ["htm", "html"], java: ["java"], js: ["cjs", "js", "jsx", "mjs"], json: ["json"],
  markdown: ["md", "markdown"], py: ["py", "pyi"], rust: ["rs"], sh: ["bash", "sh", "zsh"],
  ts: ["cts", "mts", "ts", "tsx"], yaml: ["yaml", "yml"],
};

function matchesFileType(path: string, type: string): boolean {
  const extensions = FILE_TYPE_EXTENSIONS[type.toLocaleLowerCase()];
  if (!extensions) throw new Error(`Error calling tool: unrecognized file type: ${type}`);
  return extensions.includes(path.slice(path.lastIndexOf(".") + 1).toLocaleLowerCase());
}

function countNewlines(value: string, end = value.length): number {
  let count = 0;
  for (let index = 0; index < end; index += 1) if (value[index] === "\n") count += 1;
  return count;
}

function truncateUtf16(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function fitGrepOutput(lines: readonly string[], maxBytes: number): string {
  const encoder = new TextEncoder();
  const output: string[] = [];
  let bytes = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const next = encoder.encode(line).byteLength;
    if (bytes + next > maxBytes) {
      const remaining = lines.slice(index).filter((candidate) => /^\d+:/u.test(candidate)).length;
      if (remaining > 0) output.push(`... [${remaining} lines truncated] ...`);
      break;
    }
    output.push(line);
    bytes += next;
  }
  return output.join("\n");
}

function isGitignored(vfs: VirtualFS, workspace: string, target: string): boolean {
  const normalizedWorkspace = normalize(workspace);
  if (target === normalizedWorkspace || !target.startsWith(`${normalizedWorkspace === "/" ? "" : normalizedWorkspace}/`)) return false;
  const relativeTarget = target.slice(normalizedWorkspace === "/" ? 1 : normalizedWorkspace.length + 1);
  const components = relativeTarget.split("/");
  let ignored = false;
  for (let depth = 0; depth < components.length; depth += 1) {
    const directoryRelative = components.slice(0, depth).join("/");
    const ignorePath = join(normalizedWorkspace, `${directoryRelative ? `${directoryRelative}/` : ""}.gitignore`);
    if (!vfs.existsSync(ignorePath) || vfs.statSync(ignorePath).isDirectory()) continue;
    const pathFromIgnore = components.slice(depth).join("/");
    for (const raw of vfs.readFileSync(ignorePath, "utf8").split(/\r?\n/u)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const negated = line.startsWith("!");
      const pattern = negated ? line.slice(1) : line;
      const directoryOnly = pattern.endsWith("/");
      const cleaned = pattern.replace(/^\//u, "").replace(/\/$/u, "");
      const candidate = directoryOnly ? pathFromIgnore.split("/").slice(0, -1).join("/") || pathFromIgnore : pathFromIgnore;
      if (globMatches(candidate, cleaned) || (!cleaned.includes("/") && candidate.split("/").includes(cleaned))) ignored = !negated;
    }
  }
  return ignored;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function requiredString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new Error(`${name} must be a${allowEmpty ? "" : " non-empty"} string`);
  return value;
}

function integer(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value)) throw new Error("Expected an integer");
  return value as number;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
