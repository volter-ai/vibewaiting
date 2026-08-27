import { describe, expect, it, vi } from "vitest";
import { VirtualFS } from "almostnode";
import { GrokBuildMediaClient } from "../experiments/browser-agent/src/grok-build-media.js";
import { GrokBuildBrowserRuntime } from "../experiments/browser-agent/src/grok-build-runtime.js";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const MP4 = new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

describe("browser-native Imagine tools", () => {
  it("generates and edits images with native payloads and VFS paths", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; session: string | null }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        session: headers.get("x-browser-agent-session"),
      });
      return Response.json({ b64Json: base64(JPEG) });
    }) as unknown as typeof fetch;
    const vfs = new VirtualFS();
    vfs.mkdirSync("/assets", { recursive: true });
    vfs.writeFileSync("/assets/source.jpg", JPEG);
    const client = new GrokBuildMediaClient(vfs, fetchImpl, () => "11111111-1111-4111-8111-111111111111");

    await expect(client.generateImage({ prompt: "a moon", aspect_ratio: "16:9" }, new AbortController().signal))
      .resolves.toBe("/.grok/images/1.jpg");
    await expect(client.editImage({ prompt: "make it blue", image: ["/assets/source.jpg"] }, new AbortController().signal))
      .resolves.toBe("/.grok/images/2.jpg");

    expect(vfs.readFileSync("/.grok/images/1.jpg")).toEqual(JPEG);
    expect(calls).toEqual([
      {
        url: "/api/grok/media/image",
        body: { kind: "generate", prompt: "a moon", aspectRatio: "16:9" },
        session: "11111111-1111-4111-8111-111111111111",
      },
      {
        url: "/api/grok/media/image",
        body: {
          kind: "edit",
          prompt: "make it blue",
          aspectRatio: "auto",
          images: [`data:image/jpeg;base64,${base64(JPEG)}`],
        },
        session: "11111111-1111-4111-8111-111111111111",
      },
    ]);
  });

  it("starts and polls video generation in the browser instead of holding a relay open", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      if (String(input).endsWith("/start")) return Response.json({ requestToken: "signed-request" });
      if (calls.filter((url) => url.endsWith("/poll")).length === 1) {
        return Response.json({ status: "pending" }, { status: 202 });
      }
      return new Response(MP4, { headers: { "Content-Type": "video/mp4" } });
    }) as unknown as typeof fetch;
    const client = new GrokBuildMediaClient(
      new VirtualFS(),
      fetchImpl,
      undefined,
      async () => undefined,
    );

    await expect(client.referenceToVideo({
      prompt: "<AUDIO_0> narrates",
      voices: ["eve"],
      aspect_ratio: "16:9",
      duration: "10",
    }, new AbortController().signal)).resolves.toBe("/.grok/videos/1.mp4");
    expect(calls).toEqual([
      "/api/grok/media/video/start",
      "/api/grok/media/video/poll",
      "/api/grok/media/video/poll",
    ]);
  });

  it("routes all four advertised tools and preserves the successful tier nudge", async () => {
    const message = "Image generation is a SuperGrok feature";
    const fetchImpl = vi.fn(async () => Response.json({ tierRestricted: true, message })) as unknown as typeof fetch;
    const vfs = new VirtualFS();
    const client = new GrokBuildMediaClient(vfs, fetchImpl);
    const runtime = new GrokBuildBrowserRuntime({
      vfs,
      async run() { return { stdout: "", stderr: "", exitCode: 0 }; },
    }, "/", {
      generateImage: (input, signal) => client.generateImage(input, signal),
      editImage: (input, signal) => client.editImage(input, signal),
      imageToVideo: (input, signal) => client.imageToVideo(input, signal),
      referenceToVideo: (input, signal) => client.referenceToVideo(input, signal),
    });
    await expect(runtime.execute({ callId: "image", name: "image_gen", arguments: '{"prompt":"cat"}' }, new AbortController().signal))
      .resolves.toEqual({ output: message });
  });

  it("rejects malformed references and native video argument violations before transport", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new GrokBuildMediaClient(new VirtualFS(), fetchImpl);
    await expect(client.imageToVideo({ image: "relative.png" }, new AbortController().signal))
      .rejects.toThrow(/absolute browser filesystem path/u);
    await expect(client.imageToVideo({ image: "https://example.com/a.png", duration: 8 }, new AbortController().signal))
      .rejects.toThrow(/either 6 or 10/u);
    await expect(client.referenceToVideo({ prompt: "x", aspect_ratio: "21:9", voices: ["eve"] }, new AbortController().signal))
      .rejects.toThrow(/aspect_ratio/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
