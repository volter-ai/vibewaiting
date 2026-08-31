import {
  browserElementAttachment,
  browserImageAttachment,
  browserSelectionAttachment,
  browserWebReferenceAttachment,
  type BrowserCaptureSource,
  type BrowserContextAttachment,
} from "../src/browser-context.js";

type PageTarget =
  | { kind: "link"; url: string; label: string; evidence: string }
  | { kind: "image"; url: string; label: string; evidence: string }
  | {
      kind: "element";
      label: string;
      descriptor: string;
      evidence: string;
    };

let pointerElement: Element | null = null;
let focusedElement: Element | null = null;

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
    (active instanceof HTMLInputElement && active.type !== "password")
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

function isWidgetElement(element: Element): boolean {
  return Boolean(element.closest('[data-widget-shell-id="vibewaiting"]'));
}

function targetAt(target: EventTarget | null): PageTarget | null {
  const element = target instanceof Element ? target : null;
  if (!element || isWidgetElement(element)) return null;
  const image = element.closest("img");
  if (image instanceof HTMLImageElement) {
    const label =
      image.alt.trim() ||
      image.getAttribute("aria-label")?.trim() ||
      image.title.trim() ||
      "Page image";
    const evidenceRoot =
      image.closest("figure, article, li, tr, p") ??
      image.parentElement ??
      image;
    return {
      kind: "image",
      url: image.currentSrc || image.src,
      label,
      evidence: boundedVisibleText(evidenceRoot, 4_000),
    };
  }
  const anchor = element?.closest("a[href]");
  if (anchor instanceof HTMLAnchorElement) {
    const label =
      anchor.innerText.trim() ||
      anchor.getAttribute("aria-label")?.trim() ||
      anchor.title.trim() ||
      "";
    const evidenceRoot =
      anchor.closest("article, li, tr, p") ?? anchor.parentElement ?? anchor;
    return {
      kind: "link",
      url: anchor.href,
      label,
      evidence: boundedVisibleText(evidenceRoot, 4_000),
    };
  }
  const meaningful = element.closest(
    "pre, code, blockquote, figure, button, [role='button'], h1, h2, h3, h4, h5, h6",
  );
  if (!meaningful) return null;
  const role =
    meaningful.getAttribute("role") || meaningful.tagName.toLowerCase();
  const label =
    meaningful.getAttribute("aria-label")?.trim() ||
    boundedVisibleText(meaningful, 300) ||
    meaningful.getAttribute("title")?.trim() ||
    `Visible ${role}`;
  const rect = meaningful.getBoundingClientRect();
  return {
    kind: "element",
    label,
    descriptor: [
      `Role: ${role}`,
      `Viewport bounds: ${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}×${Math.round(rect.height)}`,
    ].join("\n"),
    evidence: boundedVisibleText(meaningful, 16_000),
  };
}

document.addEventListener(
  "pointerover",
  (event) => {
    const element = event.target instanceof Element ? event.target : null;
    if (element && isWidgetElement(element)) return;
    pointerElement = element;
  },
  { capture: true },
);

document.addEventListener(
  "focusin",
  (event) => {
    const element = event.target instanceof Element ? event.target : null;
    if (element && isWidgetElement(element)) return;
    focusedElement = element;
  },
  { capture: true },
);

function attachmentsFor(target: PageTarget): BrowserContextAttachment[] {
  if (target.kind === "link")
    return [
      browserWebReferenceAttachment(
        source("link", target.url),
        target.url,
        target.evidence,
        target.label,
      ),
    ];
  if (target.kind === "image") {
    const image = browserImageAttachment(
      source("image", target.url),
      target.label,
      target.url,
    );
    if (image) return [image];
    return [
      browserElementAttachment(
        source("image-reference", target.url),
        target.label,
        `Image source: ${target.url}`,
        target.evidence,
      ),
    ];
  }
  return [
    browserElementAttachment(
      source("element", `${target.descriptor}\n${target.label}`),
      target.label,
      target.descriptor,
      target.evidence,
    ),
  ];
}

function smartAttachments(): BrowserContextAttachment[] {
  const selection = selectedText();
  const selected = browserSelectionAttachment(
    source("selection", selection),
    selection,
  );
  if (selected) return [selected];
  const activeTarget = targetAt(document.activeElement);
  const target =
    activeTarget ??
    (focusedElement?.isConnected ? targetAt(focusedElement) : null) ??
    (pointerElement?.isConnected ? targetAt(pointerElement) : null);
  if (target) return attachmentsFor(target);
  const visibleText = document.body
    ? boundedVisibleText(document.body, 16_000)
    : "";
  return [
    browserWebReferenceAttachment(
      source("page", location.href),
      location.href,
      visibleText,
      document.title,
    ),
  ];
}

export function captureBrowserContext(): BrowserContextAttachment[] {
  return smartAttachments();
}

export function captureShortcutAttachments(): BrowserContextAttachment[] {
  return smartAttachments();
}

export function captureLinkAttachment(
  targetUrl: string,
): BrowserContextAttachment {
  const candidates = [
    targetAt(document.activeElement),
    focusedElement?.isConnected ? targetAt(focusedElement) : null,
    pointerElement?.isConnected ? targetAt(pointerElement) : null,
  ];
  const remembered = candidates.find(
    (candidate): candidate is Extract<PageTarget, { kind: "link" }> =>
      candidate?.kind === "link" && candidate.url === targetUrl,
  );
  const link = remembered ?? {
    kind: "link" as const,
    url: targetUrl,
    label: "",
    evidence: `Link found on ${document.title || location.hostname}.`,
  };
  return browserWebReferenceAttachment(
    source("link", link.url),
    link.url,
    link.evidence,
    link.label,
  );
}
