import {
  SANDBOX_CHANNEL,
  isSandboxEnvelope,
  type SandboxEnvelope,
} from "./sandbox-protocol.js";

interface VirtualServerResponse {
  statusCode: number;
  statusMessage?: string;
  headers: Record<string, string | string[]>;
  body?: Uint8Array;
}

interface VirtualServerBridge {
  handleRequest(
    port: number,
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: ArrayBuffer,
  ): Promise<VirtualServerResponse>;
}

export interface BrowserSandboxBridgeOptions {
  preview: HTMLIFrameElement;
  origin: string;
  nonce: string;
  port: number;
  bridge: VirtualServerBridge;
  htmlModuleRewrites?: Readonly<Record<string, string>>;
  onPreviewLoad?: () => void;
  onRendered?: (revision: string) => void;
  onError?: (error: Error) => void;
}

interface SandboxRequest {
  type?: string;
  id?: number;
  data?: {
    port?: number;
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: ArrayBuffer | null;
    streaming?: boolean;
  };
}

const MAX_ACTIVE_REQUESTS = 32;
const MAX_REQUEST_URL_CHARS = 16_384;
const MAX_REQUEST_HEADERS = 128;
const MAX_REQUEST_HEADER_CHARS = 65_536;
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 32 * 1024 * 1024;
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

interface ValidatedSandboxRequest {
  id: number;
  data: {
    port: number;
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: ArrayBuffer;
    streaming: boolean;
  };
}

export function validateSandboxRequest(message: unknown, port: number): ValidatedSandboxRequest {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("Malformed sandbox service-worker message.");
  }
  const request = message as SandboxRequest;
  const data = request.data;
  if (request.type !== "request" || !Number.isSafeInteger(request.id) || !data || data.port !== port) {
    throw new Error("Rejected an invalid virtual-server request.");
  }
  if (!data.method || !HTTP_METHODS.has(data.method) || !data.url || data.url.length > MAX_REQUEST_URL_CHARS
    || !data.url.startsWith("/") || data.url.startsWith("//") || /[\\\u0000-\u001f\u007f]/u.test(data.url)) {
    throw new Error("Rejected an invalid virtual-server request target.");
  }
  const parsed = new URL(data.url, "https://virtual.invalid");
  if (parsed.origin !== "https://virtual.invalid") throw new Error("Rejected a cross-origin virtual-server request.");
  if (!data.headers || typeof data.headers !== "object" || Array.isArray(data.headers)) {
    throw new Error("Rejected invalid virtual-server request headers.");
  }
  const headerEntries = Object.entries(data.headers);
  if (headerEntries.length > MAX_REQUEST_HEADERS) throw new Error("Virtual-server request has too many headers.");
  let headerChars = 0;
  for (const [name, value] of headerEntries) {
    if (!HTTP_HEADER_NAME.test(name) || typeof value !== "string" || /[\u0000\r\n]/u.test(value)) {
      throw new Error("Rejected malformed virtual-server request headers.");
    }
    headerChars += name.length + value.length;
  }
  if (headerChars > MAX_REQUEST_HEADER_CHARS) throw new Error("Virtual-server request headers are too large.");
  if (data.body !== undefined && data.body !== null && !(data.body instanceof ArrayBuffer)) {
    throw new Error("Rejected an invalid virtual-server request body.");
  }
  if (data.body && data.body.byteLength > MAX_REQUEST_BODY_BYTES) throw new Error("Virtual-server request body exceeds 16 MiB.");
  if (data.streaming !== undefined && typeof data.streaming !== "boolean") throw new Error("Rejected an invalid virtual-server streaming flag.");
  return {
    id: request.id!,
    data: {
      port: data.port,
      method: data.method,
      url: data.url,
      headers: data.headers,
      ...(data.body ? { body: data.body } : {}),
      streaming: data.streaming === true,
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function responseHeader(headers: Record<string, string | string[]>, name: string): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function rewriteHtmlModules(
  body: Uint8Array,
  headers: Record<string, string | string[]>,
  rewrites: Readonly<Record<string, string>> | undefined,
): Uint8Array {
  if (!rewrites || !responseHeader(headers, "content-type")?.toLowerCase().includes("text/html")) return body;
  let html = new TextDecoder().decode(body);
  for (const [remote, local] of Object.entries(rewrites)) html = html.replaceAll(remote, local);
  return new TextEncoder().encode(html);
}

export class BrowserSandboxBridge {
  readonly ready: Promise<void>;
  readonly initialPreviewReady: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private resolveInitialPreview!: () => void;
  private rejectInitialPreview!: (error: Error) => void;
  private readonly activeRequestIds = new Set<number>();

  constructor(private readonly options: BrowserSandboxBridgeOptions) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.initialPreviewReady = new Promise<void>((resolve, reject) => {
      this.resolveInitialPreview = resolve;
      this.rejectInitialPreview = reject;
    });
    window.addEventListener("message", this.onMessage);
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (event.source !== this.options.preview.contentWindow
      || event.origin !== this.options.origin
      || !isSandboxEnvelope(event.data, this.options.nonce)) return;
    const envelope = event.data;
    if (envelope.type === "request") {
      void this.handleRequest(envelope.payload).catch((error) => {
        const requestId = (envelope.payload as { id?: number } | undefined)?.id;
        this.send({ type: "response", id: requestId, error: error instanceof Error ? error.message : String(error) });
      });
    } else if (envelope.type === "ready") {
      this.resolveReady();
    } else if (envelope.type === "preview-load") {
      this.options.onPreviewLoad?.();
      this.resolveInitialPreview();
    } else if (envelope.type === "rendered") {
      const revision = (envelope.payload as { revision?: string } | undefined)?.revision;
      if (typeof revision === "string" && revision.length > 0 && revision.length <= 128) this.options.onRendered?.(revision);
    } else if (envelope.type === "error") {
      const message = (envelope.payload as { message?: string } | undefined)?.message || "Sandbox bridge failed.";
      const error = new Error(message);
      this.rejectReady(error);
      this.rejectInitialPreview(error);
      this.options.onError?.(error);
    }
  };

  private send(message: unknown): void {
    this.options.preview.contentWindow?.postMessage({
      channel: SANDBOX_CHANNEL,
      nonce: this.options.nonce,
      type: "response",
      payload: message,
    } satisfies SandboxEnvelope, this.options.origin);
  }

  private async handleRequest(message: unknown): Promise<void> {
    const request = validateSandboxRequest(message, this.options.port);
    if (this.activeRequestIds.size >= MAX_ACTIVE_REQUESTS) throw new Error("Virtual-server request concurrency exceeded.");
    if (this.activeRequestIds.has(request.id)) throw new Error("Duplicate virtual-server request identifier.");
    this.activeRequestIds.add(request.id);
    try {
      const { method, url, headers, body, streaming } = request.data;
      const response = await this.options.bridge.handleRequest(this.options.port, method, url, headers, body);
      const rawBody = response.body instanceof Uint8Array ? response.body : new Uint8Array();
      if (rawBody.byteLength > MAX_RESPONSE_BODY_BYTES) throw new Error("Virtual-server response body exceeds 32 MiB.");
      const responseBody = rewriteHtmlModules(rawBody, response.headers, this.options.htmlModuleRewrites);
      if (streaming) {
        this.send({
          type: "stream-start",
          id: request.id,
          data: { statusCode: response.statusCode, statusMessage: response.statusMessage, headers: response.headers },
        });
        if (responseBody.length > 0) {
          this.send({ type: "stream-chunk", id: request.id, data: { chunkBase64: bytesToBase64(responseBody) } });
        }
        this.send({ type: "stream-end", id: request.id });
        return;
      }

      this.send({
        type: "response",
        id: request.id,
        data: {
          statusCode: response.statusCode,
          statusMessage: response.statusMessage,
          headers: response.headers,
          bodyBase64: bytesToBase64(responseBody),
        },
      });
    } finally {
      this.activeRequestIds.delete(request.id);
    }
  }
}
