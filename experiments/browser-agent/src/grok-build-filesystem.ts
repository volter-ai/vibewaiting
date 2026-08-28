import type { VirtualFS } from "almostnode";
import { isGrokPdf, readGrokPdf } from "./grok-build-file-pdf.js";
import { readGrokPptx } from "./grok-build-file-pptx.js";
export { parseGrokPdfPages } from "./grok-build-file-pdf.js";
import {
  countNewlines,
  fitGrepOutput,
  globMatches,
  isGitignored,
  join,
  matchesFileType,
  normalize,
  renderDirectory,
  truncateUtf16,
} from "./grok-build-file-tree.js";
import {
  grokRawReadLineCount,
  grokReadWindow,
  isSkillMarkdown,
  lenientSignedInteger,
  nearestMatchHint,
  occurrences,
  resolveReadStartLine,
} from "./grok-build-file-text.js";

export type FileToolInput = Record<string, unknown>;

export interface GrokBuildFileReadResult {
  output: string;
  /** Data URLs attached inline to the Responses API function result. */
  images?: string[];
  /** Images extracted from textual tool output and framed as follow-up reminders. */
  deferredImages?: string[];
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
    if (isGrokPdf(path, bytes)) return readGrokPdf(path, bytes, input);
    if (/\.pptx$/iu.test(path)) return readGrokPptx(path, bytes);
    if (isBinary(path, bytes)) return { output: `Cannot read binary file: ${path}` };
    const content = this.vfs.readFileSync(path, "utf8");
    if (content === "") return { output: "File is empty." };

    const skillMarkdown = isSkillMarkdown(path);
    const requestedOffset = input.offset === undefined || input.offset === null ? undefined : lenientSignedInteger(input.offset);
    const offset = skillMarkdown ? undefined : requestedOffset;
    const limit = skillMarkdown ? Number.MAX_SAFE_INTEGER : Math.min(
      input.limit === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, integer(input.limit, 0)),
      1_000,
    );
    const startLine = resolveReadStartLine(content, offset);
    const totalLines = occurrences(content, "\n") + 1;
    const selected = grokReadWindow(content, startLine, limit);
    if (selected.output === "") {
      if (requestedOffset !== undefined && requestedOffset >= 0 && requestedOffset > totalLines) {
        return { output: `(no lines returned: the requested window is past the end of the file; the file has ${totalLines} lines)` };
      }
      return { output: "(no lines returned)" };
    }
    const tokenCount = new TextEncoder().encode(selected.output).byteLength >> 2;
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
    return { output: selected.output, ...(selected.images.length > 0 ? { deferredImages: selected.images } : {}) };
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
    const existed = this.vfs.existsSync(path);
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    this.vfs.mkdirSync(parent, { recursive: true });
    this.vfs.writeFileSync(path, requiredString(input.content, "content", true));
    return existed
      ? `Wrote file successfully to ${path}.`
      : `The file ${path} has been created.`;
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

const MAX_IMAGE_RAW_BYTES = 768 * 1024 * 3 / 4;
const MAX_IMAGE_PIXELS = 1_048_576;
const MAX_IMAGE_DIMENSION = 2_000;
const MAX_IMAGE_DECODE_PIXELS = 178_956_970;

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
  const dimensions = imageDimensions(bytes, mime);
  const withinPixelBudget = !dimensions || (
    dimensions.width <= MAX_IMAGE_DIMENSION
    && dimensions.height <= MAX_IMAGE_DIMENSION
    && dimensions.width * dimensions.height <= MAX_IMAGE_PIXELS
  );
  // Native only passes through complete endpoint containers. In particular,
  // PNG CRCs and a top-level JPEG EOI are checked before the small-byte fast path.
  if (endpointNative && bytes.byteLength <= MAX_IMAGE_RAW_BYTES && withinPixelBudget && imageStructurallyComplete(bytes, mime)) {
    return { bytes, mime };
  }
  if (dimensions && dimensions.width * dimensions.height > MAX_IMAGE_DECODE_PIXELS) {
    throw new Error(`image dimensions ${dimensions.width}x${dimensions.height} exceed the ${MAX_IMAGE_DECODE_PIXELS} pixel decode limit`);
  }
  if (typeof createImageBitmap !== "function") {
    throw new Error("image requires browser canvas transcoding but the canvas decoder is unavailable");
  }
  const bitmap = await createImageBitmap(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }));
  try {
    const long = Math.max(bitmap.width, bitmap.height);
    const short = Math.min(bitmap.width, bitmap.height);
    let maxSide = Math.min(MAX_IMAGE_DIMENSION, long);
    if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) {
      maxSide = Math.min(maxSide, areaCappedImageSide(long, short, MAX_IMAGE_PIXELS));
    }
    for (;;) {
      const scale = Math.min(1, maxSide / Math.max(1, long));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const png = await renderBitmap(bitmap, width, height, "image/png", 1);
      const pngCandidate = png.byteLength <= MAX_IMAGE_RAW_BYTES ? png : undefined;
      let jpegCandidate: Uint8Array | undefined;
      for (const quality of [0.85, 0.7, 0.5, 0.4]) {
        const jpeg = await renderBitmap(bitmap, width, height, "image/jpeg", quality);
        if (jpeg.byteLength <= MAX_IMAGE_RAW_BYTES) { jpegCandidate = jpeg; break; }
      }
      if (pngCandidate && jpegCandidate) {
        return pngCandidate.byteLength <= jpegCandidate.byteLength
          ? { bytes: pngCandidate, mime: "image/png" }
          : { bytes: jpegCandidate, mime: "image/jpeg" };
      }
      if (pngCandidate) return { bytes: pngCandidate, mime: "image/png" };
      if (jpegCandidate) return { bytes: jpegCandidate, mime: "image/jpeg" };
      if (maxSide <= 128) break;
      maxSide = Math.floor(maxSide * 3 / 4);
    }
    throw new Error(`compressed image still exceeds the ${768 * 1024}-byte conversation payload cap`);
  } finally {
    bitmap.close();
  }
}

function areaCappedImageSide(long: number, short: number, maxPixels: number): number {
  let side = Math.max(1, Math.min(long, Math.floor(long * Math.sqrt(maxPixels / Math.max(1, long * short)))));
  while (side > 1 && Math.max(1, Math.round(long * side / long)) * Math.max(1, Math.round(short * side / long)) > maxPixels) side -= 1;
  return side;
}

function imageStructurallyComplete(bytes: Uint8Array, mime: string): boolean {
  if (mime === "image/png") return pngStructurallyValid(bytes);
  if (mime === "image/jpeg") return jpegReachesEoi(bytes);
  if (mime === "image/webp") {
    if (bytes.length < 12 || decodeAscii(bytes.slice(0, 4)) !== "RIFF" || decodeAscii(bytes.slice(8, 12)) !== "WEBP") return false;
    const riffSize = u32(bytes, 4);
    return riffSize <= Number.MAX_SAFE_INTEGER - 8 && riffSize + 8 <= bytes.length;
  }
  return false;
}

function pngStructurallyValid(bytes: Uint8Array): boolean {
  if (!starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return false;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = u32be(bytes, offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const end = dataEnd + 4;
    if (!Number.isSafeInteger(end) || end > bytes.length) return false;
    const expected = u32be(bytes, dataEnd);
    if (crc32(bytes.subarray(offset + 4, dataEnd)) !== expected) return false;
    if (decodeAscii(bytes.slice(offset + 4, offset + 8)) === "IEND") return true;
    offset = end;
  }
  return false;
}

function jpegReachesEoi(bytes: Uint8Array): boolean {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  for (;;) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset++]!;
    if (marker === 0x00) continue;
    if (marker === 0xd9) return true;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const next = skipJpegSegment(bytes, offset);
    if (next === undefined) return false;
    offset = next;
    if (marker !== 0xda) continue;
    for (;;) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
      if (offset + 1 >= bytes.length) return false;
      const following = bytes[offset + 1]!;
      if (following === 0x00) offset += 2;
      else if (following === 0xff) offset += 1;
      else if (following >= 0xd0 && following <= 0xd7) offset += 2;
      else break;
    }
  }
}

function skipJpegSegment(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 2 > bytes.length) return undefined;
  const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
  if (length < 2 || offset + length > bytes.length) return undefined;
  return offset + length;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
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

function imageMime(_path: string, bytes: Uint8Array): string | undefined {
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(bytes, [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a, 0x00])) return "image/jp2";
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (starts(bytes, [0x47, 0x49, 0x46])) return "image/gif";
  if (decodeAscii(bytes.slice(8, 12)) === "WEBP") return "image/webp";
  const tiff = starts(bytes, [0x49, 0x49, 0x2a, 0x00]) || starts(bytes, [0x4d, 0x4d, 0x00, 0x2a]);
  if (tiff && bytes.length > 10 && bytes[8] === 0x43 && bytes[9] === 0x52 && bytes[10] === 0x02) return "image/x-canon-cr2";
  if (tiff && bytes.length > 9 && !(bytes[8] === 0x43 && bytes[9] === 0x52)) return "image/tiff";
  if (starts(bytes, [0x42, 0x4d])) return "image/bmp";
  if (starts(bytes, [0x49, 0x49, 0xbc])) return "image/vnd.ms-photo";
  if (starts(bytes, [0x38, 0x42, 0x50, 0x53])) return "image/vnd.adobe.photoshop";
  if (starts(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/vnd.microsoft.icon";
  if ((bytes.length > 2 && starts(bytes, [0xff, 0x0a])) || (bytes.length > 12 && starts(bytes, [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]))) return "image/jxl";
  const brands = isoBmffBrands(bytes);
  if (brands && (brands.major === "heic" || brands.major === "heix" || ((brands.major === "mif1" || brands.major === "msf1") && brands.compatible.includes("heic")))) return "image/heif";
  if (brands && (brands.major === "avif" || brands.major === "avis" || brands.compatible.some((brand) => brand === "avif" || brand === "avis"))) return "image/avif";
  if (bytes.length > 57 && starts(bytes, [0x50, 0x4b, 0x03, 0x04]) && decodeAscii(bytes.slice(30, 54)) === "mimetypeimage/openraster") return "image/openraster";
  if (bytes.length > 14 && decodeAscii(bytes.slice(0, 8)) === "AT&TFORM" && decodeAscii(bytes.slice(12, 15)) === "DJV") return "image/vnd.djvu";
  return undefined;
}

function isoBmffBrands(bytes: Uint8Array): { major: string; compatible: string[] } | undefined {
  if (bytes.length < 16 || decodeAscii(bytes.slice(4, 8)) !== "ftyp") return undefined;
  const length = u32be(bytes, 0);
  if (length < 16 || length > bytes.length) return undefined;
  const compatible: string[] = [];
  for (let offset = 16; offset + 4 <= length; offset += 4) compatible.push(decodeAscii(bytes.slice(offset, offset + 4)));
  return { major: decodeAscii(bytes.slice(8, 12)), compatible };
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

function isBinary(path: string, bytes: Uint8Array): boolean {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (["7z", "a", "avi", "avif", "bin", "bmp", "class", "dat", "dll", "doc", "docx", "dylib", "exe", "gif", "gz", "ico", "jar", "jpeg", "jpg", "lib", "mov", "mp3", "mp4", "o", "obj", "odp", "ods", "odt", "png", "ppt", "pyc", "pyd", "pyo", "qoi", "rar", "so", "tar", "tif", "tiff", "war", "wasm", "webp", "xls", "xlsx", "zip"].includes(extension)) return true;
  const sample = bytes.slice(0, Math.min(bytes.length, 8_192));
  if (sample.includes(0)) return true;
  let nonPrintable = 0;
  for (const byte of sample) if (byte < 9 || (byte >= 14 && byte <= 31)) nonPrintable += 1;
  return sample.length > 0 && nonPrintable / sample.length > 0.3;
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

function decodeAscii(bytes: Uint8Array): string { return String.fromCharCode(...bytes); }
function starts(bytes: Uint8Array, prefix: number[]): boolean { return prefix.every((value, index) => bytes[index] === value); }
function u16(bytes: Uint8Array, offset: number): number { return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8); }
function u32(bytes: Uint8Array, offset: number): number { return (u16(bytes, offset) | (u16(bytes, offset + 2) << 16)) >>> 0; }
function u32be(bytes: Uint8Array, offset: number): number { return (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0; }

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
