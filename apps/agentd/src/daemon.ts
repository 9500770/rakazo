import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
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

/** Setup is missing or wrong. Only used before the daemon takes ownership of the machine. */
export const EXIT_CONFIG = 78;
/** Kept for callers that still read it; the daemon no longer exits when the token is refused. */
export const EXIT_REVOKED = 77;

const SETTING_CACHE_MS = 2_000;
const NOTICE_THROTTLE_MS = 60_000;
/** A reconnect that keeps failing is one line every few minutes, not one per attempt. */
const RETRY_NOTICE_MS = 5 * 60_000;
const LOG_ROTATE_MS = 10 * 60_000;
/** How often a daemon that is waiting for setup re-reads the configuration. */
const CONFIG_WATCH_MS = 15_000;
/** Ceiling for pairing attempts, so a long outage costs one sign-in every five minutes. */
const PAIRING_MAX_MS = 5 * 60_000;
/** First sign-in check after start; early enough to roll a session whose update is due. */
const FIRST_REFRESH_MS = 60_000;

type Level = "info" | "warn" | "error";
type Log = (level: Level, message: string) => void;
type RevokeHandler = Parameters<typeof startUserDeviceClient>[0]["onRevoked"];
type ClientEvent = Parameters<NonNullable<Parameters<typeof startUserDeviceClient>[0]["onEvent"]>>[0];

function createLog(write: (line: string) => void): Log {
  return (level, message) => {
    write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}\n`);
  };
}

/**
 * Where log lines go. Under a service manager stdout is the log file, and the manager holds that
 * file open: renaming it for rotation would leave the daemon writing into `agent.log.1` forever.
 * So a backgrounded agent appends the file itself (each line reopens it, so rotation works), and an
 * interactive one keeps using the terminal.
 */
function defaultWriter(): (line: string) => void {
  // Only a service install sets this: it hands the agent both a log path and a service manager
  // that holds the file open, so the agent has to append the lines itself (see rotateLog).
  if (process.env.RAKAZO_AGENTD_SERVICE !== "1")
    return (line) => void process.stdout.write(line);
  return (line) => {
    try {
      appendFileSync(logPath(), line, { mode: 0o600 });
    } catch {
      /* A full disk must not kill the agent; there is nowhere left to report it either. */
    }
  };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) => new Promise<void>((resolve) => void setTimeout(resolve, ms));

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

/** One generation of history. Runs at start and then on a timer, so a long-lived daemon stays bounded. */
async function rotateLog(maxBytes: number, log: Log): Promise<void> {
  const size = await stat(logPath()).then(
    (info) => info.size,
    () => 0,
  );
  if (size <= maxBytes) return;
  await rename(logPath(), `${logPath()}.1`).catch(() => undefined);
  log("info", `Rotated the log at ${size} bytes`);
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
 * Waits for a configuration with a pairing. A service manager starts this at login, which can be
 * before `setup` has ever run, or after `logout`; exiting there would turn "nobody has set this up"
 * into a restart loop, so the process stays and waits for the file instead.
 */
async function waitForConfig(log: Log, stopping: () => boolean): Promise<AgentConfig | null> {
  let announced = false;
  for (;;) {
    if (stopping()) return null;
    const loaded = await readConfig();
    if (loaded?.device) return loaded;
    if (!announced) {
      log(
        "warn",
        `${loaded ? "This computer is not paired yet" : "This computer is not set up yet"}. ` +
          "Run `rakazo-agentd setup`; this process stays up and waits for it.",
      );
      announced = true;
    }
    // Checked in slices: stop must take effect while this wait is running, not up to a full
    // watch interval later.
    for (let waited = 0; waited < CONFIG_WATCH_MS; waited += 250) {
      if (stopping()) return null;
      await sleep(250);
    }
  }
}

/**
 * Runs until it is asked to stop. Everything that can be recovered — the server being unreachable,
 * the token being refused, the sign-in lapsing, setup being rewritten underneath it — degrades to a
 * slower retry in the background. Nothing in here exits because a network call failed.
 */
export async function runAgent(options: { write?: (line: string) => void } = {}): Promise<number> {
  const log = createLog(options.write ?? defaultWriter());
  if (process.platform === "win32") {
    log("error", "This agent build supports macOS and Linux. Use the desktop app on Windows.");
    return EXIT_CONFIG;
  }
  if (!(await claimPid())) {
    log("warn", "Another agent is already running for this computer.");
    return EXIT_CONFIG;
  }

  let stopped = false;
  let client: ReturnType<typeof startUserDeviceClient> | null = null;
  // The device client's reconnect delay is unref'd, so nothing else would keep this process alive
  // between attempts: Node would exit mid-reconnect and the service manager would call it a crash.
  // This timer is deliberately ref'd, and it is the daemon's own lifetime.
  let keepAlive: NodeJS.Timeout | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let rotateTimer: NodeJS.Timeout | undefined;
  let watchTimer: NodeJS.Timeout | undefined;
  let recoveryTimer: NodeJS.Timeout | undefined;
  let finish!: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });

  function stop(code: number) {
    if (stopped) return;
    stopped = true;
    clearTimeout(refreshTimer);
    clearTimeout(rotateTimer);
    clearInterval(watchTimer);
    clearTimeout(recoveryTimer);
    clearInterval(keepAlive);
    client?.close();
    finish(code);
  }

  const onSignal = (signal: NodeJS.Signals) => {
    log("info", `Stopping (${signal})`);
    stop(0);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const loaded = await waitForConfig(log, () => stopped);
  if (!loaded) {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await rm(pidPath(), { force: true });
    return 0;
  }
  // Declared non-null so the closures below keep the narrowing.
  const config: AgentConfig = loaded;
  const deviceId = config.device?.deviceId ?? "(none)";

  await rotateLog(config.logMaxBytes, log);
  rotateTimer = setInterval(() => void rotateLog(config.logMaxBytes, log), LOG_ROTATE_MS);
  rotateTimer.unref();

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

  // --- recovery: pairing, and waiting for a fresh setup -------------------

  let pairingAttempt = 0;
  let retryNoticedAt = 0;

  function schedulePairing() {
    if (stopped) return;
    const ceiling = Math.min(PAIRING_MAX_MS, 5_000 * 2 ** pairingAttempt);
    const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
    pairingAttempt += 1;
    clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(() => void attemptPairing(), delay);
    recoveryTimer.unref();
  }

  async function attemptPairing() {
    if (stopped) return;
    const { email, password } = config.account ?? { email: null, password: undefined };
    if (!email || !password) {
      watchForSetup();
      return;
    }
    try {
      const signIn = await auth.signIn(config.serverUrl, email, password);
      const device = await auth.pairDevice(config.serverUrl, signIn.cookie, config.name);
      const previous = config.device;
      config.signIn = signIn;
      config.device = device;
      await writeConfig(config);
      pairingAttempt = 0;
      log("info", `Paired again as ${config.name} (${device.deviceId})`);
      // The old pairing is dead weight in the server's computer list.
      if (previous && previous.deviceId !== device.deviceId)
        void auth.revokeDevice(config.serverUrl, previous.token).catch(() => undefined);
      start();
    } catch (error) {
      log("warn", `Could not pair again: ${reason(error)}; will try again with backoff`);
      schedulePairing();
    }
  }

  /**
   * Without a saved password there is nothing to sign in with, so the daemon waits for a person to
   * run `setup` again and picks the new token up from the file — no restart, no service juggling.
   */
  function watchForSetup() {
    if (stopped || watchTimer) return;
    log(
      "warn",
      "This computer is not paired any more. It stays up; run `rakazo-agentd setup` and it will reconnect by itself.",
    );
    watchTimer = setInterval(() => {
      void (async () => {
        if (stopped) return;
        const fresh = await readConfig().catch(() => null);
        if (!fresh?.device) return;
        if (fresh.device.token === config.device?.token) return;
        clearInterval(watchTimer);
        watchTimer = undefined;
        Object.assign(config, fresh);
        log("info", `Configuration changed; connecting as ${config.name} (${fresh.device.deviceId})`);
        start();
      })();
    }, CONFIG_WATCH_MS);
    watchTimer.unref();
  }

  // --- the socket ---------------------------------------------------------

  function start() {
    clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
    const token = config.device?.token;
    if (!token) {
      watchForSetup();
      return;
    }
    client = startUserDeviceClient({
      serverUrl: config.serverUrl,
      token,
      root: workspaceRoot(config),
      authorize,
      onRevoked,
      onEvent,
      retryMs: config.retryMs,
    });
  }

  const onRevoked: RevokeHandler = (revoked) => {
    if (stopped) return;
    client = null;
    if (revoked === "session-ended") {
      log("warn", "The sign-in that paired this computer ended; pairing again");
      pairingAttempt = 0;
      void attemptPairing();
      return;
    }
    log(
      "warn",
      `The server disconnected this computer (${revoked ?? "token rejected"}). ` +
        "The agent stays up and keeps trying.",
    );
    // A saved password can pair a fresh device; without one, wait for setup to rewrite the file.
    pairingAttempt = 0;
    void attemptPairing();
  };

  const onEvent = (event: ClientEvent) => {
    if (stopped) return;
    if (event.type === "connected") {
      const down = event.afterMs === null ? null : Math.round(event.afterMs / 1000);
      log("info", down === null ? "Connected to the server" : `Reconnected after ${down}s offline`);
      retryNoticedAt = 0;
      return;
    }
    if (event.type === "disconnected") {
      log("warn", `Lost the connection (${event.reason}); reconnecting in the background`);
      return;
    }
    // Attempts are only interesting when the server stays unreachable.
    if (Date.now() - retryNoticedAt < RETRY_NOTICE_MS) return;
    retryNoticedAt = Date.now();
    log(
      "warn",
      `Server unreachable (attempt ${event.attempt}: ${event.reason}); ` +
        `next try in ${Math.round(event.delayMs / 1000)}s, will keep retrying`,
    );
  };

  // --- the sign-in behind the pairing ------------------------------------

  function scheduleRefresh(delayMs: number) {
    if (stopped) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh(), Math.max(60_000, delayMs));
    refreshTimer.unref();
  }

  async function refresh() {
    if (stopped || !config.signIn) return;
    try {
      const result = await auth.refreshSignIn(config.serverUrl, config.signIn.cookie);
      if (result.alive) {
        config.signIn = result.signIn;
        await writeConfig(config);
        scheduleRefresh(Math.max(1, config.sessionRefreshHours) * 60 * 60 * 1000);
      } else {
        log("warn", "The sign-in that paired this computer lapsed; pairing again");
        client?.close();
        client = null;
        pairingAttempt = 0;
        void attemptPairing();
      }
    } catch (error) {
      // An unreachable server says nothing about the sign-in, so try again sooner than the full
      // interval: a week of failed checks must not silently run the session out.
      log("warn", `Could not check the sign-in: ${reason(error)}; retrying in 30 minutes`);
      scheduleRefresh(30 * 60 * 1000);
    }
  }

  const mode = await currentMode();
  log(
    "info",
    `Serving ${config.serverUrl} as "${config.name}" (device ${deviceId}) — mode ${mode}${
      mode === "ask" ? `, approved ${(await approved()) ? "now" : "only after unlock"}` : ""
    }`,
  );
  keepAlive = setInterval(() => undefined, 60_000);
  start();
  scheduleRefresh(FIRST_REFRESH_MS);

  const code = await done;
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  await rm(pidPath(), { force: true });
  return code;
}
