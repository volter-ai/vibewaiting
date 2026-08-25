import type { RemotePairingHandoff } from "./extension-protocol.js";

const PAIRING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function activeRemotePairingUrl(
  value: unknown,
  publicUrl: string,
  now = Date.now(),
): string | null {
  const handoff = parseRemotePairingHandoff(value);
  if (!handoff || handoff.expiresAt <= now) return null;
  try {
    const publicLocation = new URL(publicUrl);
    const pairingLocation = new URL(handoff.url);
    if (
      publicLocation.protocol !== "https:" ||
      pairingLocation.protocol !== "https:" ||
      publicLocation.origin !== pairingLocation.origin ||
      publicLocation.pathname !== pairingLocation.pathname ||
      publicLocation.search !== pairingLocation.search ||
      !PAIRING_TOKEN_PATTERN.test(
        new URLSearchParams(pairingLocation.hash.slice(1)).get("pair") ?? "",
      )
    )
      return null;
    return pairingLocation.href;
  } catch {
    return null;
  }
}

export function parseRemotePairingHandoff(
  value: unknown,
): RemotePairingHandoff | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.url === "string" &&
    candidate.url.length <= 2_048 &&
    typeof candidate.expiresAt === "number" &&
    Number.isFinite(candidate.expiresAt) &&
    candidate.expiresAt > 0
    ? { expiresAt: candidate.expiresAt, url: candidate.url }
    : null;
}
