import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import { buildSync, type Plugin as EsbuildPlugin } from "esbuild";
import { almostnodePlugin } from "almostnode/vite";
import { createGrokRelay } from "./grok-relay.js";
import { createCodexRelay } from "./codex-relay.js";
import {
  hardenSandboxServiceWorker,
  THREE_CORE_ASSET_PATH,
  THREE_MODULE_ASSET_PATH,
} from "./sandbox-service-worker-hardening.js";

const configDirectory = dirname(fileURLToPath(import.meta.url));
const almostnodeDist = resolve(configDirectory, "../../node_modules/almostnode/dist");
const runtimeWorkerName = "runtime-worker-D6Dmsis4.js";
const reactRefreshVirtualId = "\0vibewaiting-react-refresh-runtime";
const reactRefreshRuntimeModule = buildSync({
  entryPoints: [resolve(configDirectory, "../../node_modules/react-refresh/cjs/react-refresh-runtime.development.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
  define: { "process.env.NODE_ENV": JSON.stringify("development") },
}).outputFiles[0]!.text;
const threeModuleSource = readFileSync(resolve(configDirectory, "../../node_modules/three/build/three.module.js"), "utf8");
const threeCoreSource = readFileSync(resolve(configDirectory, "../../node_modules/three/build/three.core.js"), "utf8");
const invalidTypedArrayStatic = '__publicField(_BufferPolyfill, "BYTES_PER_ELEMENT", 1);';
const invalidTypedArraySourceField = "static readonly BYTES_PER_ELEMENT = 1;";
const remoteReactRefresh = "const RefreshRuntime = await import('${REACT_REFRESH_CDN}').then(m => m.default || m);";
const localReactRefresh = "const RefreshRuntime = window.parent.__VIBEWAITING_REACT_REFRESH_RUNTIME__;";

function patchAlmostnodeTypedArrayStatic(source: string, label: string): string {
  if (!source.includes(invalidTypedArrayStatic)) {
    throw new Error(`The installed almostnode ${label} Buffer shim changed; update the production adapter.`);
  }
  // Uint8Array already exposes this inherited, non-writable static. Vite's
  // production lowering turns Almostnode's redundant class field into a strict
  // assignment and Chrome correctly throws. Removing it preserves the value 1.
  return source.replace(invalidTypedArrayStatic, "/* inherited Uint8Array.BYTES_PER_ELEMENT */");
}

function patchAlmostnodeIndex(code: string): string {
  if (!code.includes(remoteReactRefresh)) {
    throw new Error("The installed almostnode React Refresh preamble changed; update the sandbox adapter.");
  }
  const workerUrl = new RegExp(
    `new URL\\(\\s*/\\* @vite-ignore \\*/\\s*"/assets/${runtimeWorkerName}",\\s*import\\.meta\\.url\\s*\\)`,
    "u",
  );
  if (!workerUrl.test(code)) {
    throw new Error("The installed almostnode runtime-worker reference changed; update the packaging adapter.");
  }
  return patchAlmostnodeTypedArrayStatic(
    code
      .replace(workerUrl, `"/assets/${runtimeWorkerName}"`)
      .replace(remoteReactRefresh, localReactRefresh),
    "main bundle",
  );
}

function optimizeAlmostnode(): EsbuildPlugin {
  return {
    name: "harden-almostnode-preview-runtime",
    setup(build) {
      build.onLoad({ filter: /almostnode\/dist\/index\.mjs$/ }, () => ({
        contents: patchAlmostnodeIndex(readFileSync(resolve(almostnodeDist, "index.mjs"), "utf8")),
        loader: "js",
      }));
    },
  };
}

function sandboxServiceWorker(): string {
  const source = readFileSync(resolve(almostnodeDist, "__sw__.js"), "utf8");
  return hardenSandboxServiceWorker(source);
}

/** Work around almostnode 0.2.14 not emitting its published runtime worker. */
function almostnodePublishedAssets(): Plugin {
  return {
    name: "almostnode-published-assets",
    enforce: "pre",
    resolveId(id) {
      if (id === "react-refresh/runtime-development") return reactRefreshVirtualId;
    },
    load(id) {
      if (id === reactRefreshVirtualId) return reactRefreshRuntimeModule;
    },
    transform(code, id) {
      if (id.split("?", 1)[0] === resolve(almostnodeDist, "../src/shims/stream.ts")) {
        if (!code.includes(invalidTypedArraySourceField)) {
          throw new Error("The installed almostnode source Buffer shim changed; update the production adapter.");
        }
        return code.replace(invalidTypedArraySourceField, "/* inherited Uint8Array.BYTES_PER_ELEMENT */");
      }
      if (id !== resolve(almostnodeDist, "index.mjs")) return;
      return patchAlmostnodeIndex(code);
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split("?", 1)[0];
        const trustedModule = pathname === THREE_MODULE_ASSET_PATH
          ? threeModuleSource
          : pathname === THREE_CORE_ASSET_PATH ? threeCoreSource : undefined;
        if (request.method === "GET" && trustedModule) {
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("Access-Control-Allow-Origin", "*");
          response.end(trustedModule);
          return;
        }
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
        fileName: THREE_MODULE_ASSET_PATH.replace(/^\//u, ""),
        source: threeModuleSource,
      });
      this.emitFile({
        type: "asset",
        fileName: THREE_CORE_ASSET_PATH.replace(/^\//u, ""),
        source: threeCoreSource,
      });
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
  plugins: [almostnodePublishedAssets(), almostnodePlugin(), createGrokRelay(), createCodexRelay()],
  resolve: {
    alias: {
      "node:zlib": resolve(almostnodeDist, "../src/shims/zlib.ts"),
    },
  },
  optimizeDeps: {
    force: true,
    esbuildOptions: {
      plugins: [optimizeAlmostnode()],
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4175,
    strictPort: true,
    allowedHosts: ["127.0.0.1", "localhost"],
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
