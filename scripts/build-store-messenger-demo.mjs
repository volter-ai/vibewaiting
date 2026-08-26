#!/usr/bin/env node
// Builds the reproducible, sanitized messenger artwork fixture into /tmp. The generated page uses
// the production messenger bundle and production component CSS; only the ordinary background page
// and demo session data are synthetic.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PANEL_CSS } from "../widget/styles.mjs";

const output = "/tmp/vibewaiting-store-messenger-demo";
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

await build({
  absWorkingDir: fileURLToPath(new URL("../", import.meta.url)),
  bundle: true,
  entryPoints: { messenger: "scripts/store-messenger-demo.tsx" },
  format: "esm",
  jsx: "automatic",
  jsxImportSource: "preact",
  minify: true,
  outdir: output,
  platform: "browser",
  target: "chrome116",
});

const supercodeCss = await readFile(
  new URL(import.meta.resolve("@volter-ai-dev/supercode-ui/styles.css")),
  "utf8",
);
await writeFile(join(output, "app.css"), `${supercodeCss}\n${PANEL_CSS}`, "utf8");
await writeFile(
  join(output, "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Vibewaiting messenger artwork fixture</title>
    <link rel="stylesheet" href="./app.css">
    <style>
      :root { color-scheme:light; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
      * { box-sizing:border-box }
      body { min-width:1280px; min-height:800px; margin:0; overflow:hidden; color:#20201e; background:#f4f4f1 }
      .demo-nav { display:flex; height:62px; align-items:center; gap:34px; padding:0 48px; border-bottom:1px solid #deded8; background:rgba(255,255,255,.76) }
      .demo-brand { margin-right:auto; font-size:14px; font-weight:760; letter-spacing:-.01em }
      .demo-nav span:not(.demo-brand) { color:#777772; font-size:12px; font-weight:600 }
      .demo-main { width:730px; padding:74px 0 0 82px }
      .demo-kicker { margin:0 0 13px; color:#73736e; font-size:11px; font-weight:750; letter-spacing:.09em; text-transform:uppercase }
      h1 { max-width:600px; margin:0; font-size:42px; line-height:1.08; letter-spacing:-.045em }
      .demo-lede { max-width:570px; margin:16px 0 34px; color:#6b6b66; font-size:17px; line-height:1.55 }
      .demo-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:13px; max-width:620px }
      .demo-card { min-height:120px; padding:18px; border:1px solid #ddddD7; border-radius:12px; background:rgba(255,255,255,.62) }
      .demo-card strong { display:block; margin-bottom:8px; font-size:13px }
      .demo-card p { margin:0; color:#777772; font-size:12px; line-height:1.5 }
      .demo-progress { display:flex; align-items:center; gap:8px; margin-top:18px; color:#5f5f5a; font-size:11px; font-weight:650 }
      .demo-progress::before { width:7px; height:7px; border-radius:50%; background:#62a277; content:"" }
      #app { position:fixed; right:34px; bottom:31px; width:390px; height:667px; overflow:hidden; border:1px solid rgba(28,28,25,.16); border-radius:12px; background:#fff; box-shadow:0 24px 70px rgba(30,30,26,.19),0 3px 12px rgba(30,30,26,.08) }
    </style>
  </head>
  <body>
    <nav class="demo-nav" aria-label="Demo site navigation">
      <span class="demo-brand">Launchpad</span><span>Projects</span><span>Releases</span><span>Docs</span>
    </nav>
    <main class="demo-main">
      <p class="demo-kicker">Release workspace</p>
      <h1>Prepare the public release</h1>
      <p class="demo-lede">Coordinate the final product, documentation, and security checks without leaving the page you are reviewing.</p>
      <section class="demo-grid" aria-label="Release checklist">
        <article class="demo-card"><strong>Product review</strong><p>Verify the messenger, terminal, and remote-access flows in a clean browser profile.</p><span class="demo-progress">In progress</span></article>
        <article class="demo-card"><strong>Launch collateral</strong><p>Review the public documentation and sanitized store artwork at full size.</p><span class="demo-progress">Ready</span></article>
      </section>
    </main>
    <div id="app"></div>
    <script type="module" src="./messenger.js"></script>
  </body>
</html>`,
  "utf8",
);

process.stdout.write(`${output}/index.html\n`);
