#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { brandCss, brandHtml } from "../scripts/brand.mjs";
import { PANEL_CSS } from "../widget/styles.mjs";

// The Vibewaiting logo comes from the brand service at build time; brand art is
// never committed here. A failed fetch fails the build.
async function fetchLogoPng(size) {
  const url = `https://brand.volter.ai/logo/vibewaiting/png?size=${size}`;
  const response = await fetch(url);
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || !type.startsWith("image/png"))
    throw new Error(`${url} answered ${response.status} ${type}`);
  return Buffer.from(await response.arrayBuffer());
}

const root = fileURLToPath(new URL("../", import.meta.url));
const source = fileURLToPath(new URL("./", import.meta.url));
const output = fileURLToPath(new URL("../dist/extension/", import.meta.url));

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const browserBuild = {
  absWorkingDir: root,
  bundle: true,
  entryNames: "[name]",
  format: "esm",
  jsx: "automatic",
  jsxImportSource: "preact",
  sourcemap: false,
  logLevel: "warning",
  minify: true,
  outdir: output,
  platform: "browser",
  target: "chrome116",
};
await build({
  ...browserBuild,
  entryPoints: {
    background: "extension/background.ts",
    content: "extension/content.ts",
    offscreen: "extension/offscreen.ts",
    options: "extension/options.ts",
  },
});
// Classic scripts: the page's main-world surface, and the Playwright host (a
// sandboxed page has an opaque origin), where playwright-core is AlmostCDP's
// browser build of it.
await build({
  ...browserBuild,
  format: "iife",
  entryPoints: { surface: "extension/surface.ts" },
});
await build({
  ...browserBuild,
  format: "iife",
  entryPoints: { playwright: "extension/playwright.ts" },
  alias: { "playwright-core": "@volter/almostcdp/playwright" },
  // Playwright's page functions are sent as source; eval is theirs.
  logOverride: { "direct-eval": "silent" },
});

const mobileOutput = fileURLToPath(new URL("../dist/mobile/", import.meta.url));
await mkdir(mobileOutput, { recursive: true });
await build({
  ...browserBuild,
  entryPoints: { app: "mobile/app.tsx" },
  outdir: mobileOutput,
});
await build({
  ...browserBuild,
  chunkNames: "chunks/[name]-[hash]",
  entryPoints: { app: "extension/app.tsx" },
  splitting: true,
});

const supercodeCss = await readFile(fileURLToPath(import.meta.resolve("@volter-ai-dev/supercode-ui/styles.css")), "utf8");
const xtermCss = await readFile(fileURLToPath(import.meta.resolve("@xterm/xterm/css/xterm.css")), "utf8");
const terminalCss = await readFile(fileURLToPath(import.meta.resolve("@volter-ai-dev/supercode-terminal/ui/styles.css")), "utf8");
await writeFile(join(output, "app.css"), `${supercodeCss}\n${xtermCss}\n${terminalCss}\n${PANEL_CSS}`, "utf8");
// Stylesheet sources name the Volter brand's roles; the shipped copies carry resolved values only.
const mobileCss = brandCss(await readFile(join(root, "mobile/styles.css"), "utf8"));
await writeFile(join(mobileOutput, "app.css"), `${supercodeCss}\n${xtermCss}\n${terminalCss}\n${PANEL_CSS}\n${mobileCss}`, "utf8");
await writeFile(join(mobileOutput, "index.html"), brandHtml(await readFile(join(root, "mobile/index.html"), "utf8")), "utf8");
await cp(join(root, "mobile/install-metadata.html"), join(mobileOutput, "install-metadata.html"));
await cp(join(root, "mobile/manifest.webmanifest"), join(mobileOutput, "manifest.webmanifest"));
await cp(join(root, "mobile/service-worker.js"), join(mobileOutput, "service-worker.js"));
await writeFile(join(mobileOutput, "icon-192.png"), await fetchLogoPng(192));
await writeFile(join(mobileOutput, "icon-512.png"), await fetchLogoPng(512));
await writeFile(join(output, "options.css"), brandCss(await readFile(join(source, "options.css"), "utf8")), "utf8");
for (const name of ["manifest.json", "app.html", "offscreen.html", "options.html", "playwright.html"]) {
  await cp(join(source, name), join(output, name));
}
for (const size of [16, 32, 48, 128])
  await writeFile(join(output, `icon-${size}.png`), await fetchLogoPng(size));

const assetNames = [
  "background.js",
  "content.js",
  "surface.js",
  "offscreen.js",
  "playwright.js",
  "app.js",
  "options.js",
  "app.css",
  "icon-16.png",
  "icon-32.png",
  "icon-48.png",
  "icon-128.png",
];
const assetContents = await Promise.all(assetNames.map((name) => readFile(join(output, name))));
const mobileAssetNames = [
  "app.js",
  "app.css",
  "index.html",
  "install-metadata.html",
  "manifest.webmanifest",
  "service-worker.js",
  "icon-192.png",
  "icon-512.png",
];
const mobileAssetContents = await Promise.all(
  mobileAssetNames.map((name) => readFile(join(mobileOutput, name))),
);
const buildHash = createHash("sha256");
for (let index = 0; index < assetNames.length; index += 1) {
  buildHash.update(assetNames[index]);
  buildHash.update("\0");
  buildHash.update(assetContents[index]);
}
for (let index = 0; index < mobileAssetNames.length; index += 1) {
  buildHash.update(`mobile/${mobileAssetNames[index]}`);
  buildHash.update("\0");
  buildHash.update(mobileAssetContents[index]);
}
const buildId = buildHash.digest("hex").slice(0, 20);
await writeFile(join(output, "build-id.txt"), `${buildId}\n`, "utf8");

const assets = assetNames.map((name, index) => {
  const bytes = assetContents[index].byteLength;
  return `${name} ${(bytes / 1024).toFixed(1)} kB`;
});
process.stdout.write(`extension → ${output}\n  ${assets.join(" · ")} · build ${buildId}\n`);
