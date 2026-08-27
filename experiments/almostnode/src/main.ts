import { VirtualFS, ViteDevServer, getServerBridge } from "almostnode";

const VIRTUAL_PORT = 4174;
const THREE_VERSION = "0.180.0";

const preview = document.querySelector<HTMLIFrameElement>("#preview")!;
const toggleButton = document.querySelector<HTMLButtonElement>("#toggle")!;
const resetButton = document.querySelector<HTMLButtonElement>("#reset")!;
const runtimeStatus = document.querySelector<HTMLElement>("#runtime-status")!;
const renderedRevision = document.querySelector<HTMLElement>("#rendered-revision")!;
const iframeLoads = document.querySelector<HTMLElement>("#iframe-loads")!;
const hmrStatus = document.querySelector<HTMLElement>("#hmr-status")!;
const logElement = document.querySelector<HTMLElement>("#log")!;

const vfs = new VirtualFS();
const server = new ViteDevServer(vfs, { port: VIRTUAL_PORT, root: "/" });
const bridge = getServerBridge();
let revision: "A" | "B" = "A";
let iframeLoadCount = 0;

function log(message: string): void {
  const stamp = new Date().toISOString().slice(11, 23);
  logElement.textContent += `${stamp}  ${message}\n`;
  logElement.scrollTop = logElement.scrollHeight;
}

function gameSource(nextRevision: "A" | "B"): string {
  const color = nextRevision === "A" ? "#5eead4" : "#fb7185";
  const shape = nextRevision === "A"
    ? "new THREE.BoxGeometry(1.35, 1.35, 1.35)"
    : "new THREE.TorusKnotGeometry(0.72, 0.24, 128, 20)";

  return `
import * as THREE from "three";

window.__almostnodeThreeCleanup?.();

document.body.innerHTML = \`
  <canvas id="game"></canvas>
  <div class="badge">Virtual project revision ${nextRevision}</div>
\`;
document.documentElement.dataset.revision = "${nextRevision}";

const renderer = new THREE.WebGLRenderer({
  canvas: document.querySelector("#game"),
  antialias: true,
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color("#080b13");

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
camera.position.set(0, 0.25, 4.2);

const mesh = new THREE.Mesh(
  ${shape},
  new THREE.MeshStandardMaterial({ color: "${color}", roughness: 0.28, metalness: 0.18 }),
);
scene.add(mesh);
scene.add(new THREE.HemisphereLight("#ffffff", "#172554", 2.1));

const key = new THREE.DirectionalLight("#ffffff", 2.5);
key.position.set(3, 4, 2);
scene.add(key);

let frame = 0;
function resize() {
  const width = innerWidth;
  const height = innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function render(time) {
  mesh.rotation.x = time * 0.00035;
  mesh.rotation.y = time * 0.00065;
  renderer.render(scene, camera);
  frame = requestAnimationFrame(render);
}

addEventListener("resize", resize);
resize();
frame = requestAnimationFrame(render);

window.__almostnodeThreeCleanup = () => {
  cancelAnimationFrame(frame);
  removeEventListener("resize", resize);
  mesh.geometry.dispose();
  mesh.material.dispose();
  renderer.dispose();
};

parent.postMessage({ type: "almostnode-three-rendered", revision: "${nextRevision}" }, "*");
console.log("[three-spike] rendered revision ${nextRevision}");
`;
}

function seedProject(): void {
  vfs.mkdirSync("/src", { recursive: true });
  vfs.writeFileSync(
    "/index.html",
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script type="importmap">
      { "imports": { "three": "https://esm.sh/three@${THREE_VERSION}" } }
    </script>
    <style>
      * { box-sizing: border-box; }
      html, body, #game { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body { background: #080b13; color: white; font: 600 13px/1.2 system-ui, sans-serif; }
      #game { display: block; }
      .badge {
        position: fixed; top: 14px; left: 14px; padding: 8px 11px; border-radius: 999px;
        background: rgb(15 23 42 / 82%); border: 1px solid rgb(148 163 184 / 30%);
        backdrop-filter: blur(12px);
      }
    </style>
  </head>
  <body><script type="module" src="./src/main.js"></script></body>
</html>`,
  );
  vfs.writeFileSync("/src/main.js", gameSource(revision));
}

const httpServer = {
  listening: true,
  address: () => ({ port: VIRTUAL_PORT, address: "0.0.0.0", family: "IPv4" }),
  async handleRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: unknown,
  ) {
    return server.handleRequest(method, url, headers, body as never);
  },
};

server.on("hmr-update", (update: unknown) => {
  const event = update as { path?: string; type?: string };
  hmrStatus.textContent = `${event.type ?? "unknown"}: ${event.path ?? "unknown"}`;
  log(`HMR emitted ${JSON.stringify(update)}`);
});

window.addEventListener("message", (event) => {
  if (event.source !== preview.contentWindow || event.data?.type !== "almostnode-three-rendered") {
    return;
  }

  renderedRevision.textContent = event.data.revision;
  log(`Preview rendered revision ${event.data.revision}`);
});

toggleButton.addEventListener("click", () => {
  revision = revision === "A" ? "B" : "A";
  const started = performance.now();
  vfs.writeFileSync("/src/main.js", gameSource(revision));
  log(`Wrote /src/main.js revision ${revision} in ${(performance.now() - started).toFixed(1)}ms`);
});

resetButton.addEventListener("click", () => {
  revision = "A";
  vfs.writeFileSync("/src/main.js", gameSource(revision));
  log("Reset /src/main.js to revision A");
});

async function start(): Promise<void> {
  try {
    seedProject();
    log("Seeded Three.js project in VirtualFS");

    await bridge.initServiceWorker();
    log("almostnode service worker is active");

    bridge.registerServer(httpServer, VIRTUAL_PORT);
    server.start();
    log(`Virtual dev server registered on port ${VIRTUAL_PORT}`);

    preview.addEventListener("load", () => {
      iframeLoadCount += 1;
      iframeLoads.textContent = String(iframeLoadCount);
      if (preview.contentWindow) {
        server.setHMRTarget(preview.contentWindow);
        log("Preview connected as the HMR target");
      }
    });
    preview.src = `${bridge.getServerUrl(VIRTUAL_PORT)}/`;

    runtimeStatus.textContent = "Ready";
    toggleButton.disabled = false;
    resetButton.disabled = false;
  } catch (error) {
    runtimeStatus.textContent = "Failed";
    log(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    console.error(error);
  }
}

void start();
