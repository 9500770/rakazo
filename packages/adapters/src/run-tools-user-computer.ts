import path from "node:path";
import type { AgentToolExecutionResult, ProcessEvent } from "@rakazo/adapter-kit";
import type { ActionApprovalResolved, ApprovalMode } from "@rakazo/core";
import { planActionGate, redactSecrets, sandboxCommandTimeoutMs } from "@rakazo/core";
import { z } from "zod";
import type { HostComputerEnvironment } from "./host-computer-protocol.js";
import type {
  HostScreenAction,
  HostScreenActResult,
  HostScreenObservation,
} from "./host-screen.js";
import { HOST_SCREEN_MAX_ACTIONS, hostScreenAction } from "./host-screen.js";
import { nativeShellCommandArgv } from "./native-shell.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import {
  isRunningShellCommand,
  observeShellCommand,
  SHELL_STILL_RUNNING_NOTICE,
} from "./shell-command-stream.js";
import { userComputerApprovalMode, userComputerGrantTtlMs } from "./user-computer-approval.js";
import type { UserComputerPolicyRow } from "./user-computer-policy.js";
import { activeUserComputerPolicy, USER_COMPUTER_POLICY_ALL } from "./user-computer-policy.js";
import { userComputerPolicyStore } from "./user-computer-policy-store.js";
import {
  USER_COMPUTER_ACT_TOOL,
  USER_COMPUTER_OBSERVE_TOOL,
  USER_COMPUTER_POLICY_TOOL,
  USER_COMPUTER_SCREEN_TOOLS,
  USER_COMPUTER_SHELL_TOOL,
  USER_COMPUTER_TOOLS,
  userComputerAppName,
} from "./user-computer-tools.js";
import type { UserDeviceChoice } from "./user-device-alias.js";
import {
  computerAlias,
  pairedUserComputers,
  resolveUserDevice,
  safeDeviceLabel,
  userDevicePicker,
} from "./user-device-alias.js";
import type { UserDeviceGateway } from "./user-device-protocol.js";

export {
  USER_COMPUTER_ACT_TOOL,
  USER_COMPUTER_OBSERVE_TOOL,
  USER_COMPUTER_POLICY_TOOL,
  USER_COMPUTER_SCREEN_TOOLS,
  USER_COMPUTER_SHELL_TOOL,
  USER_COMPUTER_TOOLS,
  userComputerAppName,
};

/**
 * Whether the run's owner has a desktop connected, and which of their computers are online
 * (newest connection first). One online computer reads exactly like the single-computer past.
 */
export type UserComputerState =
  | { status: "connected"; devices: UserDeviceChoice[] }
  | { status: "offline" }
  | undefined;

const USER_COMPUTER_UNAVAILABLE =
  "The user's computer is not connected. Ask them to open the Rakazo desktop app.";

/**
 * Whose own computer this run may reach: the person whose message started it, when they own the
 * bot. Routines, webhooks, channels, other bots and other people's messages reach no one's.
 */
export function userComputerOwner(input: {
  trigger: string;
  sourceRole: string | undefined;
  messagingChannelRun: boolean;
  runUserId: string;
  botUserId: string;
}): string | undefined {
  if (input.trigger !== "user" && input.trigger !== "follow_up") return undefined;
  if (input.sourceRole !== "user" || input.messagingChannelRun) return undefined;
  return input.runUserId === input.botUserId ? input.runUserId : undefined;
}

export type UserComputerGateInput = {
  blocked: boolean;
  name: string;
  args: Record<string, unknown>;
  resolved: ActionApprovalResolved;
  /** Space approval mode; caller remaps space `never` to `auto` (real desktops stay reviewed). */
  mode: ApprovalMode;
  checkerConfigured: boolean;
};

/**
 * Whether a user-computer tool runs, asks, is judged, or is refused. Precedence:
 * 1. a space rule that blocks the tool
 * 2. `/pc` row for this computer, then `*`
 * 3. `RAKAZO_USER_COMPUTER_APPROVAL` never/always
 * 4. the space's planActionGate path (auto → judge when a checker is up; ask → card)
 *
 * Space `never` must already be remapped to `auto` by the caller: silent shell on a real desktop
 * is not an unattended-sandbox setting. Screen tools still honor a prior app approval when the
 * plan would ask. Shell is always consequential, so Auto always goes through the judge.
 */
export async function userComputerGate(
  ctx: RunContext,
  input: UserComputerGateInput,
): Promise<"deny" | "allow" | "ask" | "judge"> {
  const { blocked, name, args, resolved, mode, checkerConfigured } = input;
  if (blocked) return "deny";
  // An explicit row for this bot and computer beats everything else: it is what /PC wrote, and
  // the only place a person widens or refuses one combination without changing the rest.
  const policy = await userComputerPolicyFor(ctx, args);
  if (policy === "allow") return "allow";
  if (policy === "ask") return "ask";
  // The owner's own computers follow their own mode (see user-computer-approval.ts): a sandbox may
  // run unattended, a real desktop may be told to ask every time.
  const deployment = userComputerApprovalMode();
  if (deployment === "never") return "allow";
  if (deployment === "always") return "ask";
  // Same plan as every other consequential tool: Auto judges, Ask shows a card. Shell is always
  // consequential (a write is possible), so Auto never skips the judge on a "read-only" name.
  const plan = planActionGate({
    resolved,
    mode,
    consequential: true,
    checkerConfigured,
  });
  if (plan !== "ask" || !USER_COMPUTER_SCREEN_TOOLS.has(name)) return plan;
  if (await screenAppPreviouslyApproved(ctx, args)) return "allow";
  return "ask";
}

/** Alias and deviceKey of the computer a call targets, for the approval model's tool_args. */
export async function userComputerReviewTarget(
  ctx: RunContext,
  args: Record<string, unknown>,
): Promise<{ computer: string; deviceKey: string } | undefined> {
  const owner = ctx.source?.userComputerOwner;
  const devices = ctx.deps.userDevices;
  if (!owner || !devices) return undefined;
  const picker = userDevicePicker(devices);
  const device = picker
    ? await picker.connectedDevice(owner, computerArg(args.computer)).catch(() => null)
    : await devices.connected(owner).catch(() => null);
  if (!device) return undefined;
  return {
    computer: computerAlias(device.name, device.deviceId),
    deviceKey: device.deviceId,
  };
}

/**
 * The mode this bot's own row names for the computer a call targets, or undefined when no row
 * applies. The row for one computer wins over the row for all of them; an expired row is ignored.
 */
async function userComputerPolicyFor(
  ctx: RunContext,
  args: Record<string, unknown>,
): Promise<"ask" | "allow" | undefined> {
  const owner = ctx.source?.userComputerOwner;
  const devices = ctx.deps.userDevices;
  const store = userComputerPolicyStore(ctx.deps.prisma);
  if (!owner || !devices || !store || !ctx.bot?.id) return undefined;
  const device = await policyTargetDevice(devices, owner, computerArg(args.computer));
  let rows: UserComputerPolicyRow[];
  try {
    rows = await store.findMany({
      where: {
        botId: ctx.bot.id,
        deviceKey: {
          in: device ? [device.deviceId, USER_COMPUTER_POLICY_ALL] : [USER_COMPUTER_POLICY_ALL],
        },
      },
      select: { deviceKey: true, mode: true, expiresAt: true },
    });
  } catch {
    // A dropped ask row would let the space path (or never-ask) run. Fail closed.
    return "ask";
  }
  return activeUserComputerPolicy(rows, device?.deviceId);
}

/**
 * The computer a policy row is matched against. A named computer is resolved among paired
 * devices so a brief disconnect does not drop a per-machine row; unnamed uses the online
 * default that execute will actually run on.
 */
async function policyTargetDevice(
  devices: UserDeviceGateway,
  owner: string,
  ref: string | undefined,
): Promise<UserDeviceChoice | null> {
  const picker = userDevicePicker(devices);
  if (ref) {
    const paired = await pairedUserComputers(devices, owner);
    const named = resolveUserDevice(paired, ref);
    if (named) return named;
  }
  if (picker) return picker.connectedDevice(owner, ref).catch(() => null);
  const latest = await devices.connected(owner).catch(() => null);
  return latest ? { ...latest, alias: computerAlias(latest.name, latest.deviceId) } : null;
}

/** True when this space already approved the same app for this bot inside the grant window. */
async function screenAppPreviouslyApproved(
  ctx: RunContext,
  args: Record<string, unknown>,
): Promise<boolean> {
  const { deps, run } = ctx;
  const pairedSince = await deps.userDevices?.pairedSince(run.userId);
  if (!pairedSince) return false;
  // An expiring grant: only approvals recorded inside the window count, so access given for one
  // task ends on its own instead of lasting as long as the pairing.
  const ttl = userComputerGrantTtlMs();
  const since =
    ttl === undefined ? pairedSince : new Date(Math.max(pairedSince.getTime(), Date.now() - ttl));
  const where = {
    spaceId: run.spaceId,
    status: { in: ["approved", "executing", "completed", "uncertain"] },
    createdAt: { gte: since },
    // One bot's "Allow in this space" is not another bot's.
    run: { userId: run.userId, ...(ctx.bot?.id ? { botId: ctx.bot.id } : {}) },
  };
  const app = userComputerAppName(args.app).toLowerCase();
  if (!app) return false;
  // Every screen action records an effect, so page through them rather than cap the search.
  let cursor: string | undefined;
  for (;;) {
    const page = await deps.prisma.externalEffect.findMany({
      where: { ...where, kind: { in: [...USER_COMPUTER_SCREEN_TOOLS] } },
      select: { id: true, request: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: SCREEN_APPROVAL_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (
      page.some(
        (effect) =>
          userComputerAppName((effect.request as { app?: unknown } | null)?.app).toLowerCase() ===
          app,
      )
    )
      return true;
    if (page.length < SCREEN_APPROVAL_PAGE) return false;
    cursor = page.at(-1)!.id;
  }
}

const SCREEN_APPROVAL_PAGE = 200;

/** The working directory on the user's computer: their home or a folder inside it. */
export function userComputerCwd(environment: HostComputerEnvironment, cwd: unknown): string {
  const paths = environment.platform === "win32" ? path.win32 : path.posix;
  const requested = typeof cwd === "string" ? cwd.trim() : "";
  if (!requested || requested === "~") return environment.home;
  const expanded = /^~[\\/]/.test(requested)
    ? paths.join(environment.home, requested.slice(2))
    : requested;
  const resolved = paths.resolve(environment.home, expanded);
  const relative = paths.relative(environment.home, resolved);
  if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative))
    throw new Error("cwd must be inside the user's home folder; cd elsewhere within the command");
  return resolved;
}

async function lastValue<T>(values: AsyncIterable<T>): Promise<T> {
  let result: { value: T } | undefined;
  for await (const value of values) result = { value };
  if (!result) throw new Error("no response");
  return result.value;
}

/** A connected computer to run on, or the online list behind an unknown `computer` argument. */
type ConnectedUserComputer =
  | { owner: string; devices: UserDeviceGateway; deviceId: string; alias: string }
  | { unknown: { online: UserDeviceChoice[]; ref: string } };

/** The `computer` argument as a reference, when the model sent a usable one. */
function computerArg(value: unknown): string | undefined {
  const ref = typeof value === "string" ? value.trim() : "";
  return ref ? ref.slice(0, 120) : undefined;
}

/**
 * Checked again at execution: the desktop can disconnect or be revoked after the offer. A
 * `computer` argument names one of the online devices; without it the latest one runs, as
 * before. An unknown name carries the online list back, and nothing is sent to any device.
 */
async function connectedUserComputer(
  ctx: RunContext,
  ref?: string,
): Promise<ConnectedUserComputer | undefined> {
  const owner = ctx.source.userComputerOwner;
  const devices = ctx.deps.userDevices;
  if (!owner || !devices) return undefined;
  const picker = userDevicePicker(devices);
  const device = picker
    ? await picker.connectedDevice(owner, ref).catch(() => null)
    : await devices.connected(owner).catch(() => null);
  if (device)
    return {
      owner,
      devices,
      deviceId: device.deviceId,
      alias: computerAlias(device.name, device.deviceId),
    };
  // A name that matched nothing is told which computers are online. With none online, the
  // ordinary unavailable message applies whether or not one was named.
  if (ref && picker) {
    const online = await picker.connectedAll(owner).catch(() => []);
    if (online.length) return { unknown: { online, ref } };
  }
  return undefined;
}

/** Which computer the model could have named, as the error hands back. */
function unknownComputerError(unknown: { online: UserDeviceChoice[]; ref: string }): string {
  const online = unknown.online
    .map((device) => `${device.alias} (${safeDeviceLabel(device.platform)})`)
    .join(", ");
  return `No connected computer named "${unknown.ref}". Online: ${online}, or omit computer to use the default.`;
}

export async function userComputerShell(ctx: RunContext, call: ToolCall) {
  const { bot, runId } = ctx;
  const connected = await connectedUserComputer(ctx, computerArg(call.args.computer));
  if (!connected) return call.finish({ error: USER_COMPUTER_UNAVAILABLE });
  if ("unknown" in connected)
    return call.finish({ error: unknownComputerError(connected.unknown) });
  const { owner, devices, deviceId, alias } = connected;
  const { signal } = ctx.context;
  const command = String(call.args.command ?? "");
  try {
    // The device only executes for a provisioned bot; provisioning is idempotent.
    await lastValue(
      devices.request(owner, { method: "provision", botId: bot.id, runId }, signal, deviceId),
    );
    const environment = await lastValue(
      devices.request<HostComputerEnvironment>(
        owner,
        { method: "environment", botId: bot.id, runId },
        signal,
        deviceId,
      ),
    );
    const observed = await observeShellCommand(
      devices.request<ProcessEvent>(
        owner,
        {
          method: "execute",
          botId: bot.id,
          runId,
          command: {
            argv: nativeShellCommandArgv(command, environment),
            cwd: userComputerCwd(environment, call.args.cwd),
            timeoutMs: sandboxCommandTimeoutMs(),
          },
        },
        signal,
        deviceId,
      ),
      { secrets: ctx.secrets },
    );
    if (!observed.completion) return call.finish({ ...observed.result, computer: alias });
    void observed.completion.catch(() => undefined);
    const returned = await call.finish({
      ...observed.result,
      computer: alias,
      notice: SHELL_STILL_RUNNING_NOTICE,
    });
    if (isRunningShellCommand(returned)) call.observer?.onShellStillRunning?.(observed.completion);
    return returned;
  } catch (error) {
    if (signal.aborted) throw error;
    const reason = redactSecrets(
      error instanceof Error ? error.message : "command failed",
      ctx.secrets,
    );
    return call.finish({ error: `The user's computer did not finish the command: ${reason}` });
  }
}

const screenActions = z.array(hostScreenAction).min(1).max(HOST_SCREEN_MAX_ACTIONS);

export function userComputerObserve(ctx: RunContext, call: ToolCall) {
  const query = typeof call.args.query === "string" ? call.args.query.trim() : "";
  return userComputerScreen(ctx, call, {
    method: "screenObserve",
    app: userComputerAppName(call.args.app),
    ...(query ? { query } : {}),
  });
}

export function userComputerAct(ctx: RunContext, call: ToolCall) {
  const actions = screenActions.safeParse(call.args.actions);
  if (!actions.success) {
    const issue = actions.error.issues[0];
    const where = issue?.path.length ? `actions.${issue.path.join(".")}: ` : "actions: ";
    return call.finish({ error: `${where}${issue?.message ?? "invalid"}` });
  }
  return userComputerScreen(ctx, call, {
    method: "screenAct",
    app: userComputerAppName(call.args.app),
    actions: actions.data,
  });
}

type ScreenRequest =
  | { method: "screenObserve"; app: string; query?: string }
  | { method: "screenAct"; app: string; actions: HostScreenAction[] };

/** The device gets the app name the approval card showed, never the raw argument. */
async function userComputerScreen(ctx: RunContext, call: ToolCall, request: ScreenRequest) {
  if (!request.app) return call.finish({ error: "app must name an app on the user's computer." });
  const connected = await connectedUserComputer(ctx, computerArg(call.args.computer));
  if (!connected) return call.finish({ error: USER_COMPUTER_UNAVAILABLE });
  if ("unknown" in connected)
    return call.finish({ error: unknownComputerError(connected.unknown) });
  const { owner, devices, deviceId, alias } = connected;
  const { signal } = ctx.context;
  try {
    const value = await lastValue(
      devices.request<HostScreenObservation | HostScreenActResult>(
        owner,
        { ...request, botId: ctx.bot.id, runId: ctx.runId },
        signal,
        deviceId,
      ),
    );
    if (request.method === "screenObserve")
      return call.finish(screenToolResult(ctx, value as HostScreenObservation, "observed", alias));
    const acted = value as HostScreenActResult;
    const total = request.actions.length;
    const note = `completed ${acted.completed} of ${total} action${total === 1 ? "" : "s"}${
      acted.error ? `; stopped: ${redactSecrets(acted.error, ctx.secrets)}` : ""
    }`;
    return call.finish(
      acted.observation
        ? screenToolResult(ctx, acted.observation, note, alias)
        : {
            completed: acted.completed,
            computer: alias,
            ...(acted.error ? { error: note } : {}),
          },
    );
  } catch (error) {
    if (signal.aborted) throw error;
    const reason = redactSecrets(
      error instanceof Error ? error.message : "screen control failed",
      ctx.secrets,
    );
    return call.finish({ error: `The user's computer did not finish: ${reason}` });
  }
}

/** Only the window's name and size are stored; the rows and screenshot reach the model alone. */
function screenToolResult(
  ctx: RunContext,
  observation: HostScreenObservation,
  note: string,
  computer: string,
): AgentToolExecutionResult {
  const image = ctx.computer.acceptsImages ? observation.image : undefined;
  const details = {
    app: observation.app,
    computer,
    ...(observation.title ? { title: redactSecrets(observation.title, ctx.secrets) } : {}),
    ...(image ? { width: image.width, height: image.height } : {}),
  };
  return {
    kind: "agent_tool_result",
    content: [
      {
        type: "text",
        text: `${note}\n${JSON.stringify(details)}\n${redactSecrets(observation.tree, ctx.secrets)}`,
      },
      ...(image ? [{ type: "image" as const, data: image.data, mimeType: image.mimeType }] : []),
    ],
    details,
  };
}
