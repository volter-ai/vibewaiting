export const VIBEWAITING_EXTENSION_PROTOCOL =
  "vibewaiting/extension-v1" as const;
export const NATIVE_HOST_NAME = "ai.volter.vibewaiting";

export interface ExtensionSettings {
  workspace: string;
  harness?: string;
  policy?: "default" | "yolo";
}

export type NativeHostCommand =
  | {
      protocol: typeof VIBEWAITING_EXTENSION_PROTOCOL;
      type: "start";
      settings: ExtensionSettings;
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
    },
  };
}
