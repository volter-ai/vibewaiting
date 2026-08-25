export const VIBEWAITING_EXTENSION_PROTOCOL =
  "vibewaiting/extension-v1" as const;
export const NATIVE_HOST_NAME = "ai.volter.vibewaiting";

export type RemoteAccessProvider = "auto" | "cloudflare" | "ngrok" | "stable";

export interface RemoteAccessConfiguration {
  enabled: boolean;
  provider: RemoteAccessProvider;
}

export interface ExtensionSettings {
  workspace: string;
  harness?: string;
  policy?: "default" | "yolo";
  remoteAccess?: RemoteAccessConfiguration;
}

export type NativeHostCommand =
  | {
      protocol: typeof VIBEWAITING_EXTENSION_PROTOCOL;
      type: "start";
      settings: ExtensionSettings;
    }
  | {
      protocol: typeof VIBEWAITING_EXTENSION_PROTOCOL;
      type: "remote-access";
      configuration: RemoteAccessConfiguration;
    }
  | {
      protocol: typeof VIBEWAITING_EXTENSION_PROTOCOL;
      type: "intent";
      id: string;
      payload: unknown;
    };

export type NativeHostEvent =
  | {
      protocol: typeof VIBEWAITING_EXTENSION_PROTOCOL;
      type: "patch";
      patch: unknown;
    }
  | {
      protocol: typeof VIBEWAITING_EXTENSION_PROTOCOL;
      type: "status";
      phase: "starting" | "ready" | "error" | "stopped";
      message?: string;
    }
  | {
      protocol: typeof VIBEWAITING_EXTENSION_PROTOCOL;
      type: "remote-access";
      passcode: string;
      snapshot: unknown;
    }
  | {
      protocol: typeof VIBEWAITING_EXTENSION_PROTOCOL;
      type: "chunk";
      id: string;
      index: number;
      total: number;
      data: string;
    };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseNativeHostCommand(
  value: unknown,
): NativeHostCommand | null {
  const candidate = record(value);
  if (candidate?.protocol !== VIBEWAITING_EXTENSION_PROTOCOL) return null;
  if (candidate.type === "remote-access") {
    const configuration = parseRemoteAccessConfiguration(candidate.configuration);
    return configuration
      ? { protocol: VIBEWAITING_EXTENSION_PROTOCOL, type: "remote-access", configuration }
      : null;
  }
  if (candidate.type === "intent") {
    return typeof candidate.id === "string"
      ? {
          protocol: VIBEWAITING_EXTENSION_PROTOCOL,
          type: "intent",
          id: candidate.id,
          payload: candidate.payload,
        }
      : null;
  }
  if (candidate.type !== "start") return null;
  const settings = record(candidate.settings);
  if (
    !settings ||
    typeof settings.workspace !== "string" ||
    !settings.workspace.trim()
  )
    return null;
  if (settings.harness !== undefined && typeof settings.harness !== "string")
    return null;
  if (
    settings.policy !== undefined &&
    settings.policy !== "default" &&
    settings.policy !== "yolo"
  )
    return null;
  return {
    protocol: VIBEWAITING_EXTENSION_PROTOCOL,
    type: "start",
    settings: {
      workspace: settings.workspace,
      ...(typeof settings.harness === "string" && settings.harness
        ? { harness: settings.harness }
        : {}),
      ...(settings.policy === "default" || settings.policy === "yolo"
        ? { policy: settings.policy }
        : {}),
      ...(parseRemoteAccessConfiguration(settings.remoteAccess)
        ? { remoteAccess: parseRemoteAccessConfiguration(settings.remoteAccess)! }
        : {}),
    },
  };
}

export function parseRemoteAccessConfiguration(value: unknown): RemoteAccessConfiguration | null {
  const candidate = record(value);
  if (!candidate || typeof candidate.enabled !== "boolean") return null;
  if (
    candidate.provider !== "auto" &&
    candidate.provider !== "cloudflare" &&
    candidate.provider !== "ngrok" &&
    candidate.provider !== "stable"
  ) return null;
  return { enabled: candidate.enabled, provider: candidate.provider };
}
