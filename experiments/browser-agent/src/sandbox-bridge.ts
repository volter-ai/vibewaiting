import { SANDBOX_CHANNEL, type SandboxEnvelope } from "./sandbox-protocol.js";
import ReactRefreshRuntime from "react-refresh/runtime-development";

declare global {
  interface Window {
    __VIBEWAITING_REACT_REFRESH_RUNTIME__?: typeof ReactRefreshRuntime;
  }
}

Object.defineProperty(window, "__VIBEWAITING_REACT_REFRESH_RUNTIME__", {
  configurable: false,
  enumerable: false,
  value: ReactRefreshRuntime,
  writable: false,
});

const parameters = new URLSearchParams(location.search);
const parentOrigin = new URL(parameters.get("parentOrigin") || "").origin;
const nonce = parameters.get("nonce") || "";
const virtualPort = Number.parseInt(parameters.get("port") || "", 10);
const preview = document.querySelector<HTMLIFrameElement>("#generated-preview")!;
const SERVICE_WORKER_TIMEOUT_MS = 10_000;

if (!nonce || !Number.isSafeInteger(virtualPort) || virtualPort < 1 || virtualPort > 65_535) {
  throw new Error("Invalid sandbox bootstrap parameters.");
}

function send(type: SandboxEnvelope["type"], payload?: unknown): void {
  window.parent.postMessage({ channel: SANDBOX_CHANNEL, nonce, type, payload } satisfies SandboxEnvelope, parentOrigin);
}

async function activateServiceWorker(): Promise<ServiceWorker> {
  const registration = await navigator.serviceWorker.register("/__sw__.js", { scope: "/", updateViaCache: "none" });
  await registration.update();
  const worker = registration.installing || registration.waiting || registration.active;
  if (!worker) throw new Error("Sandbox service worker registration failed.");
  if (worker.state !== "activated") {
    await waitForWorkerState(worker, "activated");
  }
  return worker;
}

function waitForWorkerState(worker: ServiceWorker, expected: ServiceWorkerState): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => finish(new Error(`Sandbox service worker did not reach ${expected}.`)), SERVICE_WORKER_TIMEOUT_MS);
    const changed = (): void => {
      if (worker.state === expected) finish();
      else if (worker.state === "redundant") finish(new Error("Sandbox service worker became redundant during startup."));
    };
    const finish = (error?: Error): void => {
      globalThis.clearTimeout(timer);
      worker.removeEventListener("statechange", changed);
      if (error) reject(error);
      else resolve();
    };
    worker.addEventListener("statechange", changed);
    changed();
  });
}

function waitForWorkerControl(worker: ServiceWorker): Promise<void> {
  if (navigator.serviceWorker.controller === worker) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => finish(new Error("Sandbox service worker did not take control.")), SERVICE_WORKER_TIMEOUT_MS);
    const changed = (): void => {
      if (navigator.serviceWorker.controller === worker) finish();
    };
    const finish = (error?: Error): void => {
      globalThis.clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
      if (error) reject(error);
      else resolve();
    };
    navigator.serviceWorker.addEventListener("controllerchange", changed);
    changed();
  });
}

async function start(): Promise<void> {
  const worker = await activateServiceWorker();
  let activePort: MessagePort;

  async function connect(): Promise<void> {
    const channel = new MessageChannel();
    activePort = channel.port1;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => reject(new Error("Sandbox service worker bridge timed out.")), SERVICE_WORKER_TIMEOUT_MS);
      channel.port1.onmessage = (event) => {
        if (event.data?.type === "bridge-ready") {
          globalThis.clearTimeout(timer);
          resolve();
          return;
        }
        send("request", event.data);
      };
    });
    worker.postMessage({ type: "init" }, [channel.port2]);
    await ready;
  }

  window.addEventListener("message", (event) => {
    if (event.origin === parentOrigin && event.source === window.parent) {
      const envelope = event.data as Partial<SandboxEnvelope>;
      if (envelope.channel === SANDBOX_CHANNEL && envelope.nonce === nonce && envelope.type === "response") {
        activePort.postMessage(envelope.payload);
      }
      if (event.data?.channel === "vite-hmr") preview.contentWindow?.postMessage(event.data, location.origin);
      return;
    }

    if (event.source === preview.contentWindow && event.data?.type === "browser-agent-rendered") {
      send("rendered", { revision: String(event.data.revision) });
    }
  });

  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "sw-needs-init") {
      void connect().catch((error) => send("error", { message: error instanceof Error ? error.message : String(error) }));
    }
  });

  await connect();
  // An already-active worker does not re-run its activate handler for a newly
  // opened sandbox document. The init message above asks it to claim this page;
  // only navigate the generated preview after that claim is observable.
  await waitForWorkerControl(worker);
  worker.postMessage({ type: "server-registered", data: { port: virtualPort, hostname: "0.0.0.0" } });
  preview.addEventListener("load", () => send("preview-load"));
  preview.src = `${location.origin}/__virtual__/${virtualPort}/`;
  send("ready", { url: preview.src });
}

void start().catch((error) => send("error", { message: error instanceof Error ? error.message : String(error) }));
