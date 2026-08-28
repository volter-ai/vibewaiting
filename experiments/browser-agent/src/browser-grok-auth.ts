interface AuthStatusPayload {
  authenticated?: boolean;
  email?: string | null;
  subscriptionTier?: string | null;
  eligible?: boolean;
  error?: { message?: string } | string;
}

interface DeviceAuthPayload extends AuthStatusPayload {
  status?: "pending" | "authenticated";
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string | null;
  intervalSeconds?: number;
}

export interface BrowserGrokAuthElements {
  status: HTMLElement;
  connectButton: HTMLButtonElement;
  disconnectButton: HTMLButtonElement;
  devicePanel: HTMLElement;
  deviceCode: HTMLElement;
  deviceLink: HTMLAnchorElement;
}

export interface BrowserGrokAuthOptions {
  elements: BrowserGrokAuthElements;
  fetch?: typeof globalThis.fetch;
  onReadyChange: (ready: boolean) => void;
  onAuthenticated?: () => void;
}

/** Cloud device auth with a local Grok credential fallback for development. */
export class BrowserGrokAuthController {
  private readonly fetchImpl: typeof globalThis.fetch;
  private cloudAuth = false;
  private pollTimer: number | undefined;

  constructor(private readonly options: BrowserGrokAuthOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async refreshStatus(): Promise<void> {
    const elements = this.options.elements;
    try {
      const response = await this.fetchImpl("/api/auth/status", { credentials: "include", cache: "no-store" });
      const isJson = response.headers.get("Content-Type")?.includes("application/json") === true;
      if (response.status !== 404 && isJson) {
        this.cloudAuth = true;
        const payload = await readJson<AuthStatusPayload>(response);
        if (payload.authenticated) this.showAuthenticated(payload);
        else this.showDisconnected("Not connected", false);
        return;
      }
    } catch (error) {
      if (this.cloudAuth) {
        this.showDisconnected(error instanceof Error ? error.message : String(error), false);
        return;
      }
    }

    try {
      const payload = await readJson<AuthStatusPayload>(await this.fetchImpl("/api/grok/status", { cache: "no-store" }));
      if (!payload.authenticated) throw new Error(authMessage(payload, "No local Grok Build credential"));
      this.showAuthenticated(payload, true);
    } catch (error) {
      this.options.onReadyChange(false);
      elements.status.textContent = error instanceof Error ? error.message : String(error);
      elements.connectButton.hidden = true;
      elements.disconnectButton.hidden = true;
    }
  }

  async startDeviceAuth(): Promise<void> {
    const elements = this.options.elements;
    elements.connectButton.disabled = true;
    elements.status.textContent = "Starting xAI device sign-in…";
    try {
      const payload = await readJson<DeviceAuthPayload>(await this.fetchImpl("/api/auth/device/start", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }));
      if (!payload.userCode || !payload.verificationUri) throw new Error("xAI returned an incomplete device sign-in response.");
      elements.deviceCode.textContent = payload.userCode;
      elements.deviceLink.href = payload.verificationUriComplete || payload.verificationUri;
      elements.devicePanel.hidden = false;
      elements.status.textContent = "Waiting for approval at xAI…";
      elements.connectButton.hidden = true;
      const intervalSeconds = Math.max(1, payload.intervalSeconds ?? 5);
      this.pollTimer = window.setTimeout(() => void this.pollDeviceAuth(intervalSeconds), intervalSeconds * 1_000);
    } catch (error) {
      elements.status.textContent = error instanceof Error ? error.message : String(error);
      elements.connectButton.hidden = false;
    } finally {
      elements.connectButton.disabled = false;
    }
  }

  async disconnect(): Promise<void> {
    await readJson<AuthStatusPayload>(await this.fetchImpl("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }));
    this.showDisconnected("Not connected", false);
  }

  private showAuthenticated(payload: AuthStatusPayload, local = false): void {
    const elements = this.options.elements;
    this.options.onReadyChange(local || payload.eligible !== false);
    const identity = payload.email || payload.subscriptionTier;
    elements.status.textContent = local
      ? `Local Grok Build credential${identity ? ` · ${identity}` : ""}`
      : `${payload.subscriptionTier || "Connected"}${payload.email ? ` · ${payload.email}` : ""}${payload.eligible === false ? " · subscription not eligible" : ""}`;
    elements.connectButton.hidden = true;
    elements.disconnectButton.hidden = local;
    elements.devicePanel.hidden = true;
    if (this.pollTimer !== undefined) window.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.options.onAuthenticated?.();
  }

  private showDisconnected(message: string, hideConnect: boolean): void {
    const elements = this.options.elements;
    this.options.onReadyChange(false);
    elements.status.textContent = message;
    elements.connectButton.hidden = hideConnect;
    elements.disconnectButton.hidden = true;
  }

  private async pollDeviceAuth(intervalSeconds: number): Promise<void> {
    const elements = this.options.elements;
    try {
      const response = await this.fetchImpl("/api/auth/device/poll", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const payload = await response.json().catch(() => ({})) as DeviceAuthPayload;
      if (response.ok && payload.status === "authenticated") {
        this.showAuthenticated(payload);
        return;
      }
      if (response.status !== 202 && response.status !== 429) {
        throw new Error(authMessage(payload, `Sign-in polling failed with HTTP ${response.status}`));
      }
      const retryAfter = Number.parseInt(response.headers.get("Retry-After") || "", 10);
      const nextSeconds = Number.isFinite(retryAfter) ? retryAfter : payload.intervalSeconds ?? intervalSeconds;
      this.pollTimer = window.setTimeout(() => void this.pollDeviceAuth(nextSeconds), Math.max(1, nextSeconds) * 1_000);
    } catch (error) {
      elements.status.textContent = error instanceof Error ? error.message : String(error);
      elements.connectButton.hidden = false;
      elements.devicePanel.hidden = true;
    }
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T;
  if (!response.ok) throw new Error(authMessage(payload as AuthStatusPayload, `HTTP ${response.status}`));
  return payload;
}

function authMessage(payload: AuthStatusPayload, fallback: string): string {
  if (typeof payload.error === "string") return payload.error;
  if (payload.error && typeof payload.error.message === "string") return payload.error.message;
  return fallback;
}
