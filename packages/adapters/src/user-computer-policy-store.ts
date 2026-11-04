import type { PrismaClient } from "@rakazo/db";
import type { UserComputerPolicyRow } from "./user-computer-policy.js";

/**
 * The only database work this feature does, behind a narrow interface. The gate reads rows on
 * every user-computer call and the tool writes them, so both go through here and neither knows
 * how a policy is stored. A client without the model (an older deployment, or a test fake) reads
 * as no policy, which leaves the previous behavior untouched.
 */
export interface UserComputerPolicyStore {
  findMany(input: {
    where: { botId: string; deviceKey?: { in: string[] } };
    select: { deviceKey: true; mode: true; expiresAt: true };
  }): Promise<UserComputerPolicyRow[]>;
  upsert(input: {
    where: { botId_deviceKey: { botId: string; deviceKey: string } };
    create: {
      spaceId: string;
      userId: string;
      botId: string;
      deviceKey: string;
      mode: string;
      expiresAt: Date | null;
    };
    update: { mode: string; expiresAt: Date | null };
  }): Promise<unknown>;
  deleteMany(input: { where: { botId: string; deviceKey?: string } }): Promise<{ count: number }>;
}

export function userComputerPolicyStore(
  prisma: PrismaClient | undefined,
): UserComputerPolicyStore | undefined {
  const model = (
    prisma as unknown as { userComputerPolicy?: Partial<UserComputerPolicyStore> } | undefined
  )?.userComputerPolicy;
  if (
    !model ||
    typeof model.findMany !== "function" ||
    typeof model.upsert !== "function" ||
    typeof model.deleteMany !== "function"
  ) {
    return undefined;
  }
  return model as UserComputerPolicyStore;
}
