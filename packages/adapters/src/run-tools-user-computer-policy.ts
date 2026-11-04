import { approvalModeFromPreference } from "@rakazo/core";
import { z } from "zod";
import type { RunContext } from "./run-context.js";
import { isRunTainted, refuseOwnerSettingsChange } from "./run-context.js";
import { isSubagentToolExecution } from "./run-effects.js";
import type { ToolCall } from "./run-tool-gate.js";
import type { UserComputerPolicyRow } from "./user-computer-policy.js";
import {
  describeUserComputerPolicy,
  USER_COMPUTER_POLICY_ALL,
  userComputerPolicyExpiry,
} from "./user-computer-policy.js";
import { userComputerPolicyStore } from "./user-computer-policy-store.js";
import { USER_COMPUTER_POLICY_TOOL } from "./user-computer-tools.js";
import type { UserDeviceChoice } from "./user-device-alias.js";
import {
  computerAlias,
  pairedUserComputers,
  resolveUserDevice,
  safeDeviceLabel,
} from "./user-device-alias.js";

export { USER_COMPUTER_POLICY_TOOL };

const input = z.object({
  action: z.enum(["list", "allow", "ask", "auto", "revoke"]),
  computer: z.string().max(120).optional(),
  minutes: z
    .number()
    .int()
    .min(1)
    .max(30 * 24 * 60)
    .optional(),
  bot: z.string().max(200).optional(),
});

/**
 * Changing a policy is a security boundary, so a card always confirms it; reading the current
 * policy is not, so `list` runs straight away. A block still refuses any of them.
 */
export function userComputerPolicyGate(blocked: boolean, args: Record<string, unknown>) {
  if (blocked) return "deny" as const;
  return args.action === "list" ? ("allow" as const) : ("ask" as const);
}

function computerLabel(choice: UserDeviceChoice | undefined, ref: string | undefined): string {
  return choice ? choice.alias : ref ? `"${ref}"` : "every computer";
}

/**
 * See or change whether one bot may use the user's computers without asking. A row is keyed by
 * bot and computer, so `/pc allow office-pc 90m` leaves this bot's other computers on the space's
 * path; without any row the space decides. Grants may expire on
 * their own (see user-computer-policy.ts).
 */
export async function userComputerPolicy(ctx: RunContext, call: ToolCall) {
  const { deps, run, source } = ctx;
  const parsed = input.safeParse(call.args);
  if (!parsed.success) {
    return call.finish({
      error: parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(" "),
    });
  }
  const { action, computer, minutes, bot: botRef } = parsed.data;
  if (!source.ownerStartedRun)
    return call.finish({ error: "Computer permissions change only in a chat the user started." });
  if (isSubagentToolExecution(call.executionId))
    return call.finish({ error: "Helpers cannot change computer permissions." });
  if (action !== "list" && !call.nextApprovedTool && (await isRunTainted(ctx))) {
    return call.finish(
      refuseOwnerSettingsChange(
        ctx,
        "Computer permissions are blocked for the rest of this run because it read outside content.",
      ),
    );
  }
  const owner = source.userComputerOwner;
  if (!owner || !deps.userDevices)
    return call.finish({ error: "The user's computer is not available in this run." });
  if (botRef && !ctx.bot.fleetManagement)
    return call.finish({
      error:
        "Changing another bot's computer access needs fleet management, which this bot has off.",
    });
  const target = await targetBot(ctx, botRef);
  if (!target) return call.finish({ error: `No bot named "${botRef}" in this space.` });
  const store = userComputerPolicyStore(deps.prisma);
  if (!store) return call.finish({ error: "Computer permissions are not available here." });

  const paired = await pairedUserComputers(deps.userDevices, owner);
  // Naming no computer covers every computer; it does not quietly pick the default one.
  const choice = computer?.trim() ? resolveUserDevice(paired, computer) : undefined;
  if (computer?.trim() && !choice) {
    const names = paired
      .map((device) => `${device.alias} (${safeDeviceLabel(device.platform)})`)
      .join(", ");
    return call.finish({
      error: `No paired computer named "${computer}". Paired: ${names || "none"}.`,
    });
  }

  if (action === "list") {
    const rows = await store.findMany({
      where: { botId: target.id },
      select: { deviceKey: true, mode: true, expiresAt: true },
    });
    return call.finish({
      text: describePolicies(target.name, paired, rows, await spaceApprovalMode(ctx)),
    });
  }

  const deviceKey = choice?.deviceId ?? USER_COMPUTER_POLICY_ALL;
  // Auto is the default: drop the row so the space's path decides again. Revoke is the
  // same action; the space may ask, judge, or (when Never) still judge on a real desktop.
  if (action === "auto" || action === "revoke") {
    const { count } = await store.deleteMany({
      where: { botId: target.id, ...(choice ? { deviceKey: choice.deviceId } : {}) },
    });
    const where = choice ? computerLabel(choice, computer) : "every computer";
    return call.finish({
      text: count
        ? `${target.name} on ${where}: auto. The space's approval path decides again.`
        : `${target.name} on ${where}: already auto.`,
    });
  }

  const expiresAt = action === "allow" ? userComputerPolicyExpiry(minutes) : null;
  await store.upsert({
    where: { botId_deviceKey: { botId: target.id, deviceKey } },
    create: {
      spaceId: run.spaceId,
      userId: run.userId,
      botId: target.id,
      deviceKey,
      mode: action,
      expiresAt,
    },
    update: { mode: action, expiresAt },
  });
  const where = choice ? computerLabel(choice, computer) : "Every computer";
  return call.finish({
    text: `${target.name} on ${where}: ${describeUserComputerPolicy({ mode: action, expiresAt })}.`,
  });
}

async function targetBot(
  ctx: RunContext,
  ref: string | undefined,
): Promise<{ id: string; name: string } | undefined> {
  if (!ref) return { id: ctx.bot.id, name: ctx.bot.name ?? "This bot" };
  const bot = await ctx.deps.prisma.bot.findFirst({
    where: {
      spaceId: ctx.run.spaceId,
      userId: ctx.run.userId,
      OR: [{ id: ref }, { name: ref }],
    },
    select: { id: true, name: true },
  });
  return bot ?? undefined;
}

/**
 * The mode a computer with no policy row falls back to. A real desktop is never "never":
 * run-tool-gate.ts remaps a space that never asks onto Auto's judge (see userComputerGate).
 */
async function spaceApprovalMode(ctx: RunContext): Promise<string> {
  const load = (
    ctx.trust as {
      loadAutoReviewPreference?: () => Promise<{ enabled: boolean; skipApprovals: boolean }>;
    }
  ).loadAutoReviewPreference;
  if (typeof load !== "function") return "auto";
  const mode = approvalModeFromPreference(await load.call(ctx.trust));
  return mode === "never" ? "auto" : mode;
}

function describePolicies(
  bot: string,
  paired: readonly UserDeviceChoice[],
  rows: readonly UserComputerPolicyRow[],
  fallback: string,
): string {
  const lines = [`${bot}:`];
  const all = rows.find((row) => row.deviceKey === USER_COMPUTER_POLICY_ALL);
  // No row is not "ask": it means the space's path decides, which on a real desktop is
  // Auto's judge. Printing "ask" claimed every call would show a card when none did.
  lines.push(`every computer: ${all ? describeUserComputerPolicy(all) : fallback}`);
  for (const device of paired) {
    // A row for this computer wins; otherwise the row for all of them is what applies.
    const row = rows.find((candidate) => candidate.deviceKey === device.deviceId) ?? all;
    lines.push(
      `${computerAlias(device.name, device.deviceId)} (${safeDeviceLabel(device.platform)}): ${
        row ? describeUserComputerPolicy(row) : fallback
      }`,
    );
  }
  return lines.join("\n");
}
