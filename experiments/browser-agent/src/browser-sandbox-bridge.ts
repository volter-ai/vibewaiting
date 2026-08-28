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
    body?: ArrayBuffer;
    streaming?: boolean;
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

export class BrowserSandboxBridge {
  readonly ready: Promise<void>;
  readonly initialPreviewReady: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private resolveInitialPreview!: () => void;
  private rejectInitialPreview!: (error: Error) => void;

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
      this.options.onRendered?.(String(revision || "unknown"));
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
    if (!message || typeof message !== "object") throw new Error("Malformed sandbox service-worker message.");
    const request = message as SandboxRequest;
    if (request.type !== "request" || !Number.isSafeInteger(request.id) || request.data?.port !== this.options.port) {
      throw new Error("Rejected an invalid virtual-server request.");
    }
    const { method, url, headers, body, streaming } = request.data;
    if (!method || !url || !url.startsWith("/") || !headers) throw new Error("Rejected an incomplete virtual-server request.");
    if (body && body.byteLength > 16 * 1024 * 1024) throw new Error("Virtual-server request body exceeds 16 MiB.");

    const response = await this.options.bridge.handleRequest(this.options.port, method, url, headers, body);
    const responseBody = response.body instanceof Uint8Array ? response.body : new Uint8Array();
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
  }
}
