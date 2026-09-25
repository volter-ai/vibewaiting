#!/usr/bin/env node
// Writes dist/browser-tools.json: the schemas `vibewaiting mcp` lists, exactly as
// @playwright/mcp publishes them, from the playwright-core the extension's
// Playwright host is built from (AlmostCDP's browser build pins the same version).
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { tools } = require("playwright-core/lib/coreBundle");
const { z } = require("playwright-core/lib/utilsBundle");
const core = JSON.parse(await readFile(require.resolve("playwright-core/package.json"), "utf8")).version;
const almostcdp = JSON.parse(await readFile(fileURLToPath(new URL("../node_modules/@volter/almostcdp/package.json", import.meta.url)), "utf8"));
if (almostcdp.peerDependencies?.["playwright-core"] !== core)
  throw new Error(`playwright-core ${core} is not the ${almostcdp.peerDependencies?.["playwright-core"]} AlmostCDP ${almostcdp.version} bundles`);

const source = await readFile(fileURLToPath(new URL("../src/browser-tools.ts", import.meta.url)), "utf8");
const served = [...source.slice(source.indexOf("SERVED_BROWSER_TOOLS = ["), source.indexOf("] as const")).matchAll(/"(browser_[a-z_]+)"/g)]
  .map((match) => match[1]);
const all = tools.filteredTools({ browser: { launchOptions: {}, contextOptions: {} }, capabilities: [] });
const listed = served.map((name) => {
  const tool = all.find((candidate) => candidate.schema.name === name);
  if (!tool) throw new Error(`playwright-core ${core} has no core tool ${name}`);
  const readOnly = tool.schema.type === "readOnly" || tool.schema.type === "assertion";
  return {
    name,
    description: tool.schema.description,
    inputSchema: z.toJSONSchema(tool.schema.inputSchema),
    annotations: { title: tool.schema.title, readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true },
  };
});
await mkdir(fileURLToPath(new URL("../dist/", import.meta.url)), { recursive: true });
await writeFile(fileURLToPath(new URL("../dist/browser-tools.json", import.meta.url)),
  `${JSON.stringify({ playwrightCore: core, tools: listed }, null, 2)}\n`);
console.log(`dist/browser-tools.json: ${listed.length} tools from playwright-core ${core}`);
