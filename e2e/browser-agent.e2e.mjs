import { test, expect } from "@playwright/test";

test.skip(Boolean(process.env.GROK_LONG_CONFORMANCE_CORPUS), "The opt-in long corpus has its own generic assertions.");

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
    timeout: 10_000,
  });

  await expectTextEventually(page.locator("#agent-state"), "Complete");
  await expect(page.locator("#turn-count")).toHaveText("5", { timeout: 1_000 });
  await expect(page.locator("#hmr-count")).toHaveText("1", { timeout: 1_000 });
  await expect(page.locator("#iframe-loads")).toHaveText("1", { timeout: 1_000 });
  await expect(page.locator("#rendered-revision")).toHaveText("Rendered: pong-v1", { timeout: 5_000 });
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

  const externalFetch = await game.locator("body").evaluate(async () => {
    try {
      const response = await fetch("https://sandbox-network-denied.invalid/probe", {
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      return { ok: response.ok, status: response.status };
    } catch (error) {
      return { ok: false, status: 0, name: error instanceof Error ? error.name : "unknown" };
    }
  });
  expect(externalFetch.ok).toBe(false);
  expect([0, 403]).toContain(externalFetch.status);

  await game.locator("body").click({ timeout: 1_000 });
  await game.locator("body").press("Space", { timeout: 1_000 });
  await expect(game.locator("body")).not.toHaveText(initialGameText || "", { timeout: 1_000 });
});

test("renders native structured question and plan approval interactions", async ({ page }) => {
  await page.route("**/api/grok/bundle/archive", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: '{"error":{"message":"UI-only test"}}',
  }));
  await page.goto("http://127.0.0.1:4175/", { waitUntil: "domcontentloaded", timeout: 10_000 });

  await page.evaluate(() => {
    window.__grokQuestionResult = import("/src/grok-build-question-dialog.ts").then(({ askGrokUserQuestions }) => askGrokUserQuestions([
      {
        question: "Which checks?",
        options: [
          { label: "Tests (Recommended)", description: "Run the test suite", preview: "npm test" },
          { label: "Types", description: "Run TypeScript" },
        ],
        multi_select: true,
      },
    ], new AbortController().signal, { timeoutMs: 30_000 }));
  });
  await expect(page.getByRole("heading", { name: "Grok has a question" })).toBeVisible();
  await page.getByText("Tests (Recommended)", { exact: true }).click();
  await expect(page.locator(".grok-question-preview")).toHaveText("npm test");
  await page.getByText("Other", { exact: true }).click();
  await page.getByLabel("Other answer for Which checks?").fill("Also lint");
  await page.getByRole("button", { name: "Submit answers" }).click();
  await expect.poll(() => page.evaluate(() => window.__grokQuestionResult)).toBe('User has answered your questions: "Which checks?"="Tests (Recommended), Other" selected preview:\nnpm test user notes: Also lint. You can now continue with the user\'s answers in mind.');

  await page.evaluate(() => {
    window.__grokPlanEntry = import("/src/grok-build-plan-dialog.ts").then(({ approveGrokPlanEntry }) => approveGrokPlanEntry(new AbortController().signal));
  });
  await expect(page.getByRole("heading", { name: "Enter plan mode?" })).toBeVisible();
  await page.getByRole("button", { name: "Enter plan mode" }).click();
  await expect.poll(() => page.evaluate(() => window.__grokPlanEntry)).toBe(true);

  await page.evaluate(() => {
    window.__grokPlanExit = import("/src/grok-build-plan-dialog.ts").then(({ approveGrokPlanExit }) => approveGrokPlanExit("# Plan\n\n1. Build it.", new AbortController().signal));
  });
  await expect(page.getByRole("heading", { name: "Review implementation plan" })).toBeVisible();
  await expect(page.locator(".grok-plan-preview")).toContainText("Build it");
  await page.getByLabel("Plan revision feedback").fill("Add rollback steps");
  await page.getByRole("button", { name: "Request changes" }).click();
  await expect.poll(() => page.evaluate(() => window.__grokPlanExit)).toEqual({ outcome: "cancelled", feedback: "Add rollback steps" });
});
