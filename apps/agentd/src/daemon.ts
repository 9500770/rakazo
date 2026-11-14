import { execFile } from "node:child_process";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { startUserDeviceClient } from "@rakazo/adapters/user-device-client";
import * as auth from "./auth.js";
import type { AgentConfig, AgentMode } from "./config.js";
import {
  agentHome,
  logPath,
  pausedPath,
  pidPath,
  readConfig,
  unlockPath,
  workspaceRoot,
  writeConfig,
} from "./config.js";

/** A configuration the person has to fix; the service managers are told not to restart on it. */
export const EXIT_CONFIG = 78;
/** The owner removed this computer, so restarting would only be refused again. */
export const EXIT_REVOKED = 77;

const SETTING_CACHE_MS = 2_000;
const NOTICE_THROTTLE_MS = 60_000;

type Level = "info" | "warn" | "error";
type Log = (level: Level, message: string) => void;

function createLog(write: (line: string) => void = (line) => process.stdout.write(line)): Log {
  return (level, message) => {
    write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}\n`);
  };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

/** Mirrors the shell-key allowlist the host command environment applies to inherited variables. */
const HOST_ENV_KEYS = new Set(
  [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TZ", "TMPDIR",
    "TEMP", "TMP", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "SSH_AUTH_SOCK", "SSL_CERT_FILE",
    "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
    "GIT_SSL_CAINFO",
  ].map((name) => name.toUpperCase()),
);

function hostEnvReachesCommands(name: string): boolean {
  const key = name.toUpperCase();
  return HOST_ENV_KEYS.has(key) || key.startsWith("LC_");
}

/** One generation of history is enough for a service log nobody rotates by hand. */
async function rotateLog(maxBytes: number): Promise<void> {
  const size = await stat(logPath()).then(
    (info) => info.size,
    () => 0,
  );
  if (size > maxBytes) await rename(logPath(), `${logPath()}.1`).catch(() => undefined);
}

async function claimPid(): Promise<boolean> {
  try {
    const running = Number((await readFile(pidPath(), "utf8")).trim());
    if (Number.isInteger(running) && running > 0 && running !== process.pid) {
      process.kill(running, 0);
      return false;
    }
  } catch {
    /* No pid file, a stale one, or that process is gone. Either way this one may start. */
  }
  await mkdir(agentHome(), { recursive: true, mode: 0o700 });
  await writeFile(pidPath(), String(process.pid), { mode: 0o600 });
  return true;
}

/** A desktop notification, so an `ask` refusal is visible without watching a log file. */
function notify(title: string, body: string) {
  const command: [string, string[]] | null =
    process.platform === "darwin"
      ? ["osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]]
      : process.platform === "linux"
        ? ["notify-send", ["--app-name=Rakazo", title, body]]
        : null;
  if (!command) return;
  execFile(command[0], command[1], { timeout: 5_000 }, () => undefined);
}

/**
 * Runs until a signal or a refusal the person has to resolve. The device socket already reconnects
 * on its own with jittered backoff, so this loop owns only what the socket cannot: the access mode,
 * the approval window, the pairing's sign-in, and telling the truth in the log.
 */
export async function runAgent(options: { write?: (line: string) => void } = {}): Promise<number> {
  const log = createLog(options.write);
  if (process.platform === "win32") {
    log("error", "This agent build supports macOS and Linux. Use the desktop app on Windows.");
    return EXIT_CONFIG;
  }
  const loaded = await readConfig();
  if (!loaded) {
    log("error", "This computer is not set up yet. Run: rakazo-agentd setup");
    return EXIT_CONFIG;
  }
  if (!loaded.device) {
    log("error", "No paired computer in the configuration. Run: rakazo-agentd setup");
    return EXIT_CONFIG;
  }
  // Declared non-null so the closures below keep the narrowing.
  const config: AgentConfig = loaded;
  const deviceId = loaded.device.deviceId;
  if (!(await claimPid())) {
    log("warn", "Another agent is already running for this computer.");
    return EXIT_CONFIG;
  }
  await rotateLog(config.logMaxBytes);
  // Bot commands inherit this process's environment, so configured extras have to land here.
  // The host command environment is an allowlist of shell keys (PATH, proxies, locale, TLS
  // bundles), so say which configured names will never reach a command instead of accepting them
  // silently and having the bot see them missing.
  Object.assign(process.env, config.env);
  const dropped = Object.keys(config.env).filter((name) => !hostEnvReachesCommands(name));
  if (dropped.length)
    log(
      "warn",
      `config.env keys that bot commands will not see (not shell keys): ${dropped.join(", ")}`,
    );

  let stopped = false;
  let client: ReturnType<typeof startUserDeviceClient> | null = null;
  // The device client's reconnect delay is unref'd, so nothing else would keep this process alive
  // between attempts: Node would exit mid-reconnect and the service manager would call it a crash.
  // This timer is deliberately ref'd, and it is the daemon's own lifetime.
  let keepAlive: NodeJS.Timeout | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let finish!: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });

  // `agentd mode` and `agentd unlock` change these files, so they are re-read rather than cached
  // for the process lifetime; once every couple of seconds is free and keeps switches instant.
  let settings = { mode: config.mode, at: 0 };
  async function currentMode(): Promise<AgentMode> {
    if (Date.now() - settings.at >= SETTING_CACHE_MS) {
      const fresh = await readConfig().catch(() => null);
      settings = { mode: fresh?.mode ?? config.mode, at: Date.now() };
    }
    return settings.mode;
  }

  let approval = { until: 0, at: 0 };
  async function approved(): Promise<boolean> {
    if (Date.now() - approval.at >= SETTING_CACHE_MS) {
      const raw = await readFile(unlockPath(), "utf8").catch(() => "");
      const until = Date.parse(raw.trim());
      approval = { until: Number.isFinite(until) ? until : 0, at: Date.now() };
    }
    return approval.until > Date.now();
  }

  let noticedAt = 0;
  async function remind() {
    if (!config.notify || Date.now() - noticedAt < NOTICE_THROTTLE_MS) return;
    noticedAt = Date.now();
    log("warn", `Approval needed: run "rakazo-agentd unlock" to answer this bot (${config.askMinutes}m).`);
    notify("Rakazo bot needs this computer", `Run: rakazo-agentd unlock  (allows ${config.askMinutes} minutes)`);
  }

  /** Asked before every request. `ask` without a live approval is a refusal, not a wait. */
  async function authorize(): Promise<boolean> {
    if (await exists(pausedPath())) return false;
    const mode = await currentMode();
    if (mode === "auto") return true;
    if (mode === "deny") return false;
    if (await approved()) return true;
    await remind();
    return false;
  }

  function stop(code: number) {
    if (stopped) return;
    stopped = true;
    clearTimeout(refreshTimer);
    clearInterval(keepAlive);
    client?.close();
    finish(code);
  }

  function start() {
    const token = config.device?.token;
    if (!token) return stop(EXIT_CONFIG);
    client = startUserDeviceClient({
      serverUrl: config.serverUrl,
      token,
      root: workspaceRoot(config),
      authorize,
      onRevoked: (revoked) => {
        log("warn", `The server disconnected this computer (${revoked ?? "token rejected"})`);
        if (revoked !== "session-ended") return stop(EXIT_REVOKED);
        void (async () => {
          if (await pairAgain(config, log)) start();
          else stop(EXIT_CONFIG);
        })();
      },
      retryMs: config.retryMs,
    });
  }

  async function pairAgain(current: AgentConfig, report: Log) {
    const { email, password } = current.account ?? { email: null, password: undefined };
    if (!email || !password) {
      report(
        "error",
        "The sign-in that paired this computer ended. Run `rakazo-agentd setup` again, or set it up with --remember so it can pair again by itself.",
      );
      return false;
    }
    try {
      const signIn = await auth.signIn(current.serverUrl, email, password);
      const device = await auth.pairDevice(current.serverUrl, signIn.cookie, current.name);
      current.signIn = signIn;
      current.device = device;
      await writeConfig(current);
      report("info", `Paired again as ${current.name} (${device.deviceId})`);
      return true;
    } catch (error) {
      report("error", `Could not pair again: ${reason(error)}`);
      return false;
    }
  }

  async function refresh() {
    if (stopped || !config.signIn) return;
    try {
      const result = await auth.refreshSignIn(config.serverUrl, config.signIn.cookie);
      if (result.alive) {
        config.signIn = result.signIn;
        await writeConfig(config);
      } else {
        log("warn", "The sign-in that paired this computer lapsed; pairing again");
        client?.close();
        if (await pairAgain(config, log)) start();
        else stop(EXIT_CONFIG);
      }
    } catch (error) {
      log("warn", `Could not check the sign-in: ${reason(error)}`);
    }
    scheduleRefresh();
  }

  function scheduleRefresh() {
    if (stopped) return;
    refreshTimer = setTimeout(
      () => void refresh(),
      Math.max(1, config.sessionRefreshHours) * 60 * 60 * 1000,
    );
    refreshTimer.unref();
  }

  const onSignal = (signal: NodeJS.Signals) => {
    log("info", `Stopping (${signal})`);
    stop(0);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const mode = await currentMode();
  log(
    "info",
    `Serving ${config.serverUrl} as "${config.name}" (device ${deviceId}) — mode ${mode}${
      mode === "ask" ? `, approved ${(await approved()) ? "now" : "only after unlock"}` : ""
    }`,
  );
  keepAlive = setInterval(() => undefined, 60_000);
  start();
  scheduleRefresh();

  const code = await done;
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  await rm(pidPath(), { force: true });
  return code;
}
