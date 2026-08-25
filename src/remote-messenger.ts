import { randomInt, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocket as WebSocketClient, WebSocketServer, type WebSocket } from "ws";
import { type PairingGrant, SingleUsePairingGrants } from "./pairing-grants.js";
import type { RemoteDeviceSnapshot } from "./remote-devices.js";
import { RemoteSessionTokens } from "./remote-sessions.js";

const MAX_LOGIN_BYTES = 2_048;
const MAX_SOCKET_MESSAGE_BYTES = 1_048_576;
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1_000;
const LOGIN_WINDOW_MS = 60_000;
const MAX_LOGIN_ATTEMPTS = 8;
const SESSION_COOKIE = "vw_remote_session";

type RemoteIntent = { id: string; payload: unknown };

export interface RemoteMessengerSnapshot {
  localOrigin: string;
  passcode: string;
}

/**
 * Loopback-only standalone messenger host. Tunnel selection deliberately lives outside this class:
 * this endpoint owns application authentication and websocket semantics, while Supercode's
 * remote-access package owns how the origin becomes reachable.
 */
export class RemoteMessengerServer {
  private readonly passcode = String(randomInt(0, 1_000_000)).padStart(6, "0");
  private readonly sockets = new Set<WebSocket>();
  private readonly messengerSockets = new Set<WebSocket>();
  private readonly attempts = new Map<string, number[]>();
  private readonly pairingGrants = new SingleUsePairingGrants();
  private readonly remoteSessions = new RemoteSessionTokens({
    ttlMs: SESSION_MAX_AGE_MS,
  });
  private readonly sessionSockets = new Map<string, Set<WebSocket>>();
  private readonly terminalOrigins = new Map<string, string>();
  private readonly webSockets = new WebSocketServer({ noServer: true });
  private server: ReturnType<typeof createServer> | null = null;
  private sessionExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private deviceSnapshotHandler: ((snapshot: RemoteDeviceSnapshot) => void) | null = null;
  private intentHandler: ((intent: RemoteIntent) => void) | null = null;
  private lastPatch: unknown;
  private assets: {
    css: Buffer;
    html: Buffer;
    icon192: Buffer;
    icon512: Buffer;
    javascript: Buffer;
    manifest: Buffer;
    serviceWorker: Buffer;
  } | null = null;

  constructor(private readonly terminalProxyOrigin?: string) {}

  async start(): Promise<RemoteMessengerSnapshot> {
    if (this.server) return this.snapshot();
    const assetRoot = new URL("./mobile/", import.meta.url);
    const [html, javascript, css, manifest, serviceWorker, icon192, icon512] = await Promise.all([
      readFile(fileURLToPath(new URL("index.html", assetRoot))),
      readFile(fileURLToPath(new URL("app.js", assetRoot))),
      readFile(fileURLToPath(new URL("app.css", assetRoot))),
      readFile(fileURLToPath(new URL("manifest.webmanifest", assetRoot))),
      readFile(fileURLToPath(new URL("service-worker.js", assetRoot))),
      readFile(fileURLToPath(new URL("icon-192.png", assetRoot))),
      readFile(fileURLToPath(new URL("icon-512.png", assetRoot))),
    ]);
    this.assets = { css, html, icon192, icon512, javascript, manifest, serviceWorker };
    const server = createServer((request, response) => void this.handleRequest(request, response));
    server.on("upgrade", (request, socket, head) => {
      const sessionId = this.authorizedSessionId(request);
      if (!sessionId || !this.sameOrigin(request) || new URL(request.url ?? "/", "http://localhost").pathname !== "/ws") {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        this.trackSessionSocket(webSocket, sessionId);
        const terminalId = new URL(request.url ?? "/", "http://localhost").searchParams.get("terminalId");
        if (terminalId) this.attachTerminalSocket(webSocket, request, terminalId);
        else this.attachSocket(webSocket);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    return this.snapshot();
  }

  snapshot(): RemoteMessengerSnapshot {
    const address = this.server?.address();
    if (!address || typeof address === "string") throw new Error("Remote messenger is not running");
    return { localOrigin: `http://127.0.0.1:${address.port}`, passcode: this.passcode };
  }

  createPairingGrant(): PairingGrant {
    if (!this.server) throw new Error("Remote messenger is not running");
    return this.pairingGrants.issue();
  }

  deviceSnapshot(): RemoteDeviceSnapshot {
    return {
      authorizedDevices: this.remoteSessions.size,
      connectedDevices: this.sessionSockets.size,
    };
  }

  setDeviceSnapshotHandler(
    handler: ((snapshot: RemoteDeviceSnapshot) => void) | null,
  ): void {
    this.deviceSnapshotHandler = handler;
    if (handler) handler(this.deviceSnapshot());
  }

  revokeRemoteSessions(): void {
    this.pairingGrants.clear();
    const revokedIds = this.remoteSessions.revokeAll();
    this.closeSessionSockets(revokedIds, "Remote access was disconnected");
    this.scheduleSessionExpiry();
    this.publishDeviceSnapshot();
  }

  setIntentHandler(handler: ((intent: RemoteIntent) => void) | null): void {
    this.intentHandler = handler;
  }

  push(patch: unknown): void {
    const attachment = remoteTerminalAttachment(patch);
    if (attachment) {
      this.terminalOrigins.set(attachment.id, attachment.baseUrl);
      while (this.terminalOrigins.size > 32) this.terminalOrigins.delete(this.terminalOrigins.keys().next().value!);
    }
    this.lastPatch = patch;
    this.broadcast({ type: "patch", patch });
  }

  async stop(): Promise<void> {
    this.intentHandler = null;
    this.deviceSnapshotHandler = null;
    if (this.sessionExpiryTimer) clearTimeout(this.sessionExpiryTimer);
    this.sessionExpiryTimer = null;
    for (const socket of this.sockets) socket.close(1001, "Vibewaiting stopped");
    this.sockets.clear();
    this.messengerSockets.clear();
    this.sessionSockets.clear();
    this.remoteSessions.revokeAll();
    this.pairingGrants.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.webSockets.close();
  }

  private attachSocket(socket: WebSocket): void {
    this.sockets.add(socket);
    this.messengerSockets.add(socket);
    if (this.lastPatch !== undefined) this.send(socket, { type: "patch", patch: this.lastPatch });
    socket.on("message", (data, binary) => {
      const serialized = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      if (binary || serialized.byteLength > MAX_SOCKET_MESSAGE_BYTES) {
        socket.close(1009, "Message too large");
        return;
      }
      try {
        const value = JSON.parse(serialized.toString("utf8")) as unknown;
        if (!isRemoteIntent(value)) return;
        this.intentHandler?.(value);
      } catch {
        socket.close(1007, "Invalid message");
      }
    });
    const forget = (): void => {
      this.sockets.delete(socket);
      this.messengerSockets.delete(socket);
    };
    socket.once("close", forget);
    socket.once("error", forget);
  }

  private trackSessionSocket(socket: WebSocket, sessionId: string): void {
    const priorCount = this.sessionSockets.size;
    const session = this.sessionSockets.get(sessionId) ?? new Set<WebSocket>();
    session.add(socket);
    this.sessionSockets.set(sessionId, session);
    if (this.sessionSockets.size !== priorCount) this.publishDeviceSnapshot();
    let forgotten = false;
    const forget = (): void => {
      if (forgotten) return;
      forgotten = true;
      const connectedBefore = this.sessionSockets.size;
      const active = this.sessionSockets.get(sessionId);
      active?.delete(socket);
      if (active?.size === 0) this.sessionSockets.delete(sessionId);
      if (this.sessionSockets.size !== connectedBefore)
        this.publishDeviceSnapshot();
    };
    socket.once("close", forget);
    socket.once("error", forget);
  }

  private closeSessionSockets(sessionIds: string[], reason: string): void {
    for (const sessionId of sessionIds) {
      const sockets = this.sessionSockets.get(sessionId);
      this.sessionSockets.delete(sessionId);
      for (const socket of sockets ?? [])
        socket.close(4001, reason.slice(0, 120));
    }
  }

  private issueRemoteSession(): string {
    const session = this.remoteSessions.issue();
    this.closeSessionSockets(session.revokedIds, "Remote access expired");
    this.scheduleSessionExpiry();
    this.publishDeviceSnapshot();
    return session.token;
  }

  private authorizedSessionId(request: IncomingMessage): string | null {
    const cookies = parseCookies(request.headers.cookie);
    const authentication = this.remoteSessions.authenticate(
      cookies.get(SESSION_COOKIE) ?? "",
    );
    if (authentication.revokedIds.length) {
      this.closeSessionSockets(
        authentication.revokedIds,
        "Remote access expired",
      );
      this.scheduleSessionExpiry();
      this.publishDeviceSnapshot();
    }
    return authentication.id;
  }

  private scheduleSessionExpiry(): void {
    if (this.sessionExpiryTimer) clearTimeout(this.sessionExpiryTimer);
    this.sessionExpiryTimer = null;
    const expiresAt = this.remoteSessions.nextExpiry();
    if (expiresAt === null) return;
    this.sessionExpiryTimer = setTimeout(() => {
      this.sessionExpiryTimer = null;
      const revokedIds = this.remoteSessions.expire();
      this.closeSessionSockets(revokedIds, "Remote access expired");
      this.scheduleSessionExpiry();
      if (revokedIds.length) this.publishDeviceSnapshot();
    }, Math.max(0, expiresAt - Date.now()));
    this.sessionExpiryTimer.unref();
  }

  private publishDeviceSnapshot(): void {
    this.deviceSnapshotHandler?.(this.deviceSnapshot());
  }

  private attachTerminalSocket(socket: WebSocket, request: IncomingMessage, terminalId: string): void {
    const baseUrl = this.terminalOrigins.get(terminalId);
    if (!baseUrl || !this.terminalProxyOrigin) {
      socket.close(1008, "Terminal attachment is unavailable");
      return;
    }
    const target = new URL("/ws", baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:"));
    target.searchParams.set("terminalId", terminalId);
    const requested = new URL(request.url ?? "/", "http://localhost");
    for (const name of ["cols", "rows"] as const) {
      const value = requested.searchParams.get(name);
      if (value && /^\d{1,4}$/.test(value)) target.searchParams.set(name, value);
    }
    const upstream = new WebSocketClient(target, { origin: this.terminalProxyOrigin });
    const pending: Array<{ data: Buffer; binary: boolean }> = [];
    this.sockets.add(socket);
    socket.on("message", (data, binary) => {
      const serialized = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (serialized.byteLength > MAX_SOCKET_MESSAGE_BYTES) {
        socket.close(1009, "Message too large");
        return;
      }
      if (upstream.readyState === upstream.OPEN) upstream.send(serialized, { binary });
      else if (upstream.readyState === upstream.CONNECTING && pending.length < 32) pending.push({ data: serialized, binary });
    });
    upstream.on("open", () => {
      for (const message of pending.splice(0)) upstream.send(message.data, { binary: message.binary });
    });
    upstream.on("message", (data, binary) => {
      if (socket.readyState !== socket.OPEN) return;
      const serialized = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      socket.send(serialized, { binary });
    });
    upstream.on("error", () => socket.close(1011, "Terminal bridge failed"));
    upstream.on("close", (code, reason) => {
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING)
        socket.close(code || 1011, reason.toString().slice(0, 120));
    });
    const closeUpstream = (): void => {
      if (upstream.readyState === upstream.CONNECTING || upstream.readyState === upstream.OPEN)
        upstream.terminate();
    };
    socket.once("close", () => {
      this.sockets.delete(socket);
      closeUpstream();
    });
    socket.once("error", () => {
      this.sockets.delete(socket);
      closeUpstream();
    });
  }

  private broadcast(value: unknown): void {
    for (const socket of this.messengerSockets) this.send(socket, value);
  }

  private send(socket: WebSocket, value: unknown): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(value));
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      response.writeHead(204, securityHeaders());
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/login") {
      await this.login(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/pair") {
      if (!this.sameOrigin(request)) {
        respond(
          response,
          403,
          "text/plain; charset=utf-8",
          Buffer.from("Pairing must be completed from this Vibewaiting page."),
          { ...securityHeaders(), "cache-control": "no-store" },
        );
        return;
      }
      await this.pair(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/pair.js") {
      respond(
        response,
        200,
        "text/javascript; charset=utf-8",
        Buffer.from(PAIRING_JAVASCRIPT),
        securityHeaders(),
      );
      return;
    }
    if (this.assets && request.method === "GET" && url.pathname === "/manifest.webmanifest") {
      respond(
        response,
        200,
        "application/manifest+json; charset=utf-8",
        this.assets.manifest,
        securityHeaders(),
      );
      return;
    }
    if (this.assets && request.method === "GET" && url.pathname === "/service-worker.js") {
      respond(
        response,
        200,
        "text/javascript; charset=utf-8",
        this.assets.serviceWorker,
        {
          ...securityHeaders(),
          "cache-control": "no-store",
          "service-worker-allowed": "/",
        },
      );
      return;
    }
    if (
      this.assets &&
      request.method === "GET" &&
      (url.pathname === "/icon-192.png" || url.pathname === "/icon-512.png")
    ) {
      respond(
        response,
        200,
        "image/png",
        url.pathname === "/icon-192.png" ? this.assets.icon192 : this.assets.icon512,
        securityHeaders(),
      );
      return;
    }
    if (!this.authorized(request)) {
      respond(response, 200, "text/html; charset=utf-8", Buffer.from(LOGIN_HTML), {
        ...securityHeaders(),
        "cache-control": "no-store",
      });
      return;
    }
    if (!this.assets) {
      respond(response, 503, "text/plain; charset=utf-8", Buffer.from("Vibewaiting is starting."), securityHeaders());
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      respond(response, 200, "text/html; charset=utf-8", this.assets.html, securityHeaders());
      return;
    }
    if (url.pathname === "/app.js") {
      respond(response, 200, "text/javascript; charset=utf-8", this.assets.javascript, securityHeaders());
      return;
    }
    if (url.pathname === "/app.css") {
      respond(response, 200, "text/css; charset=utf-8", this.assets.css, securityHeaders());
      return;
    }
    respond(response, 404, "text/plain; charset=utf-8", Buffer.from("Not found"), securityHeaders());
  }

  private async login(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const key = request.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const recent = (this.attempts.get(key) ?? []).filter((timestamp) => now - timestamp < LOGIN_WINDOW_MS);
    if (recent.length >= MAX_LOGIN_ATTEMPTS) {
      respond(response, 429, "text/plain; charset=utf-8", Buffer.from("Too many attempts. Try again in a minute."), securityHeaders());
      return;
    }
    recent.push(now);
    this.attempts.set(key, recent);
    const body = await readBody(request, MAX_LOGIN_BYTES).catch(() => null);
    const submitted = body ? new URLSearchParams(body).get("code")?.replace(/\s/g, "") ?? "" : "";
    if (!safeEqual(submitted, this.passcode)) {
      response.writeHead(303, { ...securityHeaders(), location: "/?invalid=1" });
      response.end();
      return;
    }
    this.attempts.delete(key);
    response.writeHead(303, {
      ...this.sessionHeaders(request, this.issueRemoteSession()),
      location: "/",
    });
    response.end();
  }

  private async pair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request, MAX_LOGIN_BYTES).catch(() => null);
    const grant = body ? new URLSearchParams(body).get("grant") ?? "" : "";
    if (!this.pairingGrants.consume(grant)) {
      respond(
        response,
        401,
        "text/plain; charset=utf-8",
        Buffer.from("This pairing link is invalid, expired, or already used."),
        { ...securityHeaders(), "cache-control": "no-store" },
      );
      return;
    }
    response.writeHead(
      204,
      this.sessionHeaders(request, this.issueRemoteSession()),
    );
    response.end();
  }

  private sessionHeaders(
    request: IncomingMessage,
    sessionToken: string,
  ): Record<string, string> {
    const secure =
      request.headers["x-forwarded-proto"] === "https" ||
      (request.socket as typeof request.socket & { encrypted?: boolean }).encrypted === true;
    return {
      ...securityHeaders(),
      "cache-control": "no-store",
      "set-cookie": `${SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`,
    };
  }

  private authorized(request: IncomingMessage): boolean {
    return this.authorizedSessionId(request) !== null;
  }

  private sameOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "").split(",", 1)[0]?.trim();
    if (!origin || !host) return false;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
}

function isRemoteIntent(value: unknown): value is RemoteIntent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && candidate.id.length <= 200 && "payload" in candidate;
}

function remoteTerminalAttachment(value: unknown): { baseUrl: string; id: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const terminalHost = (value as Record<string, unknown>).terminalHost;
  if (typeof terminalHost !== "object" || terminalHost === null || Array.isArray(terminalHost)) return null;
  const attachment = (terminalHost as Record<string, unknown>).attachment;
  if (typeof attachment !== "object" || attachment === null || Array.isArray(attachment)) return null;
  const { baseUrl, id } = attachment as Record<string, unknown>;
  if (typeof id !== "string" || typeof baseUrl !== "string") return null;
  try {
    const origin = new URL(baseUrl);
    if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname)) return null;
    return { baseUrl: origin.origin, id };
  } catch {
    return null;
  }
}

function parseCookies(header: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const pair of header?.split(";") ?? []) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    result.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
  return result;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function securityHeaders(): Record<string, string> {
  return {
    "content-security-policy": "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "cross-origin-opener-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function respond(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...headers,
    "cache-control": headers["cache-control"] ?? "no-cache",
    "content-length": String(body.byteLength),
    "content-type": contentType,
  });
  response.end(body);
}

const LOGIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark light"><title>Vibewaiting</title><style>
:root{color-scheme:dark light;font:15px/1.45 system-ui,sans-serif;background:#111318;color:#f4f5f7}body{min-height:100dvh;margin:0;display:grid;place-items:center}main{box-sizing:border-box;width:min(92vw,360px);padding:24px}h1{margin:0 0 5px;font-size:24px}p{margin:0 0 20px;color:#a9adba}form{display:grid;gap:12px}form[hidden]{display:none}label{display:grid;gap:7px;font-weight:650}input,button{box-sizing:border-box;width:100%;min-height:46px;border:1px solid #3a3e49;border-radius:10px;background:#1a1d24;color:inherit;font:inherit;padding:10px 12px}input{font:650 20px/1 ui-monospace,monospace;letter-spacing:.15em;text-align:center}button{cursor:pointer;background:#f0f1f3;color:#16171a;border-color:#f0f1f3;font-weight:700}small{color:#7f8490}</style><script src="/pair.js" defer></script></head><body><main><h1>Vibewaiting</h1><p id="pairing-status">Enter the access code shown on your computer.</p><form method="post" action="/login"><label>Access code<input name="code" inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" autocomplete="one-time-code" autofocus required></label><button type="submit">Open chats</button></form><small>This code expires when the local bridge stops.</small></main></body></html>`;

const PAIRING_JAVASCRIPT = `(() => {
  const parameters = new URLSearchParams(location.hash.slice(1));
  const grant = parameters.get("pair");
  if (!grant) return;
  history.replaceState(null, "", location.pathname + location.search);
  const form = document.querySelector("form");
  const status = document.querySelector("#pairing-status");
  if (form) form.hidden = true;
  if (status) status.textContent = "Pairing this device…";
  fetch("/pair", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ grant }),
  }).then((response) => {
    if (!response.ok) throw new Error("pairing rejected");
    location.replace("/");
  }).catch(() => {
    if (form) form.hidden = false;
    if (status) status.textContent = "This QR code expired or was already used. Enter the access code instead.";
  });
})();`;
