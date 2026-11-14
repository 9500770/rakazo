import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { agentHome, logPath, pidPath } from "./config.js";

const exec = promisify(execFile);

/**
 * The interpreter launchd/systemd should run. Homebrew's node lives in a versioned Cellar path that
 * a `brew upgrade` deletes, so prefer the stable symlink next to it; RAKAZO_NODE overrides both.
 */
function nodeBin(): string {
  const explicit = process.env.RAKAZO_NODE;
  if (explicit) return explicit;
  const p = process.execPath;
  const stable = p.replace(/\/Cellar\/[^/]+\/[^/]+\/bin\//, "/bin/");
  return stable !== p && existsSync(stable) ? stable : p;
}

export const SERVICE_LABEL = "dev.rakazo.agentd";

/** The bundle that runs, whatever this file was imported from. */
function scriptPath(): string {
  return fileURLToPath(new URL("./agentd.mjs", import.meta.url));
}

function plistPath(): string {
  return path.join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

function unitPath(): string {
  return path.join(homedir(), ".config", "systemd", "user", "rakazo-agentd.service");
}

/** The portable runner: one shell script that keeps the agent running with no service manager. */
export function portableRunnerPath(): string {
  return path.join(agentHome(), "agentd-run.sh");
}

export const supervisorPidPath = () => path.join(agentHome(), "supervisor.pid");

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Single-quoted for a POSIX shell: safe for spaces, `$` and backslashes. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function environment(): Record<string, string> {
  const values: Record<string, string> = {
    PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
    // Tells the agent to append its own log lines, so rotation works under a service manager.
    RAKAZO_AGENTD_SERVICE: "1",
  };
  const home = process.env.RAKAZO_AGENT_HOME;
  if (home) values.RAKAZO_AGENT_HOME = home;
  return values;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function launchdPlist(): string {
  const env = Object.entries(environment())
    .map(([key, value]) => `  <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeBin())}</string>
    <string>${escapeXml(scriptPath())}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <!-- The agent never exits on a network, token or setup problem, so a restart here only covers a
       real crash or an update. SuccessfulExit=false keeps a deliberate stop stopped. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${escapeXml(logPath())}</string>
  <key>StandardErrorPath</key><string>${escapeXml(logPath())}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
</dict>
</plist>
`;
}

function systemdUnit(): string {
  const env = Object.entries(environment())
    .map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`)
    .join("\n");
  return `[Unit]
Description=Rakazo host agent
# Not network-online: the agent retries in the background, so a slow network at boot is not a
# reason to hold up the login.
After=network.target

[Service]
Type=simple
ExecStart=${quote(nodeBin())} ${quote(scriptPath())} run
Restart=always
RestartSec=30
# The agent only exits 0 when it was asked to stop.
SuccessExitStatus=0
${env}
StandardOutput=append:${logPath()}
StandardError=append:${logPath()}

[Install]
WantedBy=default.target
`;
}

/**
 * The portable background runner. It needs nothing but `sh`: every POSIX box has one, including
 * containers and distros without systemd. The loop only covers a crash, because the agent itself
 * stays up through outages, refused tokens and missing setups.
 */
export async function writePortableRunner(): Promise<string> {
  await mkdir(agentHome(), { recursive: true, mode: 0o700 });
  const file = portableRunnerPath();
  const body = `#!/bin/sh
# Written by rakazo-agentd. Keeps the agent running with no launchd, systemd or cron.
NODE=${shQuote(nodeBin())}
AGENT=${shQuote(scriptPath())}
PIDFILE=${shQuote(supervisorPidPath())}
export PATH=${shQuote(environment().PATH ?? "/usr/local/bin:/usr/bin:/bin")}
export RAKAZO_AGENT_HOME=${shQuote(agentHome())}
export RAKAZO_AGENTD_SERVICE=1
echo $$ > "$PIDFILE"
while :; do
  "$NODE" "$AGENT" run
  code=$?
  # 0 means it was asked to stop; anything else is a crash worth one restart after a pause.
  [ "$code" = 0 ] && exit 0
  sleep 5
done
`;
  await writeFile(file, body, { mode: 0o700 });
  await chmod(file, 0o700).catch(() => undefined);
  return file;
}

export async function installService(options: { portable?: boolean } = {}): Promise<string[]> {
  await mkdir(agentHome(), { recursive: true, mode: 0o700 });
  if (options.portable) return installPortable();
  if (process.platform === "darwin") {
    const file = plistPath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, launchdPlist());
    const domain = `gui/${process.getuid?.() ?? 501}`;
    await exec("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]).catch(() => undefined);
    // launchd refuses a bootstrap while the old job is still terminating, and reports it as a
    // generic "Input/output error". Waiting and retrying is what makes reinstall reliable.
    let bootstrapped = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 20 && !bootstrapped; attempt += 1) {
      try {
        await exec("launchctl", ["bootstrap", domain, file]);
        bootstrapped = true;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!bootstrapped) throw lastError;
    return [`Installed ${file}`, "launchd starts it at login and restarts it if it stops."];
  }
  if (process.platform === "linux") {
    const file = unitPath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, systemdUnit());
    try {
      await exec("systemctl", ["--user", "daemon-reload"]);
      await exec("systemctl", ["--user", "enable", "--now", "rakazo-agentd"]);
      return [
        `Installed ${file}`,
        "systemd starts it at login and restarts it if it crashes.",
        "To keep it running with no session open: loginctl enable-linger gm",
        `Log: ${logPath()}`,
      ];
    } catch {
      // No user systemd here (container, minimal distro, ssh without a session bus): the portable
      // runner does the same job, and cron's @reboot is the autostart hook that still exists.
      return installPortable("systemd is not usable here");
    }
  }
  return installPortable(`no service manager is used on ${process.platform}`);
}

async function installPortable(why?: string): Promise<string[]> {
  const runner = await writePortableRunner();
  return [
    ...(why ? [`${why}; using the portable runner instead.`] : []),
    `Installed ${runner}`,
    "Start it now with: rakazo-agentd start",
    "This is the cross-platform path: it needs only sh, no launchd and no systemd.",
  ];
}

export async function uninstallService(): Promise<string[]> {
  const notes: string[] = [];
  if (process.platform === "darwin") {
    const file = plistPath();
    const domain = `gui/${process.getuid?.() ?? 501}`;
    await exec("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]).catch(() => undefined);
    await rm(file, { force: true });
    notes.push(`Removed ${file}`);
  } else if (process.platform === "linux") {
    const file = unitPath();
    await exec("systemctl", ["--user", "disable", "--now", "rakazo-agentd"]).catch(() => undefined);
    await rm(file, { force: true });
    await exec("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
    notes.push(`Removed ${file}`);
  }
  await rm(portableRunnerPath(), { force: true }).catch(() => undefined);
  return notes;
}

/** The supervisor process, when the portable runner is what keeps the agent alive. */
export async function supervisorPid(): Promise<number | null> {
  const pid = Number((await readFile(supervisorPidPath(), "utf8").catch(() => "")).trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** Removes the pid files a stopped agent leaves behind. */
export async function clearPids(): Promise<void> {
  await rm(supervisorPidPath(), { force: true }).catch(() => undefined);
  await rm(pidPath(), { force: true }).catch(() => undefined);
}
