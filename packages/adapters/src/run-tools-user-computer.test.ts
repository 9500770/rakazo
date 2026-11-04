import type { ActionApprovalResolved } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import {
  userComputerCwd,
  userComputerGate,
  userComputerObserve,
  userComputerOwner,
  userComputerShell,
  type UserComputerGateInput,
} from "./run-tools-user-computer.js";
import { userComputerApprovalMode, userComputerGrantTtlMs } from "./user-computer-approval.js";
import { computerAlias, resolveUserDevice } from "./user-device-alias.js";
import type { UserDeviceGateway } from "./user-device-protocol.js";

const unruled: ActionApprovalResolved = {
  decision: "allow",
  source: "default",
  matchingRules: [],
  decisiveRules: [],
};

function gate(
  ctx: RunContext,
  blocked: boolean,
  name: string,
  args: Record<string, unknown>,
  overrides: Partial<UserComputerGateInput> = {},
) {
  return userComputerGate(ctx, {
    blocked,
    name,
    args,
    resolved: unruled,
    mode: "ask",
    checkerConfigured: false,
    ...overrides,
  });
}

const environment = { platform: "darwin", home: "/Users/fake", shell: "/bin/zsh" };

function setup(execute: (signal: AbortSignal) => AsyncIterable<unknown>, secrets: string[] = []) {
  const controller = new AbortController();
  const requests: HostComputerRequest[] = [];
  const signals: AbortSignal[] = [];
  const deviceIds: (string | undefined)[] = [];
  const gateway: UserDeviceGateway = {
    connected: async () => ({ deviceId: "device-1", name: "Laptop", platform: "darwin" }),
    pairedSince: async () => new Date(0),
    async *request<T>(
      _userId: string,
      request: HostComputerRequest,
      signal: AbortSignal,
      deviceId?: string,
    ) {
      requests.push(request);
      deviceIds.push(deviceId);
      signals.push(signal);
      if (request.method === "provision") yield {} as T;
      else if (request.method === "environment") yield environment as T;
      else yield* execute(signal) as AsyncIterable<T>;
    },
  };
  const ctx = {
    deps: { userDevices: gateway },
    bot: { id: "bot-1" },
    runId: "run-1",
    source: { userComputerOwner: "user-1" },
    context: { signal: controller.signal },
    secrets,
  } as unknown as RunContext;
  const onShellStillRunning = vi.fn();
  const call = (args: Record<string, unknown>) =>
    ({
      name: "user_computer_shell",
      args,
      observer: { onShellStillRunning },
      finish: async (result: unknown) => result,
    }) as unknown as ToolCall;
  return { ctx, call, controller, requests, signals, deviceIds, onShellStillRunning };
}

/** A gateway over several online computers, newest connection first (see connectedAll). */
function setupDevices(
  online: Array<{ deviceId: string; name: string; platform: string }>,
  execute: (signal: AbortSignal) => AsyncIterable<unknown> = async function* () {
    yield { type: "stdout", data: "ok\n" };
    yield { type: "exit", code: 0 };
  },
) {
  const controller = new AbortController();
  const requests: HostComputerRequest[] = [];
  const deviceIds: (string | undefined)[] = [];
  const choices = online.map((device) => ({
    ...device,
    alias: computerAlias(device.name, device.deviceId),
  }));
  const gateway = {
    connected: async () => choices[0] ?? null,
    connectedAll: async () => choices,
    connectedDevice: async (_userId: string, ref?: string) => resolveUserDevice(choices, ref),
    pairedSince: async () => new Date(0),
    async *request<T>(
      _userId: string,
      request: HostComputerRequest,
      signal: AbortSignal,
      deviceId?: string,
    ) {
      requests.push(request);
      deviceIds.push(deviceId);
      if (request.method === "provision") yield {} as T;
      else if (request.method === "environment") yield environment as T;
      else yield* execute(signal) as AsyncIterable<T>;
    },
  } as unknown as UserDeviceGateway;
  const ctx = {
    deps: { userDevices: gateway },
    bot: { id: "bot-1" },
    runId: "run-1",
    source: { userComputerOwner: "user-1" },
    context: { signal: controller.signal },
    secrets: [],
    computer: { acceptsImages: false },
  } as unknown as RunContext;
  const call = (args: Record<string, unknown>) =>
    ({
      name: "user_computer_shell",
      args,
      observer: { onShellStillRunning: vi.fn() },
      finish: async (result: unknown) => result,
    }) as unknown as ToolCall;
  return { ctx, call, requests, deviceIds, choices, controller };
}

describe("userComputerGate", () => {
  it("finds an app approved before hundreds of later screen actions", async () => {
    const effects = [
      ...Array.from({ length: 450 }, (_, index) => ({ id: `e${450 - index}`, app: "TextEdit" })),
      { id: "e0", app: "Mail" },
    ].map(({ id, app }) => ({ id, request: { app } }));
    const findMany = vi.fn(async ({ take, cursor }: { take: number; cursor?: { id: string } }) => {
      const start = cursor ? effects.findIndex((effect) => effect.id === cursor.id) + 1 : 0;
      return effects.slice(start, start + take);
    });
    const ctx = {
      deps: {
        userDevices: { pairedSince: async () => new Date(0) },
        prisma: { externalEffect: { findMany } },
      },
      run: { spaceId: "space-1", userId: "user-1" },
    } as unknown as RunContext;
    await expect(gate(ctx, false, "user_computer_observe", { app: "mail" })).resolves.toBe(
      "allow",
    );
    expect(findMany).toHaveBeenCalledTimes(3);
    await expect(gate(ctx, false, "user_computer_observe", { app: "Notes" })).resolves.toBe("ask");
  });
});

describe("userComputerApprovalMode", () => {
  it("defaults to ask and reads the mode from the environment", () => {
    expect(userComputerApprovalMode({})).toBe("ask");
    expect(userComputerApprovalMode({ RAKAZO_USER_COMPUTER_APPROVAL: " always " })).toBe("always");
    expect(userComputerApprovalMode({ RAKAZO_USER_COMPUTER_APPROVAL: "NEVER" })).toBe("never");
    expect(userComputerApprovalMode({ RAKAZO_USER_COMPUTER_APPROVAL: "yes" })).toBe("ask");
  });
});

describe("userComputerGrantTtlMs", () => {
  it("reads an expiring grant window in minutes and ignores values it cannot use", () => {
    expect(userComputerGrantTtlMs({})).toBeUndefined();
    expect(userComputerGrantTtlMs({ RAKAZO_USER_COMPUTER_GRANT_TTL: "30" })).toBe(30 * 60_000);
    expect(userComputerGrantTtlMs({ RAKAZO_USER_COMPUTER_GRANT_TTL: "0" })).toBeUndefined();
    expect(userComputerGrantTtlMs({ RAKAZO_USER_COMPUTER_GRANT_TTL: "soon" })).toBeUndefined();
    expect(userComputerGrantTtlMs({ RAKAZO_USER_COMPUTER_GRANT_TTL: "9999" })).toBe(
      24 * 60 * 60_000,
    );
  });
});

describe("userComputerGate approval mode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function gatedContext() {
    const lookup = vi.fn(async () => {
      throw new Error("the mode decides without looking up earlier approvals");
    });
    const ctx = {
      deps: {
        userDevices: { pairedSince: async () => new Date(0) },
        prisma: { externalEffect: { findMany: lookup, findFirst: lookup } },
      },
      run: { spaceId: "space-1", userId: "user-1" },
    } as unknown as RunContext;
    return { ctx, lookup };
  }

  it("asks every time in always mode, even after this space allowed it", async () => {
    vi.stubEnv("RAKAZO_USER_COMPUTER_APPROVAL", "always");
    const { ctx, lookup } = gatedContext();
    await expect(gate(ctx, false, "user_computer_shell", { command: "ls" })).resolves.toBe("ask");
    await expect(gate(ctx, false, "user_computer_observe", { app: "Mail" })).resolves.toBe("ask");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("runs in never mode, and still refuses a block", async () => {
    vi.stubEnv("RAKAZO_USER_COMPUTER_APPROVAL", "never");
    const { ctx } = gatedContext();
    await expect(gate(ctx, false, "user_computer_shell", { command: "ls" })).resolves.toBe(
      "allow",
    );
    await expect(gate(ctx, true, "user_computer_shell", { command: "ls" })).resolves.toBe("deny");
  });

  it("counts only app approvals inside the grant window when one is set", async () => {
    vi.stubEnv("RAKAZO_USER_COMPUTER_GRANT_TTL", "30");
    const findMany = vi.fn(async (_args: unknown) => []);
    const ctx = {
      deps: {
        userDevices: { pairedSince: async () => new Date(0) },
        prisma: { externalEffect: { findMany } },
      },
      run: { spaceId: "space-1", userId: "user-1" },
    } as unknown as RunContext;
    await expect(gate(ctx, false, "user_computer_observe", { app: "Mail" })).resolves.toBe("ask");
    const where = (
      findMany.mock.calls[0]?.[0] as { where: { createdAt: { gte: Date } } } | undefined
    )?.where;
    if (!where) throw new Error("the gate looked up earlier approvals");
    const age = Date.now() - where.createdAt.gte.getTime();
    expect(age).toBeGreaterThan(29 * 60_000);
    expect(age).toBeLessThan(31 * 60_000);
  });

  it("asks for a command in ask mode, and never reads shell approvals back", async () => {
    vi.stubEnv("RAKAZO_USER_COMPUTER_APPROVAL", "");
    const findFirst = vi.fn(async (_args: unknown) => ({ id: "earlier" }));
    const ctx = {
      deps: {
        userDevices: { pairedSince: async () => new Date(0) },
        prisma: { externalEffect: { findFirst, findMany: vi.fn(async () => []) } },
      },
      run: { spaceId: "space-1", userId: "user-1" },
      bot: { id: "bot-1" },
    } as unknown as RunContext;
    await expect(gate(ctx, false, "user_computer_shell", { command: "ls" })).resolves.toBe("ask");
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("asks once per app in ask mode, the default", async () => {
    vi.stubEnv("RAKAZO_USER_COMPUTER_APPROVAL", "");
    const findMany = vi.fn(async () => [{ id: "e1", request: { app: "Mail" } }]);
    const ctx = {
      deps: {
        userDevices: { pairedSince: async () => new Date(0) },
        prisma: { externalEffect: { findMany, findFirst: vi.fn(async () => ({ id: "e1" })) } },
      },
      run: { spaceId: "space-1", userId: "user-1" },
    } as unknown as RunContext;
    await expect(gate(ctx, false, "user_computer_observe", { app: "Mail" })).resolves.toBe(
      "allow",
    );
    await expect(gate(ctx, false, "user_computer_observe", { app: "Notes" })).resolves.toBe("ask");
  });

  it("judges shell in auto when a checker is configured, and asks without one", async () => {
    vi.stubEnv("RAKAZO_USER_COMPUTER_APPROVAL", "");
    const { ctx, lookup } = gatedContext();
    await expect(
      gate(ctx, false, "user_computer_shell", { command: "ls" }, {
        mode: "auto",
        checkerConfigured: true,
      }),
    ).resolves.toBe("judge");
    await expect(
      gate(ctx, false, "user_computer_shell", { command: "ls" }, {
        mode: "auto",
        checkerConfigured: false,
      }),
    ).resolves.toBe("ask");
    expect(lookup).not.toHaveBeenCalled();
  });

});

describe("userComputerOwner", () => {
  const own = {
    trigger: "user",
    sourceRole: "user",
    messagingChannelRun: false,
    runUserId: "user-1",
    botUserId: "user-1",
  };

  it("is the bot owner when their own message started the run", () => {
    expect(userComputerOwner(own)).toBe("user-1");
    expect(userComputerOwner({ ...own, trigger: "follow_up" })).toBe("user-1");
  });

  it.each([
    { trigger: "routine" },
    { trigger: "webhook" },
    { trigger: "messaging" },
    { trigger: "call_end" },
    { sourceRole: "bot" },
    { sourceRole: undefined },
    { messagingChannelRun: true },
    { runUserId: "user-2" },
  ])("is nobody for %o", (change) => {
    expect(userComputerOwner({ ...own, ...change })).toBeUndefined();
  });
});

describe("userComputerCwd", () => {
  it("defaults to home and resolves relative and ~ paths against it", () => {
    expect(userComputerCwd(environment, undefined)).toBe("/Users/fake");
    expect(userComputerCwd(environment, "~")).toBe("/Users/fake");
    expect(userComputerCwd(environment, "~/code")).toBe("/Users/fake/code");
    expect(userComputerCwd(environment, "code")).toBe("/Users/fake/code");
    expect(userComputerCwd(environment, "/Users/fake/code")).toBe("/Users/fake/code");
    expect(userComputerCwd(environment, "..cache")).toBe("/Users/fake/..cache");
    expect(() => userComputerCwd(environment, "/tmp")).toThrow("inside the user's home folder");
    expect(() => userComputerCwd(environment, "../other")).toThrow("inside the user's home folder");
    expect(
      userComputerCwd({ platform: "win32", home: "C:\\Users\\fake", shell: "pwsh" }, "code"),
    ).toBe("C:\\Users\\fake\\code");
  });
});

describe("userComputerShell", () => {
  it("streams the command's redacted output from the user's shell", async () => {
    const { ctx, call, requests, deviceIds } = setup(
      async function* () {
        yield { type: "stdout", data: "token=sk-fake-secret\n" };
        yield { type: "stderr", data: "warning\n" };
        yield { type: "exit", code: 2 };
      },
      ["sk-fake-secret"],
    );
    const result = (await userComputerShell(ctx, call({ command: "cat .env", cwd: "app" }))) as {
      stdout: string;
      stderr: string;
      code: number;
    };
    expect(result.stdout).not.toContain("sk-fake-secret");
    expect(result).toMatchObject({ stderr: "warning\n", code: 2 });
    expect(deviceIds).toEqual(["device-1", "device-1", "device-1"]);
    expect(requests).toEqual([
      { method: "provision", botId: "bot-1", runId: "run-1" },
      { method: "environment", botId: "bot-1", runId: "run-1" },
      {
        method: "execute",
        botId: "bot-1",
        runId: "run-1",
        command: expect.objectContaining({
          argv: ["/bin/zsh", "-lc", "cat .env"],
          cwd: "/Users/fake/app",
        }),
      },
    ]);
  });

  it("returns a quiet long-running command early and keeps collecting its output", async () => {
    let finish!: () => void;
    const exited = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.useFakeTimers();
    try {
      const { ctx, call, onShellStillRunning } = setup(async function* () {
        yield { type: "stdout", data: "Enter code ABCD\n" };
        await exited;
        yield { type: "exit", code: 0 };
      });
      const pending = userComputerShell(ctx, call({ command: "gh auth login" }));
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await pending).toMatchObject({ stdout: "Enter code ABCD\n", running: true });
      expect(onShellStillRunning).toHaveBeenCalledOnce();
      finish();
      await expect(onShellStillRunning.mock.calls[0]![0]).resolves.toMatchObject({ code: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a device that drops mid-command as an error result", async () => {
    const { ctx, call } = setup(async function* () {
      yield* [];
      throw new Error("Device disconnected");
    });
    expect(await userComputerShell(ctx, call({ command: "ls" }))).toEqual({
      error: "The user's computer did not finish the command: Device disconnected",
    });
  });

  it("passes the run's abort to the device and rethrows it", async () => {
    const { ctx, call, controller, signals } = setup(async function* (signal) {
      yield* [];
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("aborted");
    });
    const pending = userComputerShell(ctx, call({ command: "sleep 100" }));
    await vi.waitFor(() => expect(signals).toHaveLength(3));
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});

describe("userComputerShell device selection", () => {
  const online = [
    { deviceId: "dev-desk0001", name: "Desk PC", platform: "darwin" },
    { deviceId: "dev-lap0002", name: "MacBook", platform: "win32" },
  ];

  it("runs on the device whose alias the computer argument names", async () => {
    const { ctx, call, requests, deviceIds } = setupDevices(online);
    const result = (await userComputerShell(
      ctx,
      call({ command: "ls", computer: "macbook-0002" }),
    )) as {
      computer: string;
    };
    expect(result.computer).toBe("macbook-0002");
    expect(deviceIds).toEqual(["dev-lap0002", "dev-lap0002", "dev-lap0002"]);
    expect(requests.every((request) => request.botId === "bot-1")).toBe(true);
  });

  it("reports which computers are online for an unknown alias and sends no request", async () => {
    const { ctx, call, requests, deviceIds } = setupDevices(online);
    expect(await userComputerShell(ctx, call({ command: "ls", computer: "office-pc" }))).toEqual({
      error:
        'No connected computer named "office-pc". Online: desk-pc-0001 (darwin), macbook-0002 (win32), or omit computer to use the default.',
    });
    expect(requests).toEqual([]);
    expect(deviceIds).toEqual([]);
  });

  it("still runs on the latest device without a computer argument", async () => {
    const { ctx, call, deviceIds } = setupDevices(online);
    const result = (await userComputerShell(ctx, call({ command: "ls" }))) as { computer: string };
    expect(result.computer).toBe("desk-pc-0001");
    expect(deviceIds).toEqual(["dev-desk0001", "dev-desk0001", "dev-desk0001"]);
  });

  it("keeps the single-device message when nothing is online, named or not", async () => {
    const offline = setupDevices([]);
    expect(await userComputerShell(offline.ctx, offline.call({ command: "ls" }))).toEqual({
      error: "The user's computer is not connected. Ask them to open the Rakazo desktop app.",
    });
    const named = setupDevices([]);
    expect(
      await userComputerShell(named.ctx, named.call({ command: "ls", computer: "desk-pc-0001" })),
    ).toEqual({
      error: "The user's computer is not connected. Ask them to open the Rakazo desktop app.",
    });
    expect(offline.requests).toEqual([]);
  });

  it("falls back to the latest device on a gateway that cannot list several", async () => {
    const { ctx, call, deviceIds } = setup(async function* () {
      yield { type: "exit", code: 0 };
    });
    const result = (await userComputerShell(ctx, call({ command: "ls" }))) as { computer?: string };
    // A gateway without connectedAll runs exactly as before, alias or not.
    expect(result).not.toHaveProperty("error");
    expect(deviceIds).toEqual(["device-1", "device-1", "device-1"]);
  });

  it("observes on a named device and says which one answered", async () => {
    const { ctx, call, requests, deviceIds } = setupDevices(online, async function* () {
      yield {
        app: "Mail",
        title: "Inbox",
        tree: '- [0] AXWindow "Inbox"',
      };
    });
    const result = (await userComputerObserve(
      ctx,
      call({ app: "Mail", computer: "macbook-0002" }),
    )) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]!.text).toContain('"computer":"macbook-0002"');
    expect(deviceIds).toEqual(["dev-lap0002"]);
    expect(requests[0]).toMatchObject({ method: "screenObserve", app: "Mail" });
  });
});

describe("userComputerGate policy rows", () => {
  const choices = [
    { deviceId: "device-1", name: "Laptop", platform: "darwin" },
    { deviceId: "device-2", name: "Office PC", platform: "win32" },
  ].map((device) => ({ ...device, alias: computerAlias(device.name, device.deviceId) }));

  function policyContext(
    rows: Array<{ deviceKey: string; mode: string; expiresAt: Date | null }>,
    withStore = true,
  ) {
    const findMany = vi.fn(async (_args: unknown) => rows);
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
          ...(withStore
            ? {
                userComputerPolicy: {
                  findMany,
                  upsert: vi.fn(async () => ({})),
                  deleteMany: vi.fn(async () => ({ count: 0 })),
                },
              }
            : {}),
          externalEffect: { findFirst, findMany: vi.fn(async () => []) },
        },
      },
      bot: { id: "bot-1" },
      run: { spaceId: "space-1", userId: "user-1" },
      source: { userComputerOwner: "user-1" },
    } as unknown as RunContext;
    return { ctx, findMany, findFirst };
  }

  it("runs where this bot's row allows that computer, skipping the judge", async () => {
    const { ctx, findMany } = policyContext([
      { deviceKey: "device-1", mode: "allow", expiresAt: null },
    ]);
    await expect(
      gate(ctx, false, "user_computer_shell", { command: "ls" }, {
        mode: "auto",
        checkerConfigured: true,
      }),
    ).resolves.toBe("allow");
    expect(
      (findMany.mock.calls[0]?.[0] as { where: { botId: string } } | undefined)?.where.botId,
    ).toBe("bot-1");
  });

  it("keeps another computer on the space path when only one row allows", async () => {
    const { ctx } = policyContext([{ deviceKey: "device-1", mode: "allow", expiresAt: null }]);
    await expect(
      gate(ctx, false, "user_computer_shell", {
        command: "ls",
        computer: choices[1]!.alias,
      }),
    ).resolves.toBe("ask");
  });

  it("lets a row for one computer hold back a row for all of them", async () => {
    const rows = [
      { deviceKey: "*", mode: "allow", expiresAt: null },
      { deviceKey: "device-2", mode: "ask", expiresAt: null },
    ];
    const { ctx } = policyContext(rows);
    await expect(gate(ctx, false, "user_computer_shell", { command: "ls" })).resolves.toBe(
      "allow",
    );
    await expect(
      gate(ctx, false, "user_computer_shell", {
        command: "ls",
        computer: choices[1]!.alias,
      }),
    ).resolves.toBe("ask");
  });

  it("ignores a grant that has expired", async () => {
    const { ctx } = policyContext([
      { deviceKey: "device-1", mode: "allow", expiresAt: new Date(Date.now() - 60_000) },
    ]);
    await expect(gate(ctx, false, "user_computer_shell", { command: "ls" })).resolves.toBe("ask");
  });

  it("asks for a command when no row allows that computer, whatever the space approved before", async () => {
    const { ctx, findFirst } = policyContext([], false);
    await expect(gate(ctx, false, "user_computer_shell", { command: "ls" })).resolves.toBe("ask");
    expect(findFirst).not.toHaveBeenCalled();
  });
});
