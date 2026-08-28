import { test, expect } from "@playwright/test";

test.skip(Boolean(process.env.GROK_LONG_CONFORMANCE_CORPUS), "The opt-in long corpus has its own generic assertions.");

test.afterEach(async ({ page, context }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const frames = await Promise.all(page.frames().map(async (frame) => {
    let serviceWorker;
    if (frame.url().includes("sandbox.")) {
      serviceWorker = await frame.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
        return {
          controller: navigator.serviceWorker.controller?.state,
          active: registration?.active?.state,
          waiting: registration?.waiting?.state,
          installing: registration?.installing?.state,
        };
      }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    }
    return { url: frame.url(), serviceWorker };
  }));
  console.error(JSON.stringify({
    event: "browser_agent_failure_state",
    runtimeStatus: await page.locator("#runtime-status").textContent().catch(() => undefined),
    agentState: await page.locator("#agent-state").textContent().catch(() => undefined),
    serviceWorkers: context.serviceWorkers().map((worker) => worker.url()),
    frames,
  }));
});

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

async function stubAuthenticatedStartup(page, archiveMessage) {
  await page.route("**/api/grok/models", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: '{"data":[{"id":"grok-4.6","model":"grok-4.6","context_window":500000}]}',
  }));
  await page.route("**/api/grok/settings", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: '{"default_model":"grok-4.6"}',
  }));
  await page.route("**/api/grok/bundle/archive", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ error: { message: archiveMessage } }),
  }));
}

test("replays native Grok Build through an isolated browser sandbox with working HMR and gameplay", async ({ page }) => {
  const eagerWorkflowRuntimeRequests = [];
  page.on("request", (request) => {
    if (/grok-build-rhai-wasm|grok_workflow_rhai_wasm/iu.test(request.url())) {
      eagerWorkflowRuntimeRequests.push(request.url());
    }
  });
  await page.goto("http://127.0.0.1:4175/?conformance=http%3A%2F%2F127.0.0.1%3A4319", {
    waitUntil: "domcontentloaded",
    timeout: 10_000,
  });

  await expectTextEventually(page.locator("#agent-state"), "Complete", 12);
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
  expect(eagerWorkflowRuntimeRequests).toEqual([]);
});

test("renders native structured question and plan approval interactions", async ({ page }) => {
  await stubAuthenticatedStartup(page, "UI-only test");
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

  await page.evaluate(() => {
    window.__grokPermission = import("/src/grok-build-permission-dialog.ts").then(({ requestGrokBuildToolPermission }) => requestGrokBuildToolPermission({
      toolCallId: "edit-1",
      toolName: "write",
      kind: "edit",
      detail: "/src/game.ts",
      input: { file_path: "/src/game.ts" },
    }, new AbortController().signal));
  });
  await expect(page.getByRole("heading", { name: "Allow edit to /src/game.ts?" })).toBeVisible();
  await expect(page.locator(".grok-permission-preview")).toHaveText("/src/game.ts");
  await page.getByRole("button", { name: "Yes, allow all edits during this session" }).click();
  await expect.poll(() => page.evaluate(() => window.__grokPermission)).toBe("allow-edits-session");

  await page.evaluate(() => {
    window.__grokPermission = import("/src/grok-build-permission-dialog.ts").then(({ requestGrokBuildToolPermission }) => requestGrokBuildToolPermission({
      toolCallId: "mcp-1",
      toolName: "use_tool",
      kind: "mcp",
      detail: "linear__list_issues",
      input: { tool_name: "linear__list_issues" },
    }, new AbortController().signal));
  });
  await page.getByRole("button", { name: "Always allow all tools from linear" }).click();
  await expect.poll(() => page.evaluate(() => window.__grokPermission)).toBe("allow-mcp-server");

  await page.getByRole("button", { name: "MCP", exact: true }).click();
  await expect(page.getByRole("heading", { name: "MCP servers" })).toBeVisible();
  await expect(page.getByText("No MCP servers are configured.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("heading", { name: "MCP servers" })).not.toBeVisible();
});

test("commits browser projects across reload and recovers the prior verified snapshot", async ({ page }) => {
  await stubAuthenticatedStartup(page, "storage test");
  await page.goto("http://127.0.0.1:4175/", { waitUntil: "domcontentloaded", timeout: 10_000 });
  await expect(page.locator("#runtime-status")).toContainText("Browser sandbox ready", { timeout: 10_000 });

  const recovered = await page.evaluate(async () => {
    const storage = await import("/src/browser-project-store.ts");
    const snapshot = (name) => ({
      files: [
        { path: "/", type: "directory" },
        { path: `/${name}.txt`, type: "file", content: btoa(name) },
      ],
    });
    await storage.clearBrowserProject();
    await storage.saveBrowserProject({ toSnapshot: () => snapshot("first") });
    await storage.saveBrowserProject({ toSnapshot: () => snapshot("second") });

    await new Promise((resolve, reject) => {
      const open = indexedDB.open("vibewaiting-browser-agent", 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("projects", "readwrite");
        tx.objectStore("projects").put({ corrupted: true }, "default");
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
    const messages = [];
    const value = await storage.loadBrowserProject((message) => messages.push(message));
    await storage.saveBrowserProject({ toSnapshot: () => snapshot("third") });
    return { paths: value.files.map((entry) => entry.path), messages };
  });
  expect(recovered.paths).toContain("/first.txt");
  expect(recovered.messages).toHaveLength(1);

  await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
  await expect(page.locator("#runtime-status")).toContainText("Browser sandbox ready", { timeout: 10_000 });
  const persisted = await page.evaluate(async () => {
    const storage = await import("/src/browser-project-store.ts");
    const value = await storage.loadBrowserProject();
    const external = {
      files: [
        { path: "/", type: "directory" },
        { path: "/external.txt", type: "file", content: btoa("external") },
      ],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(external));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    let binary = "";
    for (const byte of digest) binary += String.fromCharCode(byte);
    const checksum = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    await new Promise((resolve, reject) => {
      const open = indexedDB.open("vibewaiting-browser-agent", 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("projects", "readwrite");
        tx.objectStore("projects").put({ storageVersion: 1, savedAt: Date.now(), checksum, payload: external }, "default");
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
    let conflict = "";
    try {
      await storage.saveBrowserProject({ toSnapshot: () => value });
    } catch (error) {
      conflict = error instanceof Error ? error.message : String(error);
    }
    const conflictCopy = await storage.loadBrowserProjectConflict();
    await storage.clearBrowserProject();
    return {
      paths: value.files.map((entry) => entry.path),
      conflict,
      conflictPaths: conflictCopy.files.map((entry) => entry.path),
    };
  });
  expect(persisted.paths).toContain("/third.txt");
  expect(persisted.conflict).toContain("changed in another tab");
  expect(persisted.conflictPaths).toContain("/third.txt");
});

test("persists MCP OAuth credentials with native stale-writer protection", async ({ page }) => {
  await stubAuthenticatedStartup(page, "MCP credential storage test");
  await page.goto("http://127.0.0.1:4175/", { waitUntil: "domcontentloaded", timeout: 10_000 });
  const result = await page.evaluate(async () => {
    const { GrokBuildIndexedDbMcpCredentialStore } = await import("/src/grok-build-mcp-credential-store.ts");
    const key = "calendar:https://mcp.example.test/";
    const credentials = (accessToken, tokenReceivedAt) => ({
      clientId: "browser-client",
      accessToken,
      refreshToken: `${accessToken}-refresh`,
      grantedScopes: ["calendar.read"],
      redirectUri: `${location.origin}/mcp-oauth-callback.html`,
      tokenReceivedAt,
      metadata: {
        authorizationEndpoint: "https://auth.example.test/authorize",
        tokenEndpoint: "https://auth.example.test/token",
      },
    });
    const first = new GrokBuildIndexedDbMcpCredentialStore();
    await first.clearAll();
    await first.save(key, credentials("newer", 20));
    const second = new GrokBuildIndexedDbMcpCredentialStore();
    const afterReload = await second.load(key);
    await second.save(key, credentials("stale", 10));
    const afterStaleWrite = await first.load(key);
    await second.save(key, credentials("newest", 30));
    const afterNewWrite = await first.load(key);
    await first.clear(key);
    return {
      afterReload: afterReload?.accessToken,
      afterStaleWrite: afterStaleWrite?.accessToken,
      afterNewWrite: afterNewWrite?.accessToken,
      cleared: await second.load(key),
    };
  });
  expect(result).toEqual({
    afterReload: "newer",
    afterStaleWrite: "newer",
    afterNewWrite: "newest",
    cleared: undefined,
  });
});
