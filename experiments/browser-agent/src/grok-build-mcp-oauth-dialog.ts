import type {
  McpOAuthAuthorizationResult,
  McpOAuthCredentialStore,
  GrokBuildMcpOAuthOptions,
} from "./grok-build-mcp-oauth.js";
import {
  GrokBuildIndexedDbMcpCredentialStore,
} from "./grok-build-mcp-credential-store.js";

export { GrokBuildMemoryMcpCredentialStore } from "./grok-build-mcp-credential-store.js";

const CALLBACK_PATH = "/mcp-oauth-callback.html";
const NATIVE_BROWSER_AUTH_TIMEOUT_MS = 600_000;
const MAX_CALLBACK_FIELD_CHARS = 8_192;

export interface GrokBuildMcpOAuthCallbackMessage {
  type: "grok-mcp-oauth-callback";
  code?: string;
  state?: string;
  issuer?: string;
  error?: string;
  errorDescription?: string;
}

/** A user-gesture dialog keeps agent tool execution paused while OAuth runs in a popup. */
export class GrokBuildMcpOAuthDialog {
  readonly credentialStore: McpOAuthCredentialStore;

  constructor(
    private readonly doc: Document = document,
    private readonly browserWindow: Window = window,
    private readonly authorizationTimeoutMs = NATIVE_BROWSER_AUTH_TIMEOUT_MS,
    credentialStore?: McpOAuthCredentialStore,
  ) {
    this.credentialStore = credentialStore ?? new GrokBuildIndexedDbMcpCredentialStore(browserWindow.indexedDB);
  }

  options(input: {
    serverName: string;
    clientId?: string;
    clientSecret?: string;
    scopes?: readonly string[];
    resolveAuthorizationHostname?: GrokBuildMcpOAuthOptions["resolveAuthorizationHostname"];
  }): GrokBuildMcpOAuthOptions {
    return {
      credentialStore: this.credentialStore,
      interactive: true,
      redirectUri: `${this.browserWindow.location.origin}${CALLBACK_PATH}`,
      authorize: (url, signal) => this.authorize(input.serverName, url, signal),
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
      ...(input.scopes ? { scopes: input.scopes } : {}),
      ...(input.resolveAuthorizationHostname ? { resolveAuthorizationHostname: input.resolveAuthorizationHostname } : {}),
    };
  }

  authorize(serverName: string, authorizationUrl: string, signal: AbortSignal): Promise<McpOAuthAuthorizationResult> {
    signal.throwIfAborted();
    const dialog = this.doc.createElement("dialog");
    dialog.className = "grok-plan-dialog grok-mcp-oauth-dialog";
    const form = this.doc.createElement("form");
    form.method = "dialog";
    form.addEventListener("submit", (event) => event.preventDefault());
    const header = this.doc.createElement("header");
    const title = this.doc.createElement("h2");
    title.textContent = `Connect ${serverName}`;
    const detail = this.doc.createElement("p");
    detail.textContent = "This MCP server requires authorization. Continue in the provider window, then return here.";
    header.append(title, detail);
    const actions = this.doc.createElement("footer");
    const cancel = this.doc.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = "Cancel";
    const continueButton = this.doc.createElement("button");
    continueButton.type = "button";
    continueButton.textContent = "Continue to provider";
    actions.append(cancel, continueButton);
    form.append(header, actions);
    dialog.append(form);
    this.doc.body.append(dialog);

    return new Promise((resolve, reject) => {
      let settled = false;
      let popup: Window | null = null;
      const timeout = this.browserWindow.setTimeout(() => {
        popup?.close();
        fail(new Error(`OAuth consent timed out after ${Math.ceil(this.authorizationTimeoutMs / 1_000)}s; try again.`));
      }, this.authorizationTimeoutMs);
      const cleanup = (): void => {
        this.browserWindow.clearTimeout(timeout);
        signal.removeEventListener("abort", aborted);
        this.browserWindow.removeEventListener("message", message);
        dialog.remove();
      };
      const fail = (reason: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      };
      const finish = (result: McpOAuthAuthorizationResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const aborted = (): void => {
        popup?.close();
        fail(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      };
      const message = (event: MessageEvent<unknown>): void => {
        const callback = parseGrokBuildMcpOAuthCallbackMessage(event.data);
        if (event.origin !== this.browserWindow.location.origin || event.source !== popup || !callback) return;
        popup?.close();
        if (callback.error) return fail(new Error(callback.errorDescription || callback.error));
        if (!callback.code || !callback.state) return fail(new Error("MCP OAuth callback omitted code or state."));
        finish({ code: callback.code, state: callback.state, ...(callback.issuer ? { issuer: callback.issuer } : {}) });
      };
      continueButton.addEventListener("click", () => {
        popup = this.browserWindow.open(authorizationUrl, "grok-mcp-oauth", "popup,width=560,height=720");
        if (!popup) fail(new Error("The authorization popup was blocked. Allow popups for this site and try again."));
        else {
          continueButton.disabled = true;
          continueButton.textContent = "Waiting for provider…";
        }
      });
      cancel.addEventListener("click", () => {
        popup?.close();
        fail(new DOMException("MCP authorization was cancelled.", "AbortError"));
      });
      dialog.addEventListener("cancel", (event) => { event.preventDefault(); cancel.click(); });
      signal.addEventListener("abort", aborted, { once: true });
      this.browserWindow.addEventListener("message", message);
      dialog.showModal();
    });
  }
}

export function parseGrokBuildMcpOAuthCallbackMessage(value: unknown): GrokBuildMcpOAuthCallbackMessage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const allowed = new Set(["type", "code", "state", "issuer", "error", "errorDescription"]);
  if (record.type !== "grok-mcp-oauth-callback" || Object.keys(record).some((key) => !allowed.has(key))) return undefined;
  for (const field of ["code", "state", "issuer", "error", "errorDescription"] as const) {
    const candidate = record[field];
    if (candidate !== undefined && (typeof candidate !== "string" || candidate.length > MAX_CALLBACK_FIELD_CHARS || /[\u0000-\u001f\u007f]/u.test(candidate))) {
      return undefined;
    }
  }
  return record as unknown as GrokBuildMcpOAuthCallbackMessage;
}
