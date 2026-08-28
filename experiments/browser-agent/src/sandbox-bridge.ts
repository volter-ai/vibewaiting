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
    await new Promise<void>((resolve) => worker.addEventListener("statechange", () => {
      if (worker.state === "activated") resolve();
    }));
  }
  if (navigator.serviceWorker.controller !== worker) {
    await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
  }
  if (!navigator.serviceWorker.controller) throw new Error("Sandbox service worker did not take control.");
  return navigator.serviceWorker.controller;
}

async function start(): Promise<void> {
  const worker = await activateServiceWorker();
  let activePort: MessagePort;

  async function connect(): Promise<void> {
    const channel = new MessageChannel();
    activePort = channel.port1;
    const ready = new Promise<void>((resolve) => {
      channel.port1.onmessage = (event) => {
        if (event.data?.type === "bridge-ready") {
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
  worker.postMessage({ type: "server-registered", data: { port: virtualPort, hostname: "0.0.0.0" } });
  preview.addEventListener("load", () => send("preview-load"));
  preview.src = `${location.origin}/__virtual__/${virtualPort}/`;
  send("ready", { url: preview.src });
}

void start().catch((error) => send("error", { message: error instanceof Error ? error.message : String(error) }));
