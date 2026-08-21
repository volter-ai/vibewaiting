#!/usr/bin/env node
// Bundles `entry.tsx` + the shell/panel CSS into ONE self-contained srcdoc document at
// `dist/widget.html` — the artifact `WidgetHost.attach({ html })` injects. Run directly
// (`node widget/build.mjs`) or call `buildWidget()`; the CLI calls it when `dist/widget.html` is
// missing, which is why `esbuild` is a real dependency here rather than a devDependency.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSrcdoc } from "lucarne/widget/build";
import { PANEL_CSS } from "./styles.mjs";

/** `dist/widget.html`, resolved from THIS file — correct from any cwd. */
export const WIDGET_HTML_PATH = fileURLToPath(new URL("../dist/widget.html", import.meta.url));

export async function buildWidget({ outFile = WIDGET_HTML_PATH, minify = true } = {}) {
  const supercodeUiCss = await readFile(fileURLToPath(import.meta.resolve("@volter-ai-dev/supercode-ui/styles.css")), "utf8");
  const { html } = await buildSrcdoc({
    entryPoints: fileURLToPath(new URL("./entry.tsx", import.meta.url)),
    css: supercodeUiCss + PANEL_CSS,
    title: "vibewaiting",
    jsxImportSource: "preact",
    minify,
  });
  await mkdir(fileURLToPath(new URL(".", pathToFileURL(outFile))), { recursive: true });
  await writeFile(outFile, html, "utf8");
  return { outFile, bytes: Buffer.byteLength(html, "utf8") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { outFile, bytes } = await buildWidget();
  console.log(`widget → ${outFile} (${(bytes / 1024).toFixed(1)} kB)`);
}
