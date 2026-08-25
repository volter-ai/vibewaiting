export interface RemoteDeviceSnapshot {
  authorizedDevices: number;
  connectedDevices: number;
}

export function parseRemoteDeviceSnapshot(
  value: unknown,
): RemoteDeviceSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const candidate = value as Record<string, unknown>;
  if (
    !Number.isInteger(candidate.authorizedDevices) ||
    !Number.isInteger(candidate.connectedDevices) ||
    (candidate.authorizedDevices as number) < 0 ||
    (candidate.connectedDevices as number) < 0 ||
    (candidate.connectedDevices as number) >
      (candidate.authorizedDevices as number)
  )
    return null;
  return {
    authorizedDevices: candidate.authorizedDevices as number,
    connectedDevices: candidate.connectedDevices as number,
  };
}
