#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PANEL_CSS } from "../widget/styles.mjs";

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
await build({
  ...browserBuild,
  chunkNames: "chunks/[name]-[hash]",
  entryPoints: { app: "extension/app.tsx" },
  splitting: true,
});

const supercodeCss = await readFile(fileURLToPath(import.meta.resolve("@volter-ai-dev/supercode-ui/styles.css")), "utf8");
const xtermCss = await readFile(fileURLToPath(import.meta.resolve("@xterm/xterm/css/xterm.css")), "utf8");
await writeFile(join(output, "app.css"), `${supercodeCss}\n${xtermCss}\n${PANEL_CSS}`, "utf8");
for (const name of ["manifest.json", "app.html", "options.html", "options.css"]) {
  await cp(join(source, name), join(output, name));
}

const assets = await Promise.all(["background.js", "content.js", "app.js", "options.js", "app.css"].map(async (name) => {
  const bytes = (await readFile(join(output, name))).byteLength;
  return `${name} ${(bytes / 1024).toFixed(1)} kB`;
}));
process.stdout.write(`extension → ${output}\n  ${assets.join(" · ")}\n`);
