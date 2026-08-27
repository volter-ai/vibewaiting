import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import { almostnodePlugin } from "almostnode/vite";
import { createGrokRelay } from "./grok-relay.js";

const configDirectory = dirname(fileURLToPath(import.meta.url));
const almostnodeDist = resolve(configDirectory, "../../node_modules/almostnode/dist");
const runtimeWorkerName = "runtime-worker-D6Dmsis4.js";
const invalidTypedArrayStatic = '__publicField(_BufferPolyfill, "BYTES_PER_ELEMENT", 1);';
const invalidTypedArraySourceField = "static readonly BYTES_PER_ELEMENT = 1;";

function patchAlmostnodeTypedArrayStatic(source: string, label: string): string {
  if (!source.includes(invalidTypedArrayStatic)) {
    throw new Error(`The installed almostnode ${label} Buffer shim changed; update the production adapter.`);
  }
  // Uint8Array already exposes this inherited, non-writable static. Vite's
  // production lowering turns Almostnode's redundant class field into a strict
  // assignment and Chrome correctly throws. Removing it preserves the value 1.
  return source.replace(invalidTypedArrayStatic, "/* inherited Uint8Array.BYTES_PER_ELEMENT */");
}

function sandboxServiceWorker(): string {
  const source = readFileSync(resolve(almostnodeDist, "__sw__.js"), "utf8");
  const initLine = "mainPort.onmessage = handleMainMessage;";
  if (!source.includes(initLine)) {
    throw new Error("The installed almostnode service-worker init protocol changed; update the sandbox adapter.");
  }
  return source.replace(initLine, `${initLine}\n    mainPort.postMessage({ type: 'bridge-ready' });`);
}

/** Work around almostnode 0.2.14 not emitting its published runtime worker. */
function almostnodePublishedAssets(): Plugin {
  return {
    name: "almostnode-published-assets",
    enforce: "pre",
    transform(code, id) {
      if (id.split("?", 1)[0] === resolve(almostnodeDist, "../src/shims/stream.ts")) {
        if (!code.includes(invalidTypedArraySourceField)) {
          throw new Error("The installed almostnode source Buffer shim changed; update the production adapter.");
        }
        return code.replace(invalidTypedArraySourceField, "/* inherited Uint8Array.BYTES_PER_ELEMENT */");
      }
      if (id !== resolve(almostnodeDist, "index.mjs")) return;
      const workerUrl = new RegExp(
        `new URL\\(\\s*/\\* @vite-ignore \\*/\\s*"/assets/${runtimeWorkerName}",\\s*import\\.meta\\.url\\s*\\)`,
        "u",
      );
      if (!workerUrl.test(code)) {
        throw new Error("The installed almostnode runtime-worker reference changed; update the packaging adapter.");
      }
      return patchAlmostnodeTypedArrayStatic(
        code.replace(workerUrl, `"/assets/${runtimeWorkerName}"`),
        "main bundle",
      );
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.method !== "GET" || request.url?.split("?", 1)[0] !== "/__sw__.js") return next();
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(sandboxServiceWorker());
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: `assets/${runtimeWorkerName}`,
        source: patchAlmostnodeTypedArrayStatic(
          readFileSync(resolve(almostnodeDist, "assets", runtimeWorkerName), "utf8"),
          "runtime worker",
        ),
      });
      this.emitFile({
        type: "asset",
        fileName: "__sw__.js",
        source: sandboxServiceWorker(),
      });
    },
  };
}

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [almostnodePublishedAssets(), almostnodePlugin(), createGrokRelay()],
  resolve: {
    alias: {
      "node:zlib": resolve(almostnodeDist, "../src/shims/zlib.ts"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4175,
    strictPort: true,
    allowedHosts: ["127.0.0.1", "localhost", "sandbox.localhost"],
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
  },
  build: {
    outDir: "../../dist/browser-agent-spike",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        workbench: resolve(configDirectory, "index.html"),
        sandbox: resolve(configDirectory, "sandbox.html"),
      },
    },
  },
});
