import { spawn } from "node:child_process";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { secureHttpOrigin } from "@rakazo/contracts/network-host";
import * as auth from "./auth.js";
import type { AgentConfig } from "./config.js";
import {
  configPath,
  defaultConfig,
  defaultName,
  logPath,
  modeOf,
  pausedPath,
  pidPath,
  readConfig,
  unlockPath,
  workspaceRoot,
  writeConfig,
} from "./config.js";

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}
import { runAgent } from "./daemon.js";
import {
  clearPids,
  installService,
  supervisorPid,
  uninstallService,
  writePortableRunner,
} from "./service.js";

const USAGE = `rakazo-agentd — a Rakazo host agent with no window

  setup     Sign in once, pair this computer, and save the token it gets back
  run       Serve this computer to the server until stopped (this is what the service runs)
  status    Show what this computer is paired to and how it answers bots
  mode      Change the access mode: mode auto | mode ask | mode deny
  unlock    Approve bot requests for a while (mode ask): unlock [--minutes 30]
  lock      Drop that approval now
  pause     Refuse bot requests without stopping the agent
  resume    Lift pause
  logout    Revoke this computer's token and forget the local setup
  start     Run it in the background now: no launchd, no systemd, only sh
  stop      Stop that background process
  install   Start it at login: launchd on macOS, systemd on Linux, cron @reboot as the fallback
  uninstall Stop it at login and remove whatever install wrote

install options:
  --portable         Use the portable background runner even where launchd/systemd exist

setup options:
  --server <url>     Rakazo server, e.g. https://app.rakazo.com
  --email <address>  Account to pair this computer for
  --name <name>      Name shown in the server's computer list (default: hostname)
  --remember         Keep the password locally so a lapsed sign-in pairs itself again
  --auto|--ask|--deny  Access mode for this computer (default: ask)
  --password-file <path>  Read the password from a file (one line, whitespace kept as-is)
  --password-stdin   Read the password from stdin (CI, containers)`;

function parseFlags(argv: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) continue;
    const [key = "", inline] = argument.slice(2).split("=", 2);
    if (inline !== undefined) {
      flags.set(key, inline);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }
  return flags;
}

function text(flags: Map<string, string | true>, key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function ask(label: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await readline.question(label)).trim();
  } finally {
    readline.close();
  }
}

/** Removes escape sequences and control noise a terminal inserts around pasted input. */
function stripTerminalNoise(input: string): string {
  return input
    .replace(/\u001b\[20[01]~/g, "")
    .replace(/\u001b\[[0-9;]*[A-Za-z~]/g, "")
    .replace(/\u001b./g, "");
}

/** Reads a password without echoing it, and without it ever reaching a shell history. */
function askHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY) return ask(label);
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    process.stdout.write(label);
    let value = "";
    const stop = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
    };
    const onData = (raw: string) => {
      // Terminals in raw mode still wrap pasted text in bracketed-paste markers
      // (ESC[200~ … ESC[201~). Left in place they become part of the password and
      // the sign-in fails with a misleading "wrong email or password".
      const chunk = stripTerminalNoise(raw);
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          stop();
          resolve(value);
          return;
        }
        if (character === "\u0003") {
          stop();
          reject(new Error("Cancelled"));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        value += character;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

async function setup(flags: Map<string, string | true>): Promise<number> {
  const existing = await readConfig();
  const requested = text(flags, "server") ?? existing?.serverUrl;
  const serverUrl = secureHttpOrigin(requested);
  if (!serverUrl) {
    process.stderr.write(
      requested
        ? "That server needs https (http is only allowed for loopback).\n"
        : "Pass the server, e.g. --server https://app.rakazo.com\n",
    );
    return 2;
  }
  const email = text(flags, "email") ?? existing?.account?.email ?? (await ask("Email: "));
  if (!email) {
    process.stderr.write("An account email is needed to pair this computer.\n");
    return 2;
  }
  const passwordFile = text(flags, "password-file");
  const password = passwordFile
    ? (await readFile(passwordFile, "utf8")).replace(/\r?\n$/, "")
    : flags.has("password-stdin")
      ? (await ask("")).trim() || process.env.RAKAZO_PASSWORD || ""
      : process.env.RAKAZO_PASSWORD ?? (await askHidden("Password: "));
  if (!password) {
    process.stderr.write("A password is needed to pair this computer.\n");
    return 2;
  }

  const signIn = await auth.signIn(serverUrl, email, password);
  const user = await auth.sessionUser(serverUrl, signIn.cookie);
  if (!user) throw new auth.SignInError("The server did not accept that sign-in", 401);
  const name = text(flags, "name") ?? existing?.name ?? defaultName();
  const device = await auth.pairDevice(serverUrl, signIn.cookie, name);

  // The old pairing would otherwise linger in the server's list until revoked by hand.
  if (existing?.device && existing.device.deviceId !== device.deviceId) {
    await auth.revokeDevice(existing.serverUrl, existing.device.token);
  }

  const base = existing ?? defaultConfig(serverUrl, name);
  const config: AgentConfig = {
    ...base,
    serverUrl,
    name,
    device,
    signIn,
    account: flags.has("remember") ? { email, password } : { email },
  };
  if (flags.has("auto")) config.mode = "auto";
  else if (flags.has("ask")) config.mode = "ask";
  else if (flags.has("deny")) config.mode = "deny";
  await writeConfig(config);

  process.stdout.write(
    [
      `Paired "${name}" as ${user.email ?? email} (device ${device.deviceId}).`,
      `Token saved in ${configPath()} (owner-only). The server keeps only its hash.`,
      flags.has("remember")
        ? "The password is saved too, so a lapsed sign-in pairs this computer again without you."
        : "The sign-in is refreshed while the agent runs; if it ever lapses, run setup again.",
      `Run it in the background with: rakazo-agentd install`,
      `Or in this terminal with: rakazo-agentd run`,
    ].join("\n") + "\n",
  );
  return 0;
}

async function status(): Promise<number> {
  const config = await readConfig();
  if (!config?.device) {
    process.stdout.write(`Not set up. Configuration: ${configPath()}\n`);
    return 1;
  }
  const running = (await runningPid()) !== null;
  const approval = Date.parse((await readFile(unlockPath(), "utf8").catch(() => "")).trim());
  const approved = Number.isFinite(approval) && approval > Date.now();
  process.stdout.write(
    [
      `server     ${config.serverUrl}`,
      `name       ${config.name}`,
      `device     ${config.device.deviceId}`,
      `account    ${config.account?.email ?? "(unknown)"}`,
      `mode       ${config.mode}${config.mode === "ask" ? (approved ? ` (approved until ${new Date(approval).toISOString()})` : " (waiting for unlock)") : ""}`,
      `paused     ${(await exists(pausedPath())) ? "yes" : "no"}`,
      `agent      ${running ? "running" : "not running"}`,
      `workspace  ${workspaceRoot(config)}`,
      `log        ${logPath()}`,
    ].join("\n") + "\n",
  );
  return 0;
}

async function logout(): Promise<number> {
  const config = await readConfig();
  if (config?.device) await auth.revokeDevice(config.serverUrl, config.device.token);
  await rm(configPath(), { force: true });
  await rm(pidPath(), { force: true });
  await rm(pausedPath(), { force: true });
  process.stdout.write("This computer is no longer paired. Workspace files were kept.\n");
  return 0;
}

async function pause(): Promise<number> {
  await writeFile(pausedPath(), `${new Date().toISOString()}\n`, { mode: 0o600 });
  process.stdout.write("Bot requests are now refused. `rakazo-agentd resume` allows them again.\n");
  return 0;
}

async function resume(): Promise<number> {
  await rm(pausedPath(), { force: true });
  process.stdout.write("Bot requests are allowed again.\n");
  return 0;
}

async function setMode(value: string | undefined): Promise<number> {
  const config = await readConfig();
  if (!config) {
    process.stderr.write("Not set up yet. Run: rakazo-agentd setup\n");
    return 1;
  }
  const mode = modeOf(value);
  if (!mode) {
    process.stderr.write(`Mode must be one of: auto, ask, deny (got ${value ?? "nothing"})\n`);
    return 2;
  }
  config.mode = mode;
  await writeConfig(config);
  process.stdout.write(
    mode === "auto"
      ? "This computer runs every request its bots send.\n"
      : mode === "ask"
        ? "This computer refuses until `rakazo-agentd unlock`, then for the configured window.\n"
        : "This computer refuses every request and stays connected.\n",
  );
  return 0;
}

async function unlock(minutes: string | undefined): Promise<number> {
  const config = await readConfig();
  if (!config) {
    process.stderr.write("Not set up yet. Run: rakazo-agentd setup\n");
    return 1;
  }
  const wanted = minutes === undefined ? config.askMinutes : Number(minutes);
  if (!Number.isFinite(wanted) || wanted <= 0 || wanted > 10_080) {
    process.stderr.write("Minutes must be between 1 and 10080.\n");
    return 2;
  }
  const until = new Date(Date.now() + wanted * 60_000);
  await writeFile(unlockPath(), `${until.toISOString()}\n`, { mode: 0o600 });
  process.stdout.write(`Bots may use this computer until ${until.toISOString()}.\n`);
  return 0;
}

async function lock(): Promise<number> {
  await rm(unlockPath(), { force: true });
  process.stdout.write("Approval dropped. This computer refuses again.\n");
  return 0;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => void setTimeout(resolve, ms));

/** The agent's pid when one is alive; a crash leaves the file behind, so the signal decides. */
async function runningPid(): Promise<number | null> {
  const pid = Number((await readFile(pidPath(), "utf8").catch(() => "")).trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return alive(pid) ? pid : null;
}

/**
 * Starts the agent in the background with no service manager: a detached `sh` keeps it running and
 * restarts it after a crash. Same code path on macOS, Linux and the BSDs.
 */
async function startBackground(): Promise<number> {
  const config = await readConfig();
  if (!config?.device) {
    process.stderr.write("Not set up yet. Run: rakazo-agentd setup\n");
    return 1;
  }
  const already = await runningPid();
  if (already) {
    process.stdout.write(`Already running (pid ${already}). Log: ${logPath()}\n`);
    return 1;
  }
  const supervisor = await supervisorPid();
  if (supervisor) {
    process.stdout.write(`The background runner is already up (pid ${supervisor}).\n`);
    return 1;
  }
  await clearPids();
  const runner = await writePortableRunner();
  const child = spawn("/bin/sh", [runner], { detached: true, stdio: "ignore", env: { ...process.env } });
  child.unref();
  for (let i = 0; i < 50; i += 1) {
    const pid = await runningPid();
    if (pid) {
      process.stdout.write(`Running in the background (pid ${pid}). Log: ${logPath()}\n`);
      return 0;
    }
    await sleep(100);
  }
  process.stderr.write(`Started, but no pid file appeared. Check ${logPath()}\n`);
  return 1;
}

async function stopBackground(): Promise<number> {
  const running = await runningPid();
  const supervisor = await supervisorPid();
  if (!running && !supervisor) {
    await clearPids();
    process.stdout.write("Not running.\n");
    return 0;
  }
  // The runner first, or it would start the agent again the moment this stops it.
  if (supervisor) {
    try {
      process.kill(supervisor, "SIGTERM");
    } catch {
      /* Already gone. */
    }
    await sleep(300);
  }
  if (running && alive(running)) {
    try {
      process.kill(running, "SIGTERM");
    } catch {
      /* Already gone. */
    }
    for (let i = 0; i < 100 && alive(running); i += 1) await sleep(100);
  }
  await clearPids();
  if (running && alive(running)) {
    process.stderr.write(`pid ${running} did not stop within 10s.\n`);
    return 1;
  }
  process.stdout.write(`Stopped${running ? ` (pid ${running})` : ""}.\n`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  switch (command) {
    case "setup":
      return setup(flags);
    case "run":
      return runAgent();
    case "start":
      return startBackground();
    case "stop":
      return stopBackground();
    case "status":
      return status();
    case "mode":
      return setMode(rest.find((argument) => !argument.startsWith("-")));
    case "unlock":
      return unlock(rest.find((argument) => /^\d+$/.test(argument)));
    case "logout":
      return logout();
    case "pause":
      return pause();
    case "resume":
      return resume();
    case "lock":
      return lock();
    case "install": {
      const lines = await installService({ portable: flags.has("portable") });
      for (const line of lines) process.stdout.write(`${line}\n`);
      return 0;
    }
    case "uninstall": {
      for (const line of await uninstallService()) process.stdout.write(`${line}\n`);
      return 0;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${USAGE}\n`);
      return command === undefined ? 1 : 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}\n`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = error instanceof auth.SignInError && error.status < 500 ? 2 : 1;
  },
);
