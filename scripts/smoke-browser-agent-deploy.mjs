#!/usr/bin/env node

const baseUrl = (process.argv[2] || process.env.BROWSER_AGENT_URL || "").replace(/\/+$/u, "");
const expectedVersion = process.env.BROWSER_AGENT_EXPECT_VERSION;

if (!baseUrl || !/^https?:\/\//u.test(baseUrl)) {
  console.error("Usage: npm run smoke:browser-agent -- https://browser-agent.example");
  process.exit(2);
}

async function request(path, init) {
  return fetch(`${baseUrl}${path}`, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    ...init,
  });
}

async function json(path, expectedStatus) {
  const response = await request(path, { headers: { Accept: "application/json" } });
  if (response.status !== expectedStatus) throw new Error(`${path} returned HTTP ${response.status}, expected ${expectedStatus}`);
  const payload = await response.json();
  return { response, payload };
}

try {
  const health = await json("/api/health", 200);
  if (health.payload.ok !== true || typeof health.payload.version !== "string") throw new Error("/api/health returned an invalid payload");
  if (expectedVersion && health.payload.version !== expectedVersion) {
    throw new Error(`/api/health reported version ${health.payload.version}, expected ${expectedVersion}`);
  }
  if (health.response.headers.get("X-Vibewaiting-Version") !== health.payload.version) {
    throw new Error("health version header and body do not match");
  }

  const ready = await json("/api/ready", 200);
  if (ready.payload.ready !== true || ready.payload.checks !== "passed") throw new Error("/api/ready did not pass all configuration checks");

  const unauthenticated = await json("/api/auth/status", 401);
  if (typeof unauthenticated.payload.error?.message !== "string") throw new Error("unauthenticated status response was malformed");

  const rejected = await request("/api/auth/device/start", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://cross-origin-smoke.invalid",
    },
    body: "{}",
  });
  if (rejected.status !== 403) throw new Error(`cross-origin mutation returned HTTP ${rejected.status}, expected 403`);

  const page = await request("/", { headers: { Accept: "text/html" } });
  if (!page.ok) throw new Error(`/ returned HTTP ${page.status}`);
  const csp = page.headers.get("Content-Security-Policy") ?? "";
  if (!csp.includes("frame-ancestors 'none'") || csp.includes("https://esm.sh")) {
    throw new Error("the deployed workbench CSP is missing isolation or still permits the removed CDN");
  }

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    version: health.payload.version,
    capabilities: ready.payload.capabilities,
  }));
} catch (error) {
  console.error(`browser-agent smoke FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
