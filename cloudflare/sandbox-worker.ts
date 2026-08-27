interface SandboxEnv {
  ASSETS: Fetcher;
  WORKBENCH_ORIGIN: string;
}

function validWorkbenchOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
    throw new Error("WORKBENCH_ORIGIN must be an exact HTTPS origin.");
  }
  return url.origin;
}

function permittedAsset(pathname: string): boolean {
  return pathname === "/sandbox.html"
    || pathname === "/__sw__.js"
    || pathname.startsWith("/assets/");
}

function securityHeaders(response: Response, pathname: string, workbenchOrigin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", pathname === "/sandbox.html" || pathname === "/__sw__.js" ? "no-store" : "public, max-age=31536000, immutable");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  if (pathname === "/sandbox.html") {
    headers.set(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; worker-src 'self'; frame-src 'self'; frame-ancestors ${workbenchOrigin}; base-uri 'none'; form-action 'none'; object-src 'none'`,
    );
  }
  if (pathname === "/__sw__.js") headers.set("Service-Worker-Allowed", "/");
  headers.delete("X-Frame-Options");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: SandboxEnv): Promise<Response> {
    const url = new URL(request.url);
    if ((request.method !== "GET" && request.method !== "HEAD") || !permittedAsset(url.pathname)) {
      return new Response("Not found", {
        status: 404,
        headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
    const origin = validWorkbenchOrigin(env.WORKBENCH_ORIGIN);
    const response = await env.ASSETS.fetch(request);
    if (!response.ok) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    return securityHeaders(response, url.pathname, origin);
  },
} satisfies ExportedHandler<SandboxEnv>;

