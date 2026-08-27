import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualFS } from "almostnode";
import {
  GrokBuildWebFetchClient,
  stripBase64DataUris,
} from "../experiments/browser-agent/src/grok-build-web-fetch.js";
import { GrokBuildBrowserRuntime } from "../experiments/browser-agent/src/grok-build-runtime.js";

function contentResponse(body: BodyInit, contentType = "text/html", status = 200): Response {
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "X-Vibewaiting-Web-Fetch-Kind": "content",
      "X-Vibewaiting-Web-Fetch-Status": String(status),
      "X-Vibewaiting-Web-Fetch-Url": encodeURIComponent("https://docs.rs/final"),
    },
  });
}

describe("browser-native web_fetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("routes through the service tool and preserves native HTML cleanup output handling", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => contentResponse("<main>Hello</main>")));
    const vfs = new VirtualFS();
    const web = new GrokBuildWebFetchClient(vfs, "/api/grok/web-fetch", (html) => {
      expect(html).toBe("<main>Hello</main>");
      return "# Hello\n\ndata:image/png;base64,AAAA==";
    });
    const runtime = new GrokBuildBrowserRuntime({
      vfs,
      async run() { return { stdout: "", stderr: "", exitCode: 0 }; },
    }, "/", { webFetch: (url, signal) => web.fetch(url, signal) });

    await expect(runtime.execute({
      callId: "fetch",
      name: "web_fetch",
      arguments: '{"url":"https://docs.rs/serde"}',
    }, new AbortController().signal)).resolves.toEqual({ output: "# Hello\n\n[base64 image/png data removed]" });
    expect(fetch).toHaveBeenCalledWith("/api/grok/web-fetch", expect.objectContaining({
      method: "POST",
      body: '{"url":"https://docs.rs/serde"}',
    }));
  });

  it("returns native cross-host guidance without following the new host", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      kind: "cross-host-redirect",
      originalHost: "docs.rs",
      redirectUrl: "https://www.rust-lang.org/learn",
    }), { headers: { "Content-Type": "application/json" } })));
    const web = new GrokBuildWebFetchClient(new VirtualFS());
    await expect(web.fetch("https://docs.rs/start", new AbortController().signal)).resolves.toBe(
      "Error: cross-host redirect from docs.rs to https://www.rust-lang.org/learn. Make a new web_fetch call with the redirect URL if needed.",
    );
  });

  it("persists overflow and validated media inside the browser filesystem", async () => {
    const responses = [
      contentResponse("x".repeat(60_001), "text/plain"),
      contentResponse(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]), "image/png"),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));
    const vfs = new VirtualFS();
    const web = new GrokBuildWebFetchClient(vfs);
    const text = await web.fetch("https://docs.rs/large", new AbortController().signal);
    expect(text).toContain("showing first 60000 of 60001 bytes");
    expect(text).toContain("/.grok/web_fetch/1.txt");
    expect(vfs.readFileSync("/.grok/web_fetch/1.txt", "utf8")).toHaveLength(60_001);
    await expect(web.fetch("https://docs.rs/image", new AbortController().signal)).resolves.toBe(
      "Image downloaded (6 bytes, image/png) and saved to /.grok/images/2.png. Use the read_file tool to view its contents.",
    );
    expect(vfs.readFileSync("/.grok/images/2.png")).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]));
  });

  it("matches native base64 data-URI edge handling", () => {
    expect(stripBase64DataUris("before data:text/plain;charset=utf-8;base64,SGVsbG8= after"))
      .toBe("before [base64 text/plain data removed] after");
    expect(stripBase64DataUris("metadata:image/png;base64,AAAA=="))
      .toBe("metadata:image/png;base64,AAAA==");
    expect(stripBase64DataUris("data:image/png;Base64,AAAA=="))
      .toBe("[base64 image/png data removed]");
  });
});
