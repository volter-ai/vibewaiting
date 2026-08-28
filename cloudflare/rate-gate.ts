const RESERVATION_LEASE_MS = 3 * 60 * 1_000;

export const RATE_GATE_LIMITS = {
  authStartsGlobal: 50,
  authStartsPerIp: 5,
  globalDailyChats: 100,
  userDailyChats: 40,
  globalConcurrency: 5,
  userConcurrency: 1,
  globalDailyMediaStarts: 20,
  userDailyMediaStarts: 5,
  globalDailyWebFetches: 100,
  userDailyWebFetches: 40,
  globalDailyStartupRequests: 200,
  userDailyStartupRequests: 20,
  globalDailyTelemetryRequests: 1_000,
  userDailyTelemetryRequests: 200,
  globalDailyManagedMcpCalls: 100,
  userDailyManagedMcpCalls: 40,
  globalDailyLocalMcpRequests: 100,
  userDailyLocalMcpRequests: 40,
} as const;

type DailyBudgetKind = "media" | "webFetch" | "startup" | "telemetry" | "managedMcp" | "localMcp";

interface RateReservation {
  userKey: string;
  expiresAt: number;
}

interface DailyCounter {
  global: number;
  users: Record<string, number>;
}

interface GateState {
  day: string;
  globalChats: number;
  userChats: Record<string, number>;
  reservations: Record<string, RateReservation>;
  authStarts: number;
  authStartsByIp: Record<string, number>;
  daily: Record<DailyBudgetKind, DailyCounter>;
}

interface LegacyGateState extends Partial<GateState> {
  globalMediaStarts?: number;
  userMediaStarts?: Record<string, number>;
  globalWebFetches?: number;
  userWebFetches?: Record<string, number>;
  globalStartupRequests?: number;
  userStartupRequests?: Record<string, number>;
  globalTelemetryRequests?: number;
  userTelemetryRequests?: Record<string, number>;
}

interface DailyPolicy {
  kind: DailyBudgetKind;
  globalLimit: number;
  userLimit: number;
  invalidMessage: string;
  globalMessage: string;
  userMessage: string;
}

const DAILY_POLICIES: Record<string, DailyPolicy> = {
  "/acquire-media": {
    kind: "media",
    globalLimit: RATE_GATE_LIMITS.globalDailyMediaStarts,
    userLimit: RATE_GATE_LIMITS.userDailyMediaStarts,
    invalidMessage: "Invalid media limiter key.",
    globalMessage: "The service-wide daily Imagine relay limit has been reached.",
    userMessage: "This Grok account has reached its daily Imagine relay limit.",
  },
  "/acquire-web-fetch": {
    kind: "webFetch",
    globalLimit: RATE_GATE_LIMITS.globalDailyWebFetches,
    userLimit: RATE_GATE_LIMITS.userDailyWebFetches,
    invalidMessage: "Invalid web_fetch limiter key.",
    globalMessage: "The service-wide daily web_fetch limit has been reached.",
    userMessage: "This Grok account has reached its daily web_fetch limit.",
  },
  "/acquire-startup": {
    kind: "startup",
    globalLimit: RATE_GATE_LIMITS.globalDailyStartupRequests,
    userLimit: RATE_GATE_LIMITS.userDailyStartupRequests,
    invalidMessage: "Invalid startup limiter key.",
    globalMessage: "The service-wide daily startup relay limit has been reached.",
    userMessage: "This Grok account has reached its daily startup relay limit.",
  },
  "/acquire-telemetry": {
    kind: "telemetry",
    globalLimit: RATE_GATE_LIMITS.globalDailyTelemetryRequests,
    userLimit: RATE_GATE_LIMITS.userDailyTelemetryRequests,
    invalidMessage: "Invalid telemetry limiter key.",
    globalMessage: "The service-wide daily telemetry relay limit has been reached.",
    userMessage: "This Grok account has reached its daily telemetry relay limit.",
  },
  "/acquire-managed-mcp": {
    kind: "managedMcp",
    globalLimit: RATE_GATE_LIMITS.globalDailyManagedMcpCalls,
    userLimit: RATE_GATE_LIMITS.userDailyManagedMcpCalls,
    invalidMessage: "Invalid managed MCP limiter key.",
    globalMessage: "The service-wide daily managed MCP limit has been reached.",
    userMessage: "This Grok account has reached its daily managed MCP limit.",
  },
  "/acquire-local-mcp": {
    kind: "localMcp",
    globalLimit: RATE_GATE_LIMITS.globalDailyLocalMcpRequests,
    userLimit: RATE_GATE_LIMITS.userDailyLocalMcpRequests,
    invalidMessage: "Invalid local MCP limiter key.",
    globalMessage: "The service-wide daily local MCP relay limit has been reached.",
    userMessage: "This Grok account has reached its daily local MCP relay limit.",
  },
};

function json(value: unknown, status = 200, retryAfter?: number): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  if (retryAfter !== undefined) headers.set("Retry-After", String(retryAfter));
  return new Response(JSON.stringify(value), { status, headers });
}

function error(message: string, status: number, retryAfter?: number): Response {
  return json({ error: { message } }, status, retryAfter);
}

function boundedKey(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : undefined;
}

function emptyDaily(): Record<DailyBudgetKind, DailyCounter> {
  return {
    media: { global: 0, users: {} },
    webFetch: { global: 0, users: {} },
    startup: { global: 0, users: {} },
    telemetry: { global: 0, users: {} },
    managedMcp: { global: 0, users: {} },
    localMcp: { global: 0, users: {} },
  };
}

function normalizeDaily(current: LegacyGateState): Record<DailyBudgetKind, DailyCounter> {
  const daily = current.daily;
  return {
    media: daily?.media ?? { global: current.globalMediaStarts ?? 0, users: current.userMediaStarts ?? {} },
    webFetch: daily?.webFetch ?? { global: current.globalWebFetches ?? 0, users: current.userWebFetches ?? {} },
    startup: daily?.startup ?? { global: current.globalStartupRequests ?? 0, users: current.userStartupRequests ?? {} },
    telemetry: daily?.telemetry ?? { global: current.globalTelemetryRequests ?? 0, users: current.userTelemetryRequests ?? {} },
    managedMcp: daily?.managedMcp ?? { global: 0, users: {} },
    localMcp: daily?.localMcp ?? { global: 0, users: {} },
  };
}

export class RateGate implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  private currentDay(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private async load(): Promise<GateState> {
    const current = await this.state.storage.get<LegacyGateState>("gate");
    const day = this.currentDay();
    if (current?.day === day) {
      return {
        day,
        globalChats: current.globalChats ?? 0,
        userChats: current.userChats ?? {},
        reservations: current.reservations ?? {},
        authStarts: current.authStarts ?? 0,
        authStartsByIp: current.authStartsByIp ?? {},
        daily: normalizeDaily(current),
      };
    }
    return {
      day,
      globalChats: 0,
      userChats: {},
      reservations: current?.reservations ?? {},
      authStarts: 0,
      authStartsByIp: {},
      daily: emptyDaily(),
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body: Record<string, unknown> = request.method === "POST"
      ? await request.json<Record<string, unknown>>().catch(() => ({}))
      : {};
    const gate = await this.load();
    const now = Date.now();
    gate.reservations = Object.fromEntries(Object.entries(gate.reservations)
      .filter(([, lease]) => lease.expiresAt > now));

    if (url.pathname === "/auth-start") {
      const ipKey = boundedKey(body.ipKey);
      if (!ipKey) return error("Invalid authentication limiter key.", 400);
      const ipCount = gate.authStartsByIp[ipKey] ?? 0;
      if (gate.authStarts >= RATE_GATE_LIMITS.authStartsGlobal || ipCount >= RATE_GATE_LIMITS.authStartsPerIp) {
        return error("The daily sign-in safety limit has been reached.", 429, 3600);
      }
      gate.authStarts += 1;
      gate.authStartsByIp[ipKey] = ipCount + 1;
      await this.state.storage.put("gate", gate);
      return json({ allowed: true });
    }

    if (url.pathname === "/acquire-chat") {
      const userKey = boundedKey(body.userKey);
      const reservationId = boundedKey(body.reservationId);
      if (!userKey || !reservationId) return error("Invalid rate reservation.", 400);
      const userCount = gate.userChats[userKey] ?? 0;
      const leases = Object.values(gate.reservations);
      const userConcurrency = leases.filter((lease) => lease.userKey === userKey).length;
      if (gate.globalChats >= RATE_GATE_LIMITS.globalDailyChats) return error("The service-wide daily Grok limit has been reached.", 429, 3600);
      if (userCount >= RATE_GATE_LIMITS.userDailyChats) return error("This Grok account has reached its daily agent limit.", 429, 3600);
      if (leases.length >= RATE_GATE_LIMITS.globalConcurrency) return error("The Grok relay is at its concurrency limit. Try again shortly.", 429, 10);
      if (userConcurrency >= RATE_GATE_LIMITS.userConcurrency) return error("This Grok account already has an agent request running.", 429, 10);
      gate.globalChats += 1;
      gate.userChats[userKey] = userCount + 1;
      gate.reservations[reservationId] = { userKey, expiresAt: now + RESERVATION_LEASE_MS };
      await this.state.storage.put("gate", gate);
      return json({
        allowed: true,
        userRemaining: RATE_GATE_LIMITS.userDailyChats - userCount - 1,
        globalRemaining: RATE_GATE_LIMITS.globalDailyChats - gate.globalChats,
      });
    }

    const policy = DAILY_POLICIES[url.pathname];
    if (policy) {
      const userKey = boundedKey(body.userKey);
      if (!userKey) return error(policy.invalidMessage, 400);
      const counter = gate.daily[policy.kind];
      const userCount = counter.users[userKey] ?? 0;
      if (counter.global >= policy.globalLimit) return error(policy.globalMessage, 429, 3600);
      if (userCount >= policy.userLimit) return error(policy.userMessage, 429, 3600);
      counter.global += 1;
      counter.users[userKey] = userCount + 1;
      await this.state.storage.put("gate", gate);
      return json({
        allowed: true,
        userRemaining: policy.userLimit - userCount - 1,
        globalRemaining: policy.globalLimit - counter.global,
      });
    }

    if (url.pathname === "/release-chat") {
      const reservationId = boundedKey(body.reservationId);
      if (!reservationId) return error("Invalid rate reservation.", 400);
      delete gate.reservations[reservationId];
      await this.state.storage.put("gate", gate);
      return json({ released: true });
    }
    return error("Rate gate route not found.", 404);
  }
}
