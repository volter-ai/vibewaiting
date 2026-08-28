import { test, expect } from "@playwright/test";

test("strictly replays an arbitrary long native Grok Build session", async ({ page, request }) => {
  test.skip(!process.env.GROK_LONG_CONFORMANCE_CORPUS, "Long corpus is opt-in.");
  test.setTimeout(30_000);
  const profile = await (await request.get("http://127.0.0.1:4319/__conformance__/driver-profile")).json();
  await page.goto("http://127.0.0.1:4175/?conformance=http%3A%2F%2F127.0.0.1%3A4319", {
    waitUntil: "domcontentloaded",
    timeout: 10_000,
  });
  try {
    await expect(page.locator("#agent-state")).toHaveText("Complete", { timeout: 20_000 });
  } catch (error) {
    console.error(`Browser trajectory at failure:\n${await page.locator("#trajectory").innerText()}`);
    throw error;
  }
  await expect(page.getByText(`${profile.modelRequests} native model requests matched with zero drift`, { exact: false })).toBeVisible();
});
