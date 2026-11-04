import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { userComputerPolicy, userComputerPolicyGate } from "./run-tools-user-computer-policy.js";
import { computerAlias, resolveUserDevice } from "./user-device-alias.js";
import type { UserDeviceGateway } from "./user-device-protocol.js";

const choices = [
  { deviceId: "device-1", name: "Laptop", platform: "darwin" },
  { deviceId: "device-2", name: "Office PC", platform: "win32" },
].map((device) => ({ ...device, alias: computerAlias(device.name, device.deviceId) }));

function setup(rows: Array<{ deviceKey: string; mode: string; expiresAt: Date | null }> = []) {
  const findMany = vi.fn(async (_args: unknown) => rows);
  const upsert = vi.fn(async (_args: unknown) => ({}));
  const deleteMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
  const findFirst = vi.fn(async (_args: unknown) => null);
  const gateway = {
    connected: async () => choices[0],
    connectedAll: async () => choices,
    connectedDevice: async (_userId: string, ref?: string) => resolveUserDevice(choices, ref),
    pairedSince: async () => new Date(0),
  } as unknown as UserDeviceGateway;
  const ctx = {
    deps: {
      userDevices: gateway,
      prisma: {
        userComputerPolicy: { findMany, upsert, deleteMany },
        bot: { findFirst },
        attempt: { count: async () => 1 },
      },
    },
    bot: { id: "bot-1", name: "Chief" },
    run: { spaceId: "space-1", userId: "user-1" },
    runId: "run-1",
    source: { userComputerOwner: "user-1", ownerStartedRun: true },
    state: {},
    trust: { receivedOutsideMessage: async () => false },
  } as unknown as RunContext;
  const call = (args: Record<string, unknown>) =>
    ({
      name: "user_computer_policy",
      args,
      finish: async (result: unknown) => result,
    }) as unknown as ToolCall;
  return { ctx, call, findMany, upsert, deleteMany, findFirst };
}

describe("userComputerPolicyGate", () => {
  it("lets a listing through and always confirms a change", () => {
    expect(userComputerPolicyGate(false, { action: "list" })).toBe("allow");
    expect(userComputerPolicyGate(false, { action: "allow" })).toBe("ask");
    expect(userComputerPolicyGate(true, { action: "list" })).toBe("deny");
  });
});

describe("userComputerPolicy", () => {
  it("lists every computer and the mode that applies to it", async () => {
    const { ctx, call, findMany } = setup([
      { deviceKey: "*", mode: "allow", expiresAt: null },
      { deviceKey: "device-2", mode: "ask", expiresAt: null },
    ]);
    const result = (await userComputerPolicy(ctx, call({ action: "list" }))) as { text: string };
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { botId: "bot-1" } }));
    expect(result.text).toBe(
      [
        "Chief:",
        "every computer: allow until revoked",
        `${choices[0]!.alias} (darwin): allow until revoked`,
        `${choices[1]!.alias} (win32): ask`,
      ].join("\n"),
    );
  });

  it("writes one bot's policy for the computer it names, with its own expiry", async () => {
    const { ctx, call, upsert } = setup();
    const result = (await userComputerPolicy(
      ctx,
      call({ action: "allow", computer: choices[1]!.alias, minutes: 90 }),
    )) as { text: string };
    const written = (
      upsert.mock.calls[0]?.[0] as {
        where: unknown;
        create: { deviceKey: string; mode: string; expiresAt: Date | null };
        update: unknown;
      }
    )?.create;
    expect(written?.deviceKey).toBe("device-2");
    expect(written?.mode).toBe("allow");
    expect(written?.expiresAt).toBeInstanceOf(Date);
    expect(result.text).toContain(`${choices[1]!.alias}`);
    expect(result.text).toContain("allow for 90m");
  });

  it("covers every computer when none is named", async () => {
    const { ctx, call, upsert } = setup();
    await userComputerPolicy(ctx, call({ action: "ask" }));
    expect(
      (upsert.mock.calls[0]![0] as { create: { deviceKey: string; expiresAt: Date | null } })
        .create,
    ).toMatchObject({ deviceKey: "*", expiresAt: null });
  });

  it("revokes only the named computer, and says so when nothing was granted", async () => {
    const { ctx, call, deleteMany } = setup();
    const result = (await userComputerPolicy(
      ctx,
      call({ action: "revoke", computer: choices[0]!.alias }),
    )) as { text: string };
    expect(deleteMany).toHaveBeenCalledWith({
      where: { botId: "bot-1", deviceKey: "device-1" },
    });
    expect(result.text).toContain("Revoked");
  });

  it("names the online computers instead of writing a policy for an unknown one", async () => {
    const { ctx, call, upsert } = setup();
    const result = (await userComputerPolicy(ctx, call({ action: "allow", computer: "nope" }))) as {
      error: string;
    };
    expect(result.error).toContain("No connected computer named");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses outside a chat the user started", async () => {
    const { ctx, call, upsert } = setup();
    (ctx.source as { ownerStartedRun: boolean }).ownerStartedRun = false;
    const result = (await userComputerPolicy(ctx, call({ action: "allow" }))) as { error: string };
    expect(result.error).toContain("only in a chat the user started");
    expect(upsert).not.toHaveBeenCalled();
  });
});
