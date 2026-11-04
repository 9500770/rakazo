import type { UserDevice, UserDeviceGateway } from "./user-device-protocol.js";

/** One of the user's connected computers, addressable by alias, full deviceId, or exact name. */
export interface UserDeviceChoice extends UserDevice {
  alias: string;
}

/**
 * A gateway that can enumerate every connected computer and resolve a reference to one. The
 * protocol's gateway interface stays minimal for older implementations, so this is detected,
 * not declared, on every gateway (see userDevicePicker).
 */
export interface UserDevicePicker extends UserDeviceGateway {
  /** Every online device of the user, newest connection first, each with its alias. */
  connectedAll(userId: string): Promise<UserDeviceChoice[]>;
  /** The online device a reference names, or the latest one when it is omitted; null when none. */
  connectedDevice(userId: string, ref?: string): Promise<UserDeviceChoice | null>;
}

/** The gateway's device-selection methods when it has them, else undefined. */
export function userDevicePicker(devices: UserDeviceGateway): UserDevicePicker | undefined {
  const candidate = devices as Partial<UserDevicePicker> | undefined;
  return candidate &&
    typeof candidate.connectedAll === "function" &&
    typeof candidate.connectedDevice === "function"
    ? (candidate as UserDevicePicker)
    : undefined;
}

/**
 * The stable short name a model uses to pick one computer: a slug of its name plus the last
 * four characters of its device id. Renaming the device changes it; reconnecting never does.
 */
export function computerAlias(name: string, deviceId: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "computer";
  return `${slug}-${deviceId.slice(-4).toLowerCase()}`;
}

/**
 * The online device a reference names: by alias, then by full device id, then by exact name.
 * Without a reference, the latest connection wins, matching the single-device behavior.
 */
export function resolveUserDevice<T extends UserDeviceChoice>(
  devices: readonly T[],
  ref?: string,
): T | null {
  const reference = ref?.trim().toLowerCase();
  if (!reference) return devices[0] ?? null;
  return (
    devices.find((device) => device.alias.toLowerCase() === reference) ??
    devices.find((device) => device.deviceId.toLowerCase() === reference) ??
    devices.find((device) => device.name.trim().toLowerCase() === reference) ??
    null
  );
}

/**
 * The user's online computers: every one a listing gateway knows, or just the latest on one
 * that cannot list them. A gateway failure reads as no computer online.
 */
export async function onlineUserComputers(
  devices: UserDeviceGateway,
  userId: string,
): Promise<UserDeviceChoice[]> {
  try {
    const picker = userDevicePicker(devices);
    if (picker) return await picker.connectedAll(userId);
    const latest = await devices.connected(userId);
    return latest ? [{ ...latest, alias: computerAlias(latest.name, latest.deviceId) }] : [];
  } catch {
    return [];
  }
}

/** Device-supplied free text (a name, a platform) before it enters a prompt or an error. */
export function safeDeviceLabel(value: string): string {
  return value
    .replace(/[\p{Cc}\u2028\u2029\s]+/gu, " ")
    .trim()
    .slice(0, 60);
}
