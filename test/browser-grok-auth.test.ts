import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserGrokAuthController,
  type BrowserGrokAuthElements,
} from "../experiments/browser-agent/src/browser-grok-auth.js";

function elements(): BrowserGrokAuthElements {
  return {
    status: { textContent: "" },
    connectButton: { disabled: false, hidden: false },
    disconnectButton: { hidden: true },
    devicePanel: { hidden: true },
    deviceCode: { textContent: "" },
    deviceLink: { href: "" },
  } as unknown as BrowserGrokAuthElements;
}

function payload(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, init);
}

function installWindowTimers(): void {
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BrowserGrokAuthController", () => {
  it("cancels device polling when the controller is destroyed", async () => {
    vi.useFakeTimers();
    installWindowTimers();
    const fetchMock = vi.fn(async () => payload({
      status: "pending",
      userCode: "ABCD-EFGH",
      verificationUri: "https://x.ai/device",
      intervalSeconds: 5,
    }));
    const controller = new BrowserGrokAuthController({
      elements: elements(),
      fetch: fetchMock as unknown as typeof fetch,
      onReadyChange: vi.fn(),
    });

    await controller.startDeviceAuth();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    controller.destroy();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds initial and server-directed polling to one through sixty seconds", async () => {
    vi.useFakeTimers();
    installWindowTimers();
    const fetchMock = vi.fn(async () => fetchMock.mock.calls.length === 1
      ? payload({
          status: "pending",
          userCode: "ABCD-EFGH",
          verificationUri: "https://x.ai/device",
          intervalSeconds: 5_000,
        })
      : payload({ status: "pending", intervalSeconds: 0 }, {
          status: 202,
          headers: { "Retry-After": "0" },
        }));
    const controller = new BrowserGrokAuthController({
      elements: elements(),
      fetch: fetchMock as unknown as typeof fetch,
      onReadyChange: vi.fn(),
    });

    await controller.startDeviceAuth();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    controller.destroy();
  });

  it("does not report a disconnect when server logout fails", async () => {
    installWindowTimers();
    const ui = elements();
    const ready = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/status")
      ? payload({ authenticated: true, eligible: true, subscriptionTier: "SuperGrok" })
      : payload({ error: { message: "logout unavailable" } }, { status: 503 }));
    const controller = new BrowserGrokAuthController({
      elements: ui,
      fetch: fetchMock as unknown as typeof fetch,
      onReadyChange: ready,
    });

    await controller.refreshStatus();
    expect(ready).toHaveBeenLastCalledWith(true);
    expect(ui.disconnectButton.hidden).toBe(false);
    await controller.disconnect();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ui.status.textContent).toBe("logout unavailable");
    expect(ui.disconnectButton.hidden).toBe(false);
  });
});
