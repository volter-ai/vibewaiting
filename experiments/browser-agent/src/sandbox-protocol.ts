export const SANDBOX_CHANNEL = "vibewaiting-sandbox-v1";

export interface SandboxEnvelope {
  channel: typeof SANDBOX_CHANNEL;
  nonce: string;
  type: "ready" | "request" | "response" | "preview-load" | "rendered" | "error";
  payload?: unknown;
}

export function isSandboxEnvelope(value: unknown, nonce: string): value is SandboxEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SandboxEnvelope>;
  return candidate.channel === SANDBOX_CHANNEL && candidate.nonce === nonce && typeof candidate.type === "string";
}

export function resolveSandboxOrigin(pageLocation: Location, configured?: string): string {
  let origin: string;
  if (configured) {
    origin = new URL(configured).origin;
  } else if (pageLocation.hostname === "127.0.0.1") {
    origin = `${pageLocation.protocol}//sandbox.localhost:${pageLocation.port}`;
  } else if (pageLocation.hostname === "localhost") {
    origin = `${pageLocation.protocol}//127.0.0.1:${pageLocation.port}`;
  } else {
    throw new Error("VITE_SANDBOX_ORIGIN must name the separately deployed sandbox origin.");
  }

  if (origin === pageLocation.origin) {
    throw new Error("The generated-code sandbox must use a different origin from the authenticated workbench.");
  }
  return origin;
}

