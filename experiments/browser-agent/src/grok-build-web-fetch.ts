import type { VirtualFS } from "almostnode";
import initHtmlToMarkdown, {
  convert_html_to_markdown as convertHtmlToMarkdown,
} from "./wasm/grok_html_to_markdown.js";

const MAX_MARKDOWN_BYTES = 100_000;
const CONTEXT_WINDOW_TOKENS = 500_000;
const INLINE_PREVIEW_BYTES = Math.min(MAX_MARKDOWN_BYTES, Math.floor(CONTEXT_WINDOW_TOKENS * 4 * 0.03));
const BINARY_MIME_TYPES = new Set([
  "application/octet-stream", "application/pdf", "application/zip", "application/gzip",
  "application/x-7z-compressed", "application/x-rar-compressed", "application/x-tar",
]);

type HtmlConverter = (html: string) => string | Promise<string>;

let htmlConverterReady: Promise<unknown> | undefined;

export async function convertGrokHtmlToMarkdown(html: string): Promise<string> {
  htmlConverterReady ??= initHtmlToMarkdown();
  await htmlConverterReady;
  return convertHtmlToMarkdown(html);
}

export class GrokBuildWebFetchClient {
  private nextArtifact = 1;

  constructor(
    private readonly vfs: VirtualFS,
    private readonly endpoint = "/api/grok/web-fetch",
    private readonly htmlConverter: HtmlConverter = convertGrokHtmlToMarkdown,
  ) {}

  async fetch(url: string, signal: AbortSignal): Promise<string> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: { message?: unknown } };
      const detail = typeof payload.error?.message === "string" ? payload.error.message : `HTTP ${response.status}`;
      throw new Error(`Error fetching URL ${url}: ${detail}`);
    }
    if (response.headers.get("X-Vibewaiting-Web-Fetch-Kind") !== "content") {
      const redirect = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (redirect.kind === "cross-host-redirect"
        && typeof redirect.originalHost === "string"
        && typeof redirect.redirectUrl === "string") {
        return `Error: cross-host redirect from ${redirect.originalHost} to ${redirect.redirectUrl}. Make a new web_fetch call with the redirect URL if needed.`;
      }
      throw new Error(`Error fetching URL ${url}: invalid relay response`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get("Content-Type") ?? "text/html";
    const mime = contentType.split(";", 1)[0]!.trim().toLowerCase();
    if (mime === "application/pdf") return this.saveMedia("downloads", "pdf", bytes, contentType, "PDF");
    if (mime.startsWith("image/") && mime !== "image/svg+xml") {
      validateMediaMagicBytes(mime, bytes);
      return this.saveMedia("images", mediaExtension(mime), bytes, contentType, "Image");
    }
    if (mime.startsWith("video/")) {
      validateMediaMagicBytes(mime, bytes);
      return this.saveMedia("videos", mediaExtension(mime), bytes, contentType, "Video");
    }
    if (isBinaryMime(mime)) throw new Error(`Unsupported content type ${contentType} from ${url}`);

    const raw = new TextDecoder().decode(bytes);
    const converted = mime === "text/html" || mime === "application/xhtml+xml"
      ? await this.htmlConverter(raw)
      : raw;
    return this.inlineOrPersist(stripBase64DataUris(converted), mime === "text/html" || mime === "application/xhtml+xml" ? "markdown" : contentType);
  }

  private saveMedia(directory: string, extension: string, bytes: Uint8Array, contentType: string, label: string): string {
    const path = `/.grok/${directory}/${this.nextArtifact++}.${extension}`;
    this.vfs.mkdirSync(`/.grok/${directory}`, { recursive: true });
    this.vfs.writeFileSync(path, bytes);
    const readHint = label === "Video" ? "" : " Use the read_file tool to view its contents.";
    return `${label} downloaded (${bytes.byteLength} bytes${label === "PDF" ? "" : `, ${contentType}`}) and saved to ${path}.${readHint}`;
  }

  private inlineOrPersist(content: string, contentType: string): string {
    const byteLength = utf8Length(content);
    if (byteLength <= INLINE_PREVIEW_BYTES) return content;
    const extension = payloadExtension(contentType, content);
    const path = `/.grok/web_fetch/${this.nextArtifact++}.${extension}`;
    this.vfs.mkdirSync("/.grok/web_fetch", { recursive: true });
    this.vfs.writeFileSync(path, content);
    const preview = truncateUtf8(content, INLINE_PREVIEW_BYTES);
    const footer = `\n\n[web_fetch content truncated: showing first ${utf8Length(preview)} of ${byteLength} bytes. Full content saved to: ${path}. Use \`read_file\` with offsets and limits to read it in chunks.]`;
    return utf8Length(preview + footer) <= MAX_MARKDOWN_BYTES
      ? preview + footer
      : `${truncateUtf8(content, Math.max(0, INLINE_PREVIEW_BYTES - 32))}\n\n[web_fetch output truncated]`;
  }
}

export function stripBase64DataUris(content: string): string {
  if (!content.includes("data:")) return content;
  let result = "";
  let lastEnd = 0;
  let searchFrom = 0;
  for (;;) {
    const relative = content.indexOf("data:", searchFrom);
    if (relative < 0) break;
    const start = relative;
    const prior = start > 0 ? content.charCodeAt(start - 1) : -1;
    if ((prior >= 48 && prior <= 57) || (prior >= 65 && prior <= 90) || (prior >= 97 && prior <= 122)) {
      searchFrom = start + 5;
      continue;
    }
    const comma = content.indexOf(",", start);
    if (comma >= 0) {
      const header = content.slice(start + 5, comma);
      if (utf8Length(header) <= 120 && !/\s/u.test(header)) {
        const [rawMime = "", ...parts] = header.split(";");
        if (parts.some((part) => part.toLowerCase() === "base64")) {
          let end = comma + 1;
          while (end < content.length && /[A-Za-z0-9+/=]/u.test(content[end]!)) end += 1;
          if (end - comma - 1 >= 4) {
            result += content.slice(lastEnd, start) + `[base64 ${rawMime || "unknown"} data removed]`;
            lastEnd = end;
            searchFrom = end;
            continue;
          }
        }
      }
    }
    searchFrom = start + 5;
  }
  return lastEnd === 0 ? content : result + content.slice(lastEnd);
}

function isBinaryMime(mime: string): boolean {
  if (mime.startsWith("text/")) return false;
  if (BINARY_MIME_TYPES.has(mime)) return true;
  return ![
    "application/json", "application/xml", "application/javascript", "application/ecmascript",
    "application/x-javascript", "application/xhtml+xml", "application/rss+xml", "application/atom+xml",
    "application/soap+xml", "application/xslt+xml", "application/mathml+xml", "application/svg+xml",
    "application/x-www-form-urlencoded", "application/graphql", "application/ld+json",
    "application/schema+json", "application/vnd.api+json", "application/x-yaml", "application/yaml",
    "application/toml",
  ].includes(mime) && !mime.endsWith("+json") && !mime.endsWith("+xml");
}

function mediaExtension(mime: string): string {
  return ({
    "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
    "image/bmp": "bmp", "image/tiff": "tiff", "video/mp4": "mp4", "video/webm": "webm",
    "video/quicktime": "mov", "video/x-msvideo": "avi",
  } as Record<string, string>)[mime] ?? "bin";
}

function validateMediaMagicBytes(mime: string, bytes: Uint8Array): void {
  const matches = mime === "image/png" ? startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])
    : mime === "image/jpeg" ? startsWith(bytes, [0xff, 0xd8, 0xff])
      : mime === "image/gif" ? new TextDecoder().decode(bytes.slice(0, 4)) === "GIF8"
        : mime === "image/webp" ? new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
          : mime === "video/mp4" ? new TextDecoder().decode(bytes.slice(4, 8)) === "ftyp"
            : mime === "video/webm" ? startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])
              : true;
  if (!matches) throw new Error(`Response bytes do not match content type ${mime}`);
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function payloadExtension(contentType: string, content: string): string {
  const mime = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (mime === "markdown" || mime === "text/markdown") return "md";
  if (["application/x-ndjson", "application/ndjson", "application/jsonl", "text/jsonl", "text/x-jsonl"].includes(mime)) return "jsonl";
  if (mime === "application/json" || mime === "text/json" || mime.endsWith("+json") || isJson(content)) return "json";
  return "txt";
}

function isJson(content: string): boolean {
  try { JSON.parse(content.trim()); return true; } catch { return false; }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maxBytes) return value;
  return new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/\ufffd$/u, "");
}
