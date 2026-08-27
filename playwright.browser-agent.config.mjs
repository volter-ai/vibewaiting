import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "browser-agent.e2e.mjs",
  timeout: 10_000,
  expect: { timeout: 1_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    actionTimeout: 1_000,
    browserName: "chromium",
    channel: "chrome",
    headless: true,
  },
  webServer: [
    {
      command: "node scripts/grok-conformance-proxy.mjs replay --corpus test/fixtures/grok-conformance/native-pong-complete-v1.jsonl --port 4319",
      url: "http://127.0.0.1:4319/__conformance__/driver-profile",
      reuseExistingServer: false,
      timeout: 10_000,
    },
    {
      command: "GROK_AUTH_FILE=test/fixtures/grok-conformance/auth.synthetic.json GROK_CONFORMANCE_BASE_URL=http://127.0.0.1:4319/browser/v1 npm run dev:browser-agent -- --host 127.0.0.1",
      url: "http://127.0.0.1:4175/",
      reuseExistingServer: false,
      timeout: 10_000,
    },
  ],
});
