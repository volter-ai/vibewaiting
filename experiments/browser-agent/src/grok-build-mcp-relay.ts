const DEFAULT_PROXY_ENDPOINT = "/api/grok/mcp/proxy";
const DEFAULT_RESOLVE_ENDPOINT = "/api/grok/mcp/resolve";

const FORWARDED_RESPONSE_HEADERS = ["Content-Type", "Location", "Mcp-Session-Id", "Retry-After", "WWW-Authenticate"] as const;

/** Same-origin projection for remote MCP and OAuth requests that browser CORS would reject. */
export function createGrokBuildMcpRelayFetch(
  options: { fetch?: typeof globalThis.fetch; endpoint?: string } = {},
): typeof fetch {
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const endpoint = options.endpoint ?? DEFAULT_PROXY_ENDPOINT;
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    let target = input instanceof Request ? input.url : String(input);
    const sourceHeaders = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, name) => sourceHeaders.set(name, value));
    let method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const rawBody = init.body;
    let body: string | undefined;
    if (typeof rawBody === "string") body = rawBody;
    else if (rawBody instanceof URLSearchParams) body = rawBody.toString();
    else if (rawBody !== undefined && rawBody !== null) throw new Error("MCP relay accepts only string request bodies.");
    else if (input instanceof Request && method === "POST") body = await input.clone().text();
    const redirect = init.redirect ?? (input instanceof Request ? input.redirect : "follow");
    for (let redirects = 0; redirects <= 20; redirects += 1) {
      const headers: Record<string, string> = {};
      sourceHeaders.forEach((value, name) => { headers[name] = value; });
      const response = await fetchImpl(endpoint, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: target, method, headers, ...(body !== undefined ? { body } : {}) }),
        ...(init.signal ? { signal: init.signal } : {}),
      });
      const projectedHeaders = new Headers();
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value) projectedHeaders.set(name, value);
      }
      const projectedStatus = parseProjectedStatus(response.headers.get("X-Vibewaiting-Mcp-Upstream-Status")) ?? response.status;
      const location = projectedHeaders.get("Location");
      if (projectedStatus < 300 || projectedStatus >= 400 || !location || redirect === "manual") {
        const noBody = projectedStatus === 204 || projectedStatus === 205 || projectedStatus === 304;
        return new Response(noBody ? null : response.body, { status: projectedStatus, headers: projectedHeaders });
      }
      await response.body?.cancel().catch(() => undefined);
      if (redirect === "error") throw new TypeError("MCP relay redirect rejected by request policy.");
      if (redirects === 20) throw new TypeError("MCP relay exceeded 20 redirects.");
      const previous = new URL(target);
      const next = new URL(location, previous);
      if (next.origin !== previous.origin) sourceHeaders.delete("Authorization");
      if (projectedStatus === 303 || ((projectedStatus === 301 || projectedStatus === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        sourceHeaders.delete("Content-Type");
      }
      target = next.toString();
    }
    throw new TypeError("MCP relay exceeded 20 redirects.");
  }) as typeof fetch;
}

function parseProjectedStatus(value: string | null): number | undefined {
  if (!value || !/^\d{3}$/u.test(value)) return undefined;
  const status = Number(value);
  return status >= 200 && status <= 599 ? status : undefined;
}

export function createGrokBuildMcpHostnameResolver(
  options: { fetch?: typeof globalThis.fetch; endpoint?: string } = {},
): (hostname: string, signal: AbortSignal) => Promise<readonly string[]> {
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const endpoint = options.endpoint ?? DEFAULT_RESOLVE_ENDPOINT;
  return async (hostname, signal) => {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname }),
      signal,
    });
    const value = await response.json().catch(() => undefined) as { addresses?: unknown; error?: { message?: unknown } } | undefined;
    if (!response.ok) throw new Error(typeof value?.error?.message === "string" ? value.error.message : `MCP hostname relay returned HTTP ${response.status}.`);
    if (!Array.isArray(value?.addresses) || !value.addresses.every((address) => typeof address === "string")) {
      throw new Error("MCP hostname relay returned invalid addresses.");
    }
    return value.addresses;
  };
}

export function shouldRelayGrokBuildMcpUrl(url: string, pageOrigin = globalThis.location?.origin): boolean {
  const target = new URL(url, pageOrigin);
  if (target.protocol !== "https:") return false;
  return !pageOrigin || target.origin !== pageOrigin;
}
