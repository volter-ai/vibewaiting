import { test, expect } from "@playwright/test";

async function expectTextEventually(locator, expected, attempts = 5) {
  let failure;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await expect(locator).toHaveText(expected, { timeout: 1_000 });
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

test("replays native Grok Build through an isolated browser sandbox with working HMR and gameplay", async ({ page }) => {
  await page.goto("http://127.0.0.1:4175/?conformance=http%3A%2F%2F127.0.0.1%3A4319", {
    waitUntil: "domcontentloaded",
    timeout: 1_000,
  });

  await expectTextEventually(page.locator("#agent-state"), "Complete");
  await expect(page.locator("#turn-count")).toHaveText("5", { timeout: 1_000 });
  await expect(page.locator("#hmr-count")).toHaveText("1", { timeout: 1_000 });
  await expect(page.locator("#iframe-loads")).toHaveText("1", { timeout: 1_000 });
  await expect(page.locator("#rendered-revision")).toHaveText("Rendered: pong-v1", { timeout: 1_000 });
  await expect(page.getByText("7 native model requests matched with zero drift")).toBeVisible({ timeout: 1_000 });

  const broker = page.locator("#preview").contentFrame();
  const game = broker.locator("#generated-preview").contentFrame();
  await expect(game.getByText("Press Space to serve", { exact: false })).toBeVisible({ timeout: 1_000 });
  const initialGameText = await game.locator("body").textContent({ timeout: 1_000 });

  const isolated = await game.locator("body").evaluate(() => {
    try {
      void window.top.document;
      return false;
    } catch {
      return true;
    }
  });
  expect(isolated).toBe(true);

  await game.locator("body").click({ timeout: 1_000 });
  await game.locator("body").press("Space", { timeout: 1_000 });
  await expect(game.locator("body")).not.toHaveText(initialGameText || "", { timeout: 1_000 });
});
