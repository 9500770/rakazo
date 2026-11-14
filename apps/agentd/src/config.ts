import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";

/** What the server gave back once, at pairing time. The token is the only copy. */
export interface PairedDevice {
  deviceId: string;
  userId: string;
  token: string;
}

/**
 * The sign-in that paired this computer. Rakazo ties a pairing to the sign-in that made it, so the
 * agent keeps that cookie and refreshes it; without it the pairing ends when the sign-in does.
 */
export interface SavedSignIn {
  cookie: string;
  /** When it lapses unless a request refreshes it. Better Auth rolls it forward on use. */
  expiresAt: string;
}

export interface Account {
  email: string;
  /** Saved only with `setup --remember`, so a sign-in that ended can pair this computer again. */
  password?: string;
}

/**
 * How much bot work this computer accepts:
 * - `auto`  — every request from the paired account's bots runs.
 * - `ask`   — nothing runs until a person on this machine approves with `agentd unlock`; the
 *             approval lapses after `askMinutes`, so a stolen laptop never stays open overnight.
 * - `deny`  — nothing runs, and the agent stays connected so turning it back on needs no setup.
 */
export type AgentMode = "auto" | "ask" | "deny";

export interface AgentConfig {
  version: 1;
  serverUrl: string;
  /** Shown in the server's computer list. */
  name: string;
  mode: AgentMode;
  /** How long one `unlock` approves requests for. */
  askMinutes: number;
  /** Post a desktop notification when approval is needed, at most once per `notifyMinutes`. */
  notify: boolean;
  notifyMinutes: number;
  /** Where bot workspaces live. Defaults to `~/.rakazo-agent/computers`. */
  workspaceRoot: string | null;
  /** Extra environment for bot commands, e.g. a proxy or a toolchain `PATH`. */
  env: Record<string, string>;
  /** Reconnect backoff for the device socket. */
  retryMs: { min: number; max: number };
  /** How often the paired sign-in is refreshed, in hours. */
  sessionRefreshHours: number;
  /** `agent.log` is renamed to `agent.log.1` past this size, so a long-lived daemon cannot fill a disk. */
  logMaxBytes: number;
  device: PairedDevice | null;
  signIn: SavedSignIn | null;
  account: Account | null;
}

const MAX_CONFIG_BYTES = 64 * 1024;
/** Quick at first, then one attempt every minute or two while the server stays away. */
const DEFAULT_RETRY = { min: 5_000, max: 120_000 };

/** `RAKAZO_AGENT_HOME` keeps a second agent (or a test) beside the real one. */
export function agentHome(): string {
  return process.env.RAKAZO_AGENT_HOME ?? path.join(homedir(), ".rakazo-agent");
}

export const configPath = () => path.join(agentHome(), "config.json");
export const pausedPath = () => path.join(agentHome(), "paused");
export const unlockPath = () => path.join(agentHome(), "unlocked-until");
export const pidPath = () => path.join(agentHome(), "agent.pid");
export const logPath = () => path.join(agentHome(), "agent.log");

/** Expands a leading `~` the way a shell would, without asking one. */
export function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
}

export function defaultConfig(serverUrl: string, name: string): AgentConfig {
  return {
    version: 1,
    serverUrl,
    name,
    mode: "ask",
    askMinutes: 30,
    notify: true,
    notifyMinutes: 15,
    workspaceRoot: null,
    env: {},
    retryMs: { ...DEFAULT_RETRY },
    sessionRefreshHours: 6,
    logMaxBytes: 5 * 1024 * 1024,
    device: null,
    signIn: null,
    account: null,
  };
}

export function workspaceRoot(config: AgentConfig): string {
  return config.workspaceRoot ? expandHome(config.workspaceRoot) : path.join(agentHome(), "computers");
}

export function defaultName(): string {
  const host = hostname().split(".", 1)[0] ?? "computer";
  return host.slice(0, 128) || "computer";
}

export async function readConfig(): Promise<AgentConfig | null> {
  let raw: string;
  try {
    const bytes = await readFile(configPath());
    if (bytes.byteLength > MAX_CONFIG_BYTES) return null;
    raw = bytes.toString("utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AgentConfig>;
    if (parsed?.version !== 1 || typeof parsed.serverUrl !== "string" || !parsed.serverUrl)
      return null;
    const base = defaultConfig(parsed.serverUrl, defaultName());
    return {
      ...base,
      name: nonEmpty(parsed.name) ?? base.name,
      mode: modeOf(parsed.mode) ?? base.mode,
      askMinutes: minutes(parsed.askMinutes) ?? base.askMinutes,
      notify: typeof parsed.notify === "boolean" ? parsed.notify : base.notify,
      notifyMinutes: minutes(parsed.notifyMinutes) ?? base.notifyMinutes,
      workspaceRoot: nonEmpty(parsed.workspaceRoot) ?? null,
      env: stringRecord(parsed.env),
      retryMs: retryOf(parsed.retryMs) ?? base.retryMs,
      sessionRefreshHours: hours(parsed.sessionRefreshHours) ?? base.sessionRefreshHours,
      logMaxBytes: bytes(parsed.logMaxBytes) ?? base.logMaxBytes,
      device: deviceOrNull(parsed.device),
      signIn: signInOrNull(parsed.signIn),
      account: accountOrNull(parsed.account),
    };
  } catch {
    return null;
  }
}

/** Written whole and renamed into place, so a crash never leaves half a token behind. */
export async function writeConfig(config: AgentConfig): Promise<void> {
  const home = agentHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = `${configPath()}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, configPath());
  await chmod(configPath(), 0o600).catch(() => undefined);
}

export function modeOf(value: unknown): AgentMode | null {
  return value === "auto" || value === "ask" || value === "deny" ? value : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function minutes(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 10_080
    ? value
    : null;
}

function hours(value: unknown): number | null {
  return typeof value === "number" && value > 0 && value <= 24 * 30 ? value : null;
}

function bytes(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 64 * 1024 && value <= 1024 ** 3
    ? value
    : null;
}

function retryOf(value: unknown): { min: number; max: number } | null {
  const retry = value as Partial<AgentConfig["retryMs"]> | null | undefined;
  if (typeof retry?.min !== "number" || typeof retry.max !== "number") return null;
  if (retry.min < 100 || retry.max < retry.min) return null;
  return { min: retry.min, max: retry.max };
}

function stringRecord(value: unknown): Record<string, string> {
  const record: Record<string, string> = {};
  if (!value || typeof value !== "object") return record;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) record[key] = entry;
  }
  return record;
}

function deviceOrNull(value: unknown): PairedDevice | null {
  const device = value as Partial<PairedDevice> | null | undefined;
  return typeof device?.token === "string" &&
    typeof device.deviceId === "string" &&
    typeof device.userId === "string"
    ? { deviceId: device.deviceId, userId: device.userId, token: device.token }
    : null;
}

function signInOrNull(value: unknown): SavedSignIn | null {
  const signIn = value as Partial<SavedSignIn> | null | undefined;
  return typeof signIn?.cookie === "string" && signIn.cookie.length > 0
    ? { cookie: signIn.cookie, expiresAt: signIn.expiresAt ?? new Date(0).toISOString() }
    : null;
}

function accountOrNull(value: unknown): Account | null {
  const account = value as Partial<Account> | null | undefined;
  if (typeof account?.email !== "string" || !account.email) return null;
  return typeof account.password === "string"
    ? { email: account.email, password: account.password }
    : { email: account.email };
}
