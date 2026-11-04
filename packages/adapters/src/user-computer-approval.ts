/**
 * How much a bot may do on the owner's own computer, kept apart from the space's approval mode.
 * "Never ask" suits a VM the run owns; the person's real desktop may still be told to ask. The mode
 * is read per call, so a deployment sets it once with an environment variable and nothing is
 * migrated, stored, or pushed to the desktop app.
 *
 * RAKAZO_USER_COMPUTER_GRANT_TTL (minutes) makes "Allow in this space" expire, so access granted
 * for one task is taken back on its own instead of lasting as long as the pairing.
 *
 * RAKAZO_USER_COMPUTER_APPROVAL:
 * - `ask` (default) asks the first time per app in a space and then honors "Allow in this space".
 *   A shell command is never remembered that way: it asks on every call unless a per-computer
 *   grant (user_computer_policy) allows that computer.
 * - `always` asks every time, even when this space allowed it before.
 * - `never` runs without asking; a block rule still refuses, and the desktop's own permission still applies.
 */
export type UserComputerApprovalMode = "ask" | "always" | "never";

export function userComputerApprovalMode(
  env: Record<string, string | undefined> = process.env,
): UserComputerApprovalMode {
  const mode = env.RAKAZO_USER_COMPUTER_APPROVAL?.trim().toLowerCase();
  return mode === "never" || mode === "always" ? mode : "ask";
}

/** How long "Allow in this space" counts, or undefined when a grant lasts until re-pairing. */
export function userComputerGrantTtlMs(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env.RAKAZO_USER_COMPUTER_GRANT_TTL?.trim();
  if (!raw) return undefined;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
  return Math.min(minutes, 24 * 60) * 60_000;
}
