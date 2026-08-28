#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const WORKER_NAME = "vibewaiting-browser-agent";
const SANDBOX_NAME = "vibewaiting-browser-agent-sandbox";
const WORKBENCH_URL = (process.env.BROWSER_AGENT_URL || "https://vibewaiting-browser-agent.aaron-0ed.workers.dev").replace(/\/+$/u, "");
const SANDBOX_URL = (process.env.BROWSER_AGENT_SANDBOX_URL || "https://vibewaiting-browser-agent-sandbox.aaron-0ed.workers.dev").replace(/\/+$/u, "");
const dryRun = process.argv.includes("--dry-run");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...options.env },
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  return result.stdout ?? "";
}

function currentVersion(config) {
  const args = ["wrangler", "deployments", "list", "--json"];
  if (config) args.push("--config", config);
  const deployments = JSON.parse(run("npx", args, { capture: true }));
  const latest = [...deployments].sort((left, right) => Date.parse(left.created_on) - Date.parse(right.created_on)).at(-1);
  return latest?.versions?.find((version) => version.percentage === 100)?.version_id
    ?? latest?.versions?.[0]?.version_id;
}

function rollback(name, config, version, reason) {
  if (!version) return;
  const args = ["wrangler", "rollback", version, "--name", name, "--yes", "--message", reason];
  if (config) args.push("--config", config);
  run("npx", args);
}

async function sandboxSmoke() {
  let lastFailure = "sandbox did not respond";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(`${SANDBOX_URL}/sandbox.html`, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      const csp = response.headers.get("Content-Security-Policy") ?? "";
      if (response.ok && csp.includes(`frame-ancestors ${WORKBENCH_URL}`) && csp.includes("default-src 'none'")) return;
      lastFailure = `sandbox returned HTTP ${response.status} or an invalid CSP`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`sandbox smoke failed: ${lastFailure}`);
}

async function workbenchSmoke(version) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = spawnSync(process.execPath, ["scripts/smoke-browser-agent-deploy.mjs", WORKBENCH_URL], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        BROWSER_AGENT_EXPECT_VERSION: version,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
    });
    if (result.status === 0) {
      process.stdout.write(result.stdout);
      return;
    }
    lastError = result.stderr || result.stdout;
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(String(lastError || "workbench smoke failed").trim());
}

const status = run("git", ["status", "--porcelain"], { capture: true }).trim();
if (!dryRun && status) throw new Error("Refusing to deploy a dirty worktree. Commit and verify the exact deployment revision first.");
const revision = run("git", ["rev-parse", "--short=12", "HEAD"], { capture: true }).trim();
const buildEnvironment = { VITE_SANDBOX_ORIGIN: SANDBOX_URL };

// Keep browser E2E on its local loopback origin, then rebuild the exact static
// artifact with the separately deployed production sandbox origin.
run("npm", ["run", "check:browser-agent"]);
run("npm", ["run", "build:browser-agent"], { env: buildEnvironment });

if (dryRun) {
  run("npx", ["wrangler", "deploy", "--dry-run", "--outdir", "/tmp/vibewaiting-main-dry-run"]);
  run("npx", ["wrangler", "deploy", "--dry-run", "--config", "wrangler.sandbox.jsonc", "--outdir", "/tmp/vibewaiting-sandbox-dry-run"]);
  console.log(JSON.stringify({ ok: true, dryRun: true, revision }));
  process.exit(0);
}

const previousMain = currentVersion();
const previousSandbox = currentVersion("wrangler.sandbox.jsonc");
let sandboxDeployed = false;
let mainDeployed = false;

try {
  run("npx", [
    "wrangler", "deploy", "--config", "wrangler.sandbox.jsonc", "--keep-vars",
    "--tag", revision, "--message", `vibewaiting ${revision} sandbox`,
  ]);
  sandboxDeployed = true;
  await sandboxSmoke();

  run("npx", [
    "wrangler", "deploy", "--keep-vars", "--tag", revision,
    "--message", `vibewaiting ${revision} workbench`,
  ]);
  mainDeployed = true;
  const deployedVersion = currentVersion();
  if (!deployedVersion || deployedVersion === previousMain) throw new Error("Cloudflare did not report a new workbench version after deployment.");
  await workbenchSmoke(deployedVersion);
  console.log(JSON.stringify({
    ok: true,
    revision,
    workbenchVersion: deployedVersion,
    sandboxVersion: currentVersion("wrangler.sandbox.jsonc"),
  }));
} catch (error) {
  console.error(`deployment gate failed: ${error instanceof Error ? error.message : String(error)}`);
  if (mainDeployed) {
    try {
      rollback(WORKER_NAME, undefined, previousMain, `Automatic rollback after failed ${revision} smoke`);
    } catch (rollbackError) {
      console.error(`workbench rollback FAILED: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
  }
  if (sandboxDeployed) {
    try {
      rollback(SANDBOX_NAME, "wrangler.sandbox.jsonc", previousSandbox, `Automatic rollback after failed ${revision} smoke`);
    } catch (rollbackError) {
      console.error(`sandbox rollback FAILED: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
  }
  process.exitCode = 1;
}
