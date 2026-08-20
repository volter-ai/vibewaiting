import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";

const widgetHtml = await readFile(new URL("../dist/widget.html", import.meta.url), "utf8");

async function mountWidget(page) {
  await page.setViewportSize({ width: 800, height: 700 });
  await page.setContent('<iframe id="widget" title="Vibewaiting widget" style="width:500px;height:600px;border:0"></iframe>');
  await page.locator("#widget").evaluate((element, html) => { element.srcdoc = html; }, widgetHtml);
  const frame = page.frameLocator("#widget");
  await frame.locator(".pill").waitFor({ state: "attached", timeout: 1000 });
  return frame;
}

async function push(page, patch) {
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
  if (!frame) throw new Error("widget frame did not mount");
  await frame.evaluate((nextPatch) => {
    window.postMessage({ lwState: { v: 1, ns: "vibewaiting", identity: "browser-test", patch: nextPatch } }, "*");
  }, patch);
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

test("collapsed messenger uses the active harness and keeps notification chrome inside its safe area", async ({ page }) => {
  const frame = await mountWidget(page);
  await push(page, readyState({ attention: [{ key: "one", kind: "unseen" }] }));

  const launcher = frame.locator(".pill");
  await expect(launcher).toHaveAttribute("data-mode", "unread", { timeout: 1000 });
  await expect(frame.locator('.scui-logo[data-harness="codex"]')).toHaveCount(1, { timeout: 1000 });
  const geometry = await frame.locator(".wrap").evaluate((wrap) => {
    const pill = wrap.querySelector(".pill").getBoundingClientRect();
    const badge = wrap.querySelector(".badge").getBoundingClientRect();
    const bounds = wrap.getBoundingClientRect();
    return {
      pill: { width: pill.width, height: pill.height },
      contained: badge.left >= bounds.left && badge.top >= bounds.top && badge.right <= bounds.right && badge.bottom <= bounds.bottom,
      bounds: { width: bounds.width, height: bounds.height },
    };
  });
  expect(geometry.pill).toEqual({ width: 56, height: 56 });
  expect(geometry.bounds).toEqual({ width: 64, height: 64 });
  expect(geometry.contained).toBe(true);
});

test("identical state patches do not rebuild or replay the collapsed launcher", async ({ page }) => {
  const frame = await mountWidget(page);
  const state = readyState();
  await push(page, state);
  await expect(frame.locator('.scui-logo[data-harness="codex"]')).toHaveCount(1, { timeout: 1000 });
  await frame.locator(".brand").evaluate((brand) => {
    window.__vibewaitingMutationCount = 0;
    new MutationObserver((records) => { window.__vibewaitingMutationCount += records.length; }).observe(brand, { childList: true, subtree: true, attributes: true });
  });
  await push(page, state);
  await push(page, state);
  const mutations = await frame.locator(".brand").evaluate(() => window.__vibewaitingMutationCount);
  expect(mutations).toBe(0);
});

test("the expanded shell is a compact messenger dialog and closes back to the launcher", async ({ page }) => {
  const frame = await mountWidget(page);
  await push(page, readyState({ attached: { key: "one", harness: "codex", name: "widget", cwd: "/work", title: "Widget audit" }, transcript: [{ id: "u1", role: "user", text: "Review the widget", ts: null, truncated: false }] }));
  await frame.getByRole("button", { name: /Open agent chats/ }).click({ timeout: 1000 });
  await expect(frame.getByRole("dialog", { name: "Agent chats" })).toBeVisible({ timeout: 1000 });
  await frame.locator(".panel").evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const panel = await frame.locator(".vw-dialog").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(panel).toEqual({ width: 420, height: 480 });
  await frame.getByRole("button", { name: "Close" }).click({ timeout: 1000 });
  await expect(frame.getByRole("button", { name: /Open agent chats/ })).toBeFocused({ timeout: 1000 });
});

test("a stale mounted widget reports a dead bridge instead of opening forever", async ({ page }) => {
  const frame = await mountWidget(page);
  await push(page, readyState());
  await frame.getByRole("button", { name: /Open agent chats/ }).click({ timeout: 1000 });
  await frame.getByRole("button", { name: /Widget audit/ }).click({ timeout: 1000 });
  await expect(frame.getByRole("alert")).toContainText("Agent bridge disconnected", { timeout: 1000 });
});
