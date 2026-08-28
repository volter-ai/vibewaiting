export const GENERATED_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline' blob:",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self' blob:",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export const THREE_MODULE_ASSET_PATH = "/assets/three.module-vibewaiting.js";
export const THREE_CORE_ASSET_PATH = "/assets/three.core.js";

const INIT_MARKER = "mainPort.onmessage = handleMainMessage;";
const FETCH_MARKER = "  // Check if this is a virtual server request\n  const match = url.pathname.match(/^\\/__virtual__\\/(\\d+)(\\/.*)?$/);";
const NON_VIRTUAL_MARKER = "  if (!match) {";
const BUFFERED_HEADERS_MARKER = "        const respHeaders = new Headers(response.headers);";
const STREAM_HEADERS_MARKER = "  const respHeaders = new Headers(responseData?.headers || {});";

function responseHeaderPatch(indent: string): string {
  return [
    `${indent}respHeaders.set('Access-Control-Allow-Origin', '*');`,
    `${indent}respHeaders.set('Content-Security-Policy', ${JSON.stringify(GENERATED_PREVIEW_CSP)});`,
    `${indent}respHeaders.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()');`,
    `${indent}respHeaders.set('Referrer-Policy', 'no-referrer');`,
    `${indent}respHeaders.set('X-Content-Type-Options', 'nosniff');`,
  ].join("\n");
}

/**
 * AlmostNode owns the virtual-server service worker. Harden its published source
 * at build time so opaque generated frames can load modules but cannot use a
 * no-referrer request to bypass the generated-document CSP.
 */
export function hardenSandboxServiceWorker(source: string): string {
  if (!source.includes(INIT_MARKER)) {
    throw new Error("The installed almostnode service-worker init protocol changed; update the sandbox adapter.");
  }
  if (!source.includes(FETCH_MARKER)
    || !source.includes(NON_VIRTUAL_MARKER)
    || !source.includes(BUFFERED_HEADERS_MARKER)
    || !source.includes(STREAM_HEADERS_MARKER)) {
    throw new Error("The installed almostnode service-worker response protocol changed; update the sandbox hardening adapter.");
  }

  const externalRequestGuard = [
    `  if (url.origin === self.location.origin && ${JSON.stringify([THREE_MODULE_ASSET_PATH, THREE_CORE_ASSET_PATH])}.includes(url.pathname)) return;`,
    "",
    "  // Generated virtual pages are intentionally network-denied. Checking the",
    "  // controlling client closes referrerPolicy=no-referrer and worker bypasses.",
    "  if (url.origin !== self.location.origin) {",
    "    event.respondWith((async () => {",
    "      const client = event.clientId ? await self.clients.get(event.clientId) : null;",
    "      const clientPath = client ? new URL(client.url).pathname : '';",
    "      if (clientPath.startsWith('/__virtual__/')) {",
    "        return new Response('Generated preview network access is disabled.', {",
    "          status: 403,",
    "          headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },",
    "        });",
    "      }",
    "      return fetch(event.request);",
    "    })());",
    "    return;",
    "  }",
    "",
    FETCH_MARKER,
  ].join("\n");

  const opaqueClientRouter = [
    "  // Opaque sandbox frames omit referrers. Recover their virtual server from",
    "  // the controlled client URL instead of accidentally serving sandbox-host files.",
    "  if (!match && event.clientId) {",
    "    event.respondWith((async () => {",
    "      const client = await self.clients.get(event.clientId);",
    "      const clientPath = client ? new URL(client.url).pathname : '';",
    "      const clientMatch = clientPath.match(/^\\/__virtual__\\/(\\d+)/);",
    "      if (!clientMatch) return fetch(event.request);",
    "      const virtualPrefix = clientMatch[0];",
    "      const virtualPort = parseInt(clientMatch[1], 10);",
    "      if (url.origin !== self.location.origin) {",
    "        return new Response('Generated preview network access is disabled.', {",
    "          status: 403,",
    "          headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },",
    "        });",
    "      }",
    "      const targetPath = url.pathname + url.search;",
    "      if (event.request.mode === 'navigate') {",
    "        return Response.redirect(url.origin + virtualPrefix + targetPath, 302);",
    "      }",
    "      return handleVirtualRequest(event.request, virtualPort, targetPath);",
    "    })());",
    "    return;",
    "  }",
    "",
    NON_VIRTUAL_MARKER,
  ].join("\n");

  return source
    .replace(INIT_MARKER, `${INIT_MARKER}\n    mainPort.postMessage({ type: 'bridge-ready' });`)
    .replace(FETCH_MARKER, externalRequestGuard)
    .replace(NON_VIRTUAL_MARKER, opaqueClientRouter)
    .replace(BUFFERED_HEADERS_MARKER, `${BUFFERED_HEADERS_MARKER}\n${responseHeaderPatch("        ")}`)
    .replace(STREAM_HEADERS_MARKER, `${STREAM_HEADERS_MARKER}\n${responseHeaderPatch("  ")}`);
}
