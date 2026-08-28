import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GENERATED_PREVIEW_CSP,
  hardenSandboxServiceWorker,
  THREE_CORE_ASSET_PATH,
  THREE_MODULE_ASSET_PATH,
} from "../experiments/browser-agent/sandbox-service-worker-hardening.js";
import { validateSandboxRequest } from "../experiments/browser-agent/src/browser-sandbox-bridge.js";
import { resolveSandboxOrigin } from "../experiments/browser-agent/src/sandbox-protocol.js";

const almostnodeWorker = readFileSync(new URL("../node_modules/almostnode/dist/__sw__.js", import.meta.url), "utf8");

describe("browser-agent sandbox hardening", () => {
  it("uses canonical loopback hosts as distinct local origins", () => {
    const location = (hostname: string, origin: string) => ({
      hostname, origin, protocol: "http:", port: "4175",
    }) as Location;
    expect(resolveSandboxOrigin(location("127.0.0.1", "http://127.0.0.1:4175"))).toBe("http://localhost:4175");
    expect(resolveSandboxOrigin(location("localhost", "http://localhost:4175"))).toBe("http://127.0.0.1:4175");
    expect(() => resolveSandboxOrigin(location("localhost", "http://localhost:4175"), "http://localhost:4175"))
      .toThrow(/different origin/u);
  });

  it("injects a deny-by-default generated-page policy and client-aware network guard", () => {
    const hardened = hardenSandboxServiceWorker(almostnodeWorker);
    expect(GENERATED_PREVIEW_CSP).toContain("connect-src 'self' blob:");
    expect(GENERATED_PREVIEW_CSP).toContain("form-action 'none'");
    expect(hardened).toContain("Generated preview network access is disabled.");
    expect(hardened).toContain("referrerPolicy=no-referrer and worker bypasses");
    expect(hardened).toContain("Access-Control-Allow-Origin', '*'");
    expect(hardened).toContain(THREE_MODULE_ASSET_PATH);
    expect(hardened).toContain(THREE_CORE_ASSET_PATH);
  });

  it("fails closed when the pinned AlmostNode service-worker protocol drifts", () => {
    expect(() => hardenSandboxServiceWorker(almostnodeWorker.replace("mainPort.onmessage = handleMainMessage;", "")))
      .toThrow(/protocol changed/u);
  });

  it("accepts bounded virtual requests and rejects cross-origin and malformed inputs", () => {
    expect(validateSandboxRequest({
      type: "request",
      id: 7,
      data: { port: 4176, method: "GET", url: "/src/main.js?t=1", headers: { accept: "*/*" }, body: null },
    }, 4176)).toMatchObject({ id: 7, data: { method: "GET", streaming: false } });

    expect(() => validateSandboxRequest({
      type: "request",
      id: 8,
      data: { port: 4176, method: "GET", url: "//attacker.invalid/path", headers: {} },
    }, 4176)).toThrow(/target/u);
    expect(() => validateSandboxRequest({
      type: "request",
      id: 9,
      data: { port: 4176, method: "TRACE", url: "/", headers: {} },
    }, 4176)).toThrow(/target/u);
    expect(() => validateSandboxRequest({
      type: "request",
      id: 10,
      data: { port: 4176, method: "GET", url: "/", headers: { bad: "one\ntwo" } },
    }, 4176)).toThrow(/headers/u);
  });
});
