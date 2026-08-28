#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputRoot = resolve(repositoryRoot, "dist/browser-agent-spike");
const assetsRoot = resolve(outputRoot, "assets");
const index = readFileSync(resolve(outputRoot, "index.html"), "utf8");
const assets = readdirSync(assetsRoot);
const rhaiChunks = assets.filter((name) => /^grok-build-rhai-wasm-.*\.js$/u.test(name));
const workbench = assets.find((name) => /^workbench-.*\.js$/u.test(name));

if (rhaiChunks.length !== 1) {
  throw new Error(`Expected one lazy Grok workflow runtime chunk, found ${rhaiChunks.length}.`);
}
if (!workbench) throw new Error("Missing browser-agent workbench bundle.");
if (index.includes(rhaiChunks[0]) || index.includes("grok_workflow_rhai_wasm_bg")) {
  throw new Error("The 6 MiB Grok workflow WASM is eagerly referenced by index.html.");
}

const workbenchSource = readFileSync(resolve(assetsRoot, workbench), "utf8");
if (!workbenchSource.includes(rhaiChunks[0])) {
  throw new Error("The workbench no longer has a lazy route to the Grok workflow runtime.");
}
if (workbenchSource.includes("grok_workflow_rhai_wasm_bg")) {
  throw new Error("The Grok workflow WASM loader leaked back into the startup workbench chunk.");
}

console.log(`Verified lazy workflow runtime boundary: ${rhaiChunks[0]}.`);
