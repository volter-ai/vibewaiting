import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.mjs",
  timeout: 10_000,
  expect: { timeout: 1000 },
  use: {
    actionTimeout: 1000,
    browserName: "chromium",
    headless: true,
  },
});
