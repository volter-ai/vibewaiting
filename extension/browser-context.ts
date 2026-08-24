import {
  browserPageAttachment,
  browserSelectionAttachment,
  type BrowserCaptureSource,
  type BrowserContextAttachment,
} from "../src/browser-context.js";

const OMITTED_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "iframe",
  "object",
  "embed",
  "template",
]);

function simpleHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function source(kind: string, identity: string): BrowserCaptureSource {
  return {
    id: `browser:${kind}:${simpleHash(`${location.href}\n${performance.timeOrigin}\n${identity}`)}`,
    title: document.title,
    url: location.href,
    capturedAt: new Date().toISOString(),
  };
}

function selectedText(): string {
  const active = document.activeElement;
  if (
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLInputElement && active.type !== "password"
  ) {
    const start = active.selectionStart;
    const end = active.selectionEnd;
    if (start !== null && end !== null && end > start)
      return active.value.slice(start, end);
  }
  return window.getSelection()?.toString() ?? "";
}

function boundedVisibleText(root: Element, limit: number): string {
  const pieces: string[] = [];
  const stack: Node[] = [root];
  let length = 0;
  let visited = 0;
  while (stack.length && length < limit && visited < 4_000) {
    const node = stack.pop()!;
    visited += 1;
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue?.replaceAll("\u0000", "") ?? "";
      if (!value.trim()) continue;
      const slice = value.slice(0, limit - length);
      pieces.push(slice);
      length += slice.length;
      continue;
    }
    if (!(node instanceof Element)) continue;
    const tag = node.tagName.toLowerCase();
    if (
      OMITTED_TAGS.has(tag) ||
      node.hasAttribute("hidden") ||
      node.getAttribute("aria-hidden") === "true" ||
      node.closest('[data-widget-shell-id="vibewaiting"]')
    )
      continue;
    const style = getComputedStyle(node);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.contentVisibility === "hidden"
    )
      continue;
    for (let index = node.childNodes.length - 1; index >= 0; index -= 1)
      stack.push(node.childNodes[index]!);
  }
  const text = pieces.join(" ").replace(/\s+/g, " ").trim();
  return stack.length && text.length >= limit
    ? `${text.slice(0, Math.max(0, limit - 1))}…`
    : text;
}

function pageCandidates(): BrowserContextAttachment[] {
  const selection = selectedText();
  const selected = browserSelectionAttachment(
    source("selection", selection),
    selection,
  );
  const visibleText = document.body
    ? boundedVisibleText(document.body, 16_000)
    : "";
  return [
    ...(selected ? [selected] : []),
    browserPageAttachment(source("page", location.href), visibleText),
  ];
}

export function captureBrowserContext(): BrowserContextAttachment[] {
  return pageCandidates();
}

export function captureShortcutAttachment(): BrowserContextAttachment {
  return pageCandidates()[0]!;
}
