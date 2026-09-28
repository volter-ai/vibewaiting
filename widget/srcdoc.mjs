// Bundle an entry and its CSS into ONE self-contained srcdoc document: the window's whole app in a
// string, which Widget Shell mounts as the iframe's srcdoc.
import { build } from "esbuild";

/** A literal `</script>` inside the bundle would end the inline script early; `<\/script>` is the same JS string. */
const escapeScriptClose = (js) => js.replace(/<\/script>/gi, "<\\/script>");
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export async function buildSrcdoc({ entryPoints, css = "", title = "widget", jsxImportSource, minify = true, define }) {
  const result = await build({
    entryPoints: Array.isArray(entryPoints) ? entryPoints : [entryPoints],
    bundle: true,
    minify,
    format: "iife",
    write: false,
    jsx: "automatic",
    jsxImportSource,
    loader: { ".tsx": "tsx", ".ts": "ts", ".jsx": "jsx" },
    define,
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error("esbuild produced no output for the widget");
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
    `<style>${css}</style></head><body><div id="app"></div><script>${escapeScriptClose(output.text)}</script></body></html>`;
  return { html };
}
