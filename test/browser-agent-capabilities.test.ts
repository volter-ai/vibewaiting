import { describe, expect, it } from "vitest";
import { missingBrowserAgentCapabilities } from "../experiments/browser-agent/src/browser-capabilities.js";

function capableScope(): Parameters<typeof missingBrowserAgentCapabilities>[0] {
  return {
    isSecureContext: true,
    navigator: { serviceWorker: {} } as Navigator,
    indexedDB: {} as IDBFactory,
    crypto: { subtle: {}, randomUUID: () => crypto.randomUUID() } as Crypto,
    WebAssembly,
    Worker: class {} as unknown as typeof Worker,
    MessageChannel,
    ReadableStream,
    Blob,
    DecompressionStream,
    TextEncoder,
    TextDecoder,
    fetch,
    structuredClone,
    AbortSignal,
  };
}

describe("browser-agent capability gate", () => {
  it("accepts the APIs exercised by the supported browser matrix", () => {
    expect(missingBrowserAgentCapabilities(capableScope())).toEqual([]);
  });

  it("reports every unavailable runtime boundary", () => {
    expect(missingBrowserAgentCapabilities({})).toEqual([
      "secure context (HTTPS)", "service workers", "IndexedDB", "Web Crypto",
      "WebAssembly", "Web Workers", "MessageChannel", "web streams",
      "DecompressionStream", "text encoding", "Fetch", "structuredClone", "modern AbortSignal",
    ]);
  });
});
