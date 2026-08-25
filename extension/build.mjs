#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PANEL_CSS } from "../widget/styles.mjs";
import { createMobileIconPng } from "../mobile/icon-assets.mjs";

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
    options: "extension/options.ts",
  },
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
const mobileCss = await readFile(join(root, "mobile/styles.css"), "utf8");
await writeFile(join(mobileOutput, "app.css"), `${supercodeCss}\n${xtermCss}\n${terminalCss}\n${PANEL_CSS}\n${mobileCss}`, "utf8");
await cp(join(root, "mobile/index.html"), join(mobileOutput, "index.html"));
await cp(join(root, "mobile/install-metadata.html"), join(mobileOutput, "install-metadata.html"));
await cp(join(root, "mobile/manifest.webmanifest"), join(mobileOutput, "manifest.webmanifest"));
await cp(join(root, "mobile/service-worker.js"), join(mobileOutput, "service-worker.js"));
await writeFile(join(mobileOutput, "icon-192.png"), createMobileIconPng(192));
await writeFile(join(mobileOutput, "icon-512.png"), createMobileIconPng(512));
for (const name of ["manifest.json", "app.html", "options.html", "options.css"]) {
  await cp(join(source, name), join(output, name));
}

const assetNames = ["background.js", "content.js", "app.js", "options.js", "app.css"];
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
