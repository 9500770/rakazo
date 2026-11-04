/**
 * A policy row is the only place a bot's reach on a real desktop is widened. Rows are
 * keyed by bot and computer, so opening one combination for an afternoon leaves every other bot
 * and computer asking. No row means the space's approval path decides — the safe default, and
 * what an expired row becomes.
 *
 * Kept free of Prisma and Node imports: the gate and the tool both read these rules, and tests
 * exercise them without a database.
 */
export type UserComputerPolicyMode = "ask" | "allow";

/** The deviceKey of a row that covers every computer the owner has paired. */
export const USER_COMPUTER_POLICY_ALL = "*";

/** A grant may last at most 30 days; longer is a standing permission, not one task. */
export const USER_COMPUTER_POLICY_MAX_MINUTES = 30 * 24 * 60;

export interface UserComputerPolicyRow {
  deviceKey: string;
  mode: string;
  expiresAt: Date | null;
}

export function isUserComputerPolicyMode(value: unknown): value is UserComputerPolicyMode {
  return value === "ask" || value === "allow";
}

/**
 * The mode in force for one computer now: the row for that computer first, then the row for
 * every computer. An expired row counts for nothing, so it falls back the same way.
 */
export function activeUserComputerPolicy(
  rows: readonly UserComputerPolicyRow[],
  deviceId: string | undefined,
  now: Date = new Date(),
): UserComputerPolicyMode | undefined {
  const live = rows.filter((row) => !row.expiresAt || row.expiresAt.getTime() > now.getTime());
  const keys = deviceId ? [deviceId, USER_COMPUTER_POLICY_ALL] : [USER_COMPUTER_POLICY_ALL];
  for (const key of keys) {
    const row = live.find((candidate) => candidate.deviceKey === key);
    if (row && isUserComputerPolicyMode(row.mode)) return row.mode;
  }
  return undefined;
}

/** When a grant given now stops counting; null means until it is revoked. */
export function userComputerPolicyExpiry(
  minutes: number | undefined,
  now: Date = new Date(),
): Date | null {
  if (minutes === undefined) return null;
  const bounded = Math.min(Math.max(Math.trunc(minutes), 1), USER_COMPUTER_POLICY_MAX_MINUTES);
  return new Date(now.getTime() + bounded * 60_000);
}

/** One row in the tool's short replies, without a timestamp the model would misread. */
export function describeUserComputerPolicy(
  row: Pick<UserComputerPolicyRow, "mode" | "expiresAt">,
  now: Date = new Date(),
): string {
  if (!isUserComputerPolicyMode(row.mode)) return "ask";
  if (row.mode === "ask") return "ask";
  if (!row.expiresAt) return "allow until revoked";
  const minutes = Math.ceil((row.expiresAt.getTime() - now.getTime()) / 60_000);
  return minutes > 0 ? `allow for ${minutes}m` : "ask";
}
