import { describe, expect, it } from "vitest";
import {
  browserElementAttachment,
  browserImageAttachment,
  browserSelectionAttachment,
  browserWebReferenceAttachment,
  MAX_BROWSER_CONTEXT_DETAIL,
  parseBrowserContextAttachments,
  sanitizeBrowserUrl,
} from "../src/browser-context.js";
import { classifyWebReference } from "../src/web-reference.js";

describe("browser context trust boundary", () => {
  it("keeps an immutable useful capture while stripping secrets and enforcing the wire bounds", () => {
    expect(
      sanitizeBrowserUrl(
        "https://user:password@example.com/account?id=42&token=secret&utm_source=test#/settings",
      ),
    ).toBe("https://example.com/account?id=42#/settings");
    expect(
      classifyWebReference("https://news.ycombinator.com/item?id=41234567"),
    ).toEqual({
      version: 1,
      url: "https://news.ycombinator.com/item?id=41234567",
      target: {
        provider: "hacker-news",
        kind: "item",
        itemId: "41234567",
      },
    });
    expect(
      classifyWebReference(
        "https://github.com/volter-ai/vibewaiting/blob/8a92c41/src/browser-context.ts#L14-L29",
      )?.target,
    ).toEqual({
      provider: "github",
      kind: "file",
      owner: "volter-ai",
      repository: "vibewaiting",
      ref: "8a92c41",
      path: "src/browser-context.ts",
      lines: { start: 14, end: 29 },
    });
    const source = {
      id: "capture-1",
      title: "Account settings",
      url: "https://example.com/account?token=secret",
      capturedAt: "2026-08-24T12:00:00.000Z",
    };
    const selection = browserSelectionAttachment(source, "x".repeat(40_000));
    expect(selection).not.toBeNull();
    expect(selection!.detail.length).toBeLessThanOrEqual(MAX_BROWSER_CONTEXT_DETAIL);
    expect(selection!.detail).not.toContain("token=secret");
    expect(parseBrowserContextAttachments([selection])).toEqual([selection]);

    const reference = browserWebReferenceAttachment(
      source,
      "https://github.com/volter-ai/vibewaiting/pull/104",
      "Terminal mode belongs in the conversation header.",
      "Fix terminal mode",
    );
    expect(reference.label).toBe(
      "GitHub pull request · volter-ai/vibewaiting #104",
    );
    expect(parseBrowserContextAttachments([reference])).toEqual([reference]);

    const image = browserImageAttachment(
      source,
      "Architecture diagram",
      "https://example.com/diagram.png?utm_source=feed&size=large",
    );
    expect(image).toEqual({
      id: "capture-1",
      kind: "browser-image",
      label: "Architecture diagram",
      url: "https://example.com/diagram.png?size=large",
    });
    const element = browserElementAttachment(
      source,
      "Build failed",
      "Role: button\nViewport bounds: 10,20 120×32",
      "Build failed with two errors",
    );
    expect(parseBrowserContextAttachments([image, element])).toEqual([
      image,
      element,
    ]);

    expect(
      parseBrowserContextAttachments([
        { id: "image", label: "invalid", url: "data:image/png;base64,x" },
      ]),
    ).toBeNull();
  });
});
