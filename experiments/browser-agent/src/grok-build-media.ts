import type { VirtualFS } from "almostnode";

const IMAGE_ENDPOINT = "/api/grok/media/image";
const VIDEO_START_ENDPOINT = "/api/grok/media/video/start";
const VIDEO_POLL_ENDPOINT = "/api/grok/media/video/poll";
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const VIDEO_POLL_INTERVAL_MS = 5_000;
const VIDEO_TIMEOUT_MS = 300_000;
const IMAGE_ASPECT_RATIOS = new Set([
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2",
  "19.5:9", "9:19.5", "20:9", "9:20", "auto",
]);
const VIDEO_ASPECT_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);
const VIDEO_RESOLUTIONS = new Set(["480p", "720p"]);

type JsonObject = Record<string, unknown>;

interface ImageRelayResponse {
  b64Json?: unknown;
  tierRestricted?: unknown;
  message?: unknown;
  error?: { message?: unknown };
}

interface VideoStartResponse {
  requestToken?: unknown;
  tierRestricted?: unknown;
  message?: unknown;
  error?: { message?: unknown };
}

interface VideoPollResponse {
  status?: unknown;
  error?: { message?: unknown };
}

/** Native Imagine tools with browser VFS persistence and a stateless credential relay. */
export class GrokBuildMediaClient {
  private nextImage = 1;
  private nextVideo = 1;

  constructor(
    private readonly vfs: VirtualFS,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sessionId?: () => string | undefined,
    private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void> = abortableSleep,
  ) {}

  async generateImage(input: JsonObject, signal: AbortSignal): Promise<string> {
    const prompt = requiredString(input.prompt, "prompt");
    const aspectRatio = optionalString(input.aspect_ratio, "auto");
    validateOneOf("aspect_ratio", aspectRatio, IMAGE_ASPECT_RATIOS);
    const result = await this.requestImage({ kind: "generate", prompt, aspectRatio }, signal);
    return typeof result === "string" ? result : this.saveImage(result);
  }

  async editImage(input: JsonObject, signal: AbortSignal): Promise<string> {
    const prompt = requiredString(input.prompt, "prompt");
    const references = stringArray(input.image, "image");
    if (references.length === 0) {
      throw new Error("image_edit requires at least one reference image. Use image_gen for text-only generation.");
    }
    const aspectRatio = optionalString(input.aspect_ratio, "auto");
    validateOneOf("aspect_ratio", aspectRatio, IMAGE_ASPECT_RATIOS);
    const images = references.map((reference) => this.resolveImageReference(reference));
    const result = await this.requestImage({ kind: "edit", prompt, aspectRatio, images }, signal);
    return typeof result === "string" ? result : this.saveImage(result);
  }

  async imageToVideo(input: JsonObject, signal: AbortSignal): Promise<string> {
    const duration = optionalInteger(input.duration, 6);
    if (duration !== 6 && duration !== 10) {
      throw new Error(`\`duration\` must be either 6 or 10 seconds. Got ${duration}.`);
    }
    const resolution = optionalString(input.resolution_name, "480p");
    validateOneOf("resolution_name", resolution, VIDEO_RESOLUTIONS);
    return this.generateVideo({
      kind: "image-to-video",
      prompt: optionalString(input.prompt, ""),
      duration,
      resolution,
      image: this.resolveImageReference(requiredString(input.image, "image")),
    }, signal);
  }

  async referenceToVideo(input: JsonObject, signal: AbortSignal): Promise<string> {
    const prompt = requiredString(input.prompt, "prompt");
    if (!prompt.trim()) throw new Error("`prompt` must not be empty.");
    const imageInputs = optionalStringArray(input.images, "images");
    const voices = optionalStringArray(input.voices, "voices");
    if (imageInputs.length === 0 && voices.length === 0) {
      throw new Error("Provide at least one reference: `images` (up to 7) and/or `voices` (up to 3).");
    }
    if (imageInputs.length > 7) throw new Error("`images` must contain at most 7 image references.");
    if (voices.length > 3) throw new Error("`voices` must contain at most 3 preset voices.");
    if (voices.some((voice) => !voice.trim())) {
      throw new Error("`voices` entries must be non-empty voice identifiers (e.g. \"ara\").");
    }
    const duration = optionalInteger(input.duration, 6);
    if (duration < 1 || duration > 15) {
      throw new Error(`\`duration\` must be between 1 and 15 seconds. Got ${duration}.`);
    }
    const aspectRatio = requiredString(input.aspect_ratio, "aspect_ratio");
    validateOneOf("aspect_ratio", aspectRatio, VIDEO_ASPECT_RATIOS);
    const resolution = optionalString(input.resolution_name, "480p");
    validateOneOf("resolution_name", resolution, VIDEO_RESOLUTIONS);
    return this.generateVideo({
      kind: "reference-to-video",
      prompt,
      duration,
      aspectRatio,
      resolution,
      images: imageInputs.map((reference) => this.resolveImageReference(reference)),
      voices,
    }, signal);
  }

  private async requestImage(body: JsonObject, signal: AbortSignal): Promise<Uint8Array | string> {
    const response = await this.fetchImpl(IMAGE_ENDPOINT, this.jsonRequest(body, signal));
    const payload = await response.json().catch(() => ({})) as ImageRelayResponse;
    if (!response.ok) throw new Error(relayError(payload, `Image generation failed with HTTP ${response.status}`));
    if (payload.tierRestricted === true && typeof payload.message === "string") return payload.message;
    if (typeof payload.b64Json !== "string" || payload.b64Json.length === 0) {
      throw new Error("Image generation returned no image data.");
    }
    const bytes = decodeBase64(payload.b64Json);
    validateJpeg(bytes);
    return bytes;
  }

  private async generateVideo(body: JsonObject, signal: AbortSignal): Promise<string> {
    const start = await this.fetchImpl(VIDEO_START_ENDPOINT, this.jsonRequest(body, signal));
    const started = await start.json().catch(() => ({})) as VideoStartResponse;
    if (!start.ok) throw new Error(relayError(started, `Video generation failed with HTTP ${start.status}`));
    if (started.tierRestricted === true && typeof started.message === "string") return started.message;
    if (typeof started.requestToken !== "string" || started.requestToken.length === 0) {
      throw new Error("No request_id received from the video generation API.");
    }

    const startedAt = Date.now();
    for (;;) {
      await this.sleep(VIDEO_POLL_INTERVAL_MS, signal);
      if (Date.now() - startedAt >= VIDEO_TIMEOUT_MS) {
        throw new Error("Video generation did not complete within 300s.");
      }
      const response = await this.fetchImpl(VIDEO_POLL_ENDPOINT, this.jsonRequest({ requestToken: started.requestToken }, signal));
      const contentType = response.headers.get("Content-Type") ?? "";
      if (response.ok && contentType.startsWith("video/")) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        validateMp4(bytes);
        return this.saveVideo(bytes);
      }
      const payload = await response.json().catch(() => ({})) as VideoPollResponse;
      if (!response.ok) throw new Error(relayError(payload, `Video poll failed with HTTP ${response.status}`));
      if (payload.status === "pending") continue;
      throw new Error("Video generation returned an invalid poll response.");
    }
  }

  private jsonRequest(body: JsonObject, signal: AbortSignal): RequestInit {
    const headers = new Headers({ "Content-Type": "application/json" });
    const sessionId = this.sessionId?.();
    if (sessionId) headers.set("x-browser-agent-session", sessionId);
    return {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify(body),
      signal,
    };
  }

  private resolveImageReference(raw: string): string {
    const reference = raw.trim();
    if (!reference) throw new Error("image reference must not be empty");
    if (/^\[Image #\d+\]$/u.test(reference)) {
      throw new Error(`image attachment ${reference} is not available in this browser session`);
    }
    if (reference.startsWith("https://")) return reference;
    if (reference.startsWith("data:image/")) {
      validateDataImage(reference);
      return reference;
    }
    if (!reference.startsWith("/")) {
      throw new Error("image reference must be an absolute browser filesystem path, HTTPS URL, or base64 image data URL");
    }
    let bytes: Uint8Array;
    try {
      bytes = this.vfs.readFileSync(reference);
    } catch (cause) {
      throw new Error(`image reference not readable: ${reference} (${cause instanceof Error ? cause.message : String(cause)})`);
    }
    if (bytes.byteLength === 0) throw new Error("image reference contained no data");
    if (bytes.byteLength > MAX_REFERENCE_BYTES) throw new Error(`image reference exceeds ${MAX_REFERENCE_BYTES} bytes`);
    const mime = imageMime(bytes);
    return `data:${mime};base64,${encodeBase64(bytes)}`;
  }

  private saveImage(bytes: Uint8Array): string {
    const path = `/.grok/images/${this.nextImage++}.jpg`;
    this.vfs.mkdirSync("/.grok/images", { recursive: true });
    this.vfs.writeFileSync(path, bytes);
    return path;
  }

  private saveVideo(bytes: Uint8Array): string {
    const path = `/.grok/videos/${this.nextVideo++}.mp4`;
    this.vfs.mkdirSync("/.grok/videos", { recursive: true });
    this.vfs.writeFileSync(path, bytes);
    return path;
  }
}

function relayError(payload: { error?: { message?: unknown } }, fallback: string): string {
  return typeof payload.error?.message === "string" ? payload.error.message : fallback;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function optionalString(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error("expected a string");
  return value;
}

function optionalInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === "string" && /^\d+$/u.test(value.trim()) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("duration must be a whole number of seconds");
  }
  return parsed;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value as string[];
}

function optionalStringArray(value: unknown, field: string): string[] {
  return value === undefined || value === null ? [] : stringArray(value, field);
}

function validateOneOf(field: string, value: string, allowed: ReadonlySet<string>): void {
  if (!allowed.has(value)) throw new Error(`\`${field}\` must be one of: ${[...allowed].join(", ")}. Got ${value}.`);
}

function validateDataImage(value: string): void {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/iu.exec(value);
  if (!match) throw new Error("image references only support base64 data URLs");
  const bytes = decodeBase64(match[2]!);
  if (bytes.byteLength === 0) throw new Error("image reference contained no data");
  if (bytes.byteLength > MAX_REFERENCE_BYTES) throw new Error(`image reference exceeds ${MAX_REFERENCE_BYTES} bytes`);
  const detected = imageMime(bytes);
  if (match[1]!.toLowerCase() !== detected) throw new Error(`image data does not match declared MIME type ${match[1]}`);
}

function imageMime(bytes: Uint8Array): string {
  if (isJpeg(bytes)) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (new TextDecoder().decode(bytes.slice(0, 4)) === "GIF8") return "image/gif";
  if (new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return "image/webp";
  throw new Error("invalid image reference: unsupported or malformed image bytes");
}

function validateJpeg(bytes: Uint8Array): void {
  if (!isJpeg(bytes)) throw new Error("Image generation returned invalid JPEG data.");
}

function isJpeg(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0xff, 0xd8, 0xff]);
}

function validateMp4(bytes: Uint8Array): void {
  if (bytes.byteLength < 12 || new TextDecoder().decode(bytes.slice(4, 8)) !== "ftyp") {
    throw new Error("Video generation returned invalid MP4 data.");
  }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("Failed to decode base64 image data");
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
