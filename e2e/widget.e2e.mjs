import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { createLucarneInjector } from "@volter-ai-dev/widget-shell/lucarne";
import { hostElementId, iframeGlobal, intentQueueGlobal } from "lucarne/widget";

const NS = "vibewaiting";
const HOST = hostElementId(NS);
const FRAME_GLOBAL = iframeGlobal(NS);
const INTENT_QUEUE = intentQueueGlobal(NS, "agent");
const widgetHtml = await readFile(new URL("../dist/widget.html", import.meta.url), "utf8");
const injector = createLucarneInjector({
  launcherLabel: "Open agent chats",
  launcherHidden: true,
  viewport: { width: 390, height: 667, gutter: 16 },
  theme: { radius: "12px" },
});

async function mountWidget(page) {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.setContent("<!doctype html><title>Host application</title><main>Host application</main>");
  await page.addScriptTag({ content: injector({ ns: NS, html: widgetHtml }) });
  const host = page.locator(`#${HOST}`);
  await host.waitFor({ state: "attached", timeout: 1000 });
  const frame = page.frameLocator(`#${HOST} iframe`);
  await frame.locator("#app").waitFor({ state: "attached", timeout: 1000 });
  return { frame, host };
}

async function push(page, patch) {
  await page.evaluate(({ frameGlobal, nextPatch }) => {
    const frame = window[frameGlobal];
    frame.contentWindow.postMessage(
      { lwState: { v: 1, ns: "vibewaiting", identity: { profile: "browser-test" }, patch: nextPatch } },
      window.location.origin === "null" ? "*" : window.location.origin,
    );
  }, { frameGlobal: FRAME_GLOBAL, nextPatch: patch });
}

async function latestIntentId(page) {
  await page.waitForFunction((queueGlobal) => Array.isArray(window[queueGlobal]) && window[queueGlobal].length > 0, INTENT_QUEUE, { timeout: 1000 });
  return await page.evaluate((queueGlobal) => window[queueGlobal].at(-1).id, INTENT_QUEUE);
}

function readyState(overrides = {}) {
  return {
    pill: { tone: "live", label: "Codex ready" },
    startup: "ready",
    harness: "",
    mode: "mirror",
    sessions: [{ key: "one", harness: "codex", name: "widget", cwd: "/work", title: "Widget audit", active: true, live: false }],
    attached: null,
    attention: [],
    transcript: [],
    harnesses: [{ id: "codex", label: "Codex", installed: true, startable: true, reason: null }],
    ...overrides,
  };
}

async function acknowledgeMounted(page, overrides = {}) {
  const bridgeAck = await latestIntentId(page);
  await push(page, readyState({ ...overrides, bridgeAck }));
}

async function acknowledgeLatest(page, patch = {}) {
  const bridgeAck = await latestIntentId(page);
  await push(page, { ...patch, bridgeAck });
}

test("the Lucarne adapter delivers the canonical harness launcher without clipping its badge", async ({ page }) => {
  await mountWidget(page);
  await acknowledgeMounted(page, { attention: [{ key: "one", kind: "unseen" }] });

  const launcher = page.getByRole("button", { name: /Open agent chats/ });
  await expect(launcher).toBeVisible({ timeout: 1000 });
  await expect(launcher.locator("img")).toHaveAttribute("src", /^data:image\/svg\+xml/, { timeout: 1000 });
  const geometry = await page.locator(`#${HOST}`).evaluate((host) => {
    const launcher = host.shadowRoot.querySelector(".ws-launcher").getBoundingClientRect();
    const badge = host.shadowRoot.querySelector(".ws-badge").getBoundingClientRect();
    return {
      launcher: { width: launcher.width, height: launcher.height },
      badgeInsideViewport: badge.top >= 0 && badge.right <= innerWidth && badge.bottom <= innerHeight,
    };
  });
  expect(geometry.launcher).toEqual({ width: 54, height: 54 });
  expect(geometry.badgeInsideViewport).toBe(true);
});

test("identical state patches do not rebuild or replay the launcher", async ({ page }) => {
  await mountWidget(page);
  const state = readyState();
  await acknowledgeMounted(page);
  const launcher = page.getByRole("button", { name: /Open agent chats/ });
  await launcher.evaluate((element) => {
    window.__vibewaitingMutationCount = 0;
    new MutationObserver((records) => { window.__vibewaitingMutationCount += records.length; })
      .observe(element, { childList: true, subtree: true, attributes: true });
  });
  await push(page, state);
  await push(page, state);
  expect(await launcher.evaluate(() => window.__vibewaitingMutationCount)).toBe(0);
});

test("the expanded surface is one stable mobile messenger viewport and closes through the outer shell", async ({ page }) => {
  const { frame, host } = await mountWidget(page);
  await acknowledgeMounted(page, {
    attached: { key: "one", harness: "codex", name: "widget", cwd: "/work", title: "Widget audit" },
    transcript: [{ id: "u1", role: "user", text: "Review the widget", ts: null, truncated: false }],
  });
  const launcher = page.getByRole("button", { name: /Open agent chats/ });
  await launcher.click({ timeout: 1000 });
  await acknowledgeLatest(page);
  await frame.getByRole("button", { name: /Widget audit/ }).click({ timeout: 1000 });
  await acknowledgeLatest(page, {
    attached: { key: "one", harness: "codex", name: "widget", cwd: "/work", title: "Widget audit" },
    transcript: [{ id: "u1", role: "user", text: "Review the widget", ts: null, truncated: false }],
  });
  await expect(frame.getByText("Review the widget")).toBeVisible({ timeout: 1000 });
  const panel = await host.evaluate((element) => {
    const rect = element.shadowRoot.querySelector(".ws-panel").getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(panel).toEqual({ width: 390, height: 667 });
  await frame.getByRole("button", { name: "Close" }).click({ timeout: 1000 });
  expect(await host.evaluate((element) => element.shadowRoot.activeElement?.classList.contains("ws-launcher"))).toBe(true);
  await acknowledgeLatest(page);
});

test("a stale guest reports a dead bridge instead of looking frozen", async ({ page }) => {
  const { frame } = await mountWidget(page);
  await acknowledgeMounted(page);
  await page.getByRole("button", { name: /Open agent chats/ }).click({ timeout: 1000 });
  await frame.getByRole("button", { name: /Widget audit/ }).click({ timeout: 1000 });
  await expect(frame.getByRole("alert")).toContainText("Agent bridge disconnected", { timeout: 1000 });
});
