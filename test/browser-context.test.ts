import { describe, expect, it } from "vitest";
import {
  browserSelectionAttachment,
  MAX_BROWSER_CONTEXT_DETAIL,
  parseBrowserContextAttachments,
  sanitizeBrowserUrl,
} from "../src/browser-context.js";

describe("browser context trust boundary", () => {
  it("keeps an immutable useful capture while stripping secrets and enforcing the wire bounds", () => {
    expect(
      sanitizeBrowserUrl(
        "https://user:password@example.com/account?token=secret#/settings",
      ),
    ).toBe("https://example.com/account#/settings");
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

    expect(parseBrowserContextAttachments([{ id: "image", label: "invalid", url: "data:image/png;base64,x" }])).toBeNull();
  });
});
