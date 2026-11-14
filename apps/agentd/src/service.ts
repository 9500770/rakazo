import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { agentHome, logPath } from "./config.js";

const exec = promisify(execFile);

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

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function environment(): Record<string, string> {
  const values: Record<string, string> = { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin" };
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
    .map(([key, value]) => `    <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(scriptPath())}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
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
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${quote(process.execPath)} ${quote(scriptPath())} run
Restart=on-failure
RestartSec=10
# 77: the owner removed this computer. 78: setup is needed. Neither fixes itself by restarting.
RestartPreventExitStatus=77 78
${env}
StandardOutput=append:${logPath()}
StandardError=append:${logPath()}

[Install]
WantedBy=default.target
`;
}

/** Writes the unit for this machine's service manager and loads it. Returns what it did. */
export async function installService(): Promise<string[]> {
  await mkdir(agentHome(), { recursive: true, mode: 0o700 });
  if (process.platform === "darwin") {
    const file = plistPath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, launchdPlist());
    const domain = `gui/${process.getuid?.() ?? 501}`;
    await exec("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]).catch(() => undefined);
    await exec("launchctl", ["bootstrap", domain, file]);
    return [`Installed ${file}`, "launchd starts it at login and restarts it if it stops."];
  }
  if (process.platform === "linux") {
    const file = unitPath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, systemdUnit());
    const notes = [`Installed ${file}`];
    try {
      await exec("systemctl", ["--user", "daemon-reload"]);
      await exec("systemctl", ["--user", "enable", "--now", "rakazo-agentd"]);
      notes.push("systemd starts it at login and restarts it if it stops.");
    } catch {
      notes.push(
        "Could not reach the user service manager. Enable it yourself with:",
        "  systemctl --user daemon-reload && systemctl --user enable --now rakazo-agentd",
        "  loginctl enable-linger $USER   # keep it running with no session open",
      );
    }
    return notes;
  }
  throw new Error("Service installation supports macOS and Linux");
}

export async function uninstallService(): Promise<string[]> {
  if (process.platform === "darwin") {
    const file = plistPath();
    const domain = `gui/${process.getuid?.() ?? 501}`;
    await exec("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]).catch(() => undefined);
    await rm(file, { force: true });
    return [`Removed ${file}`];
  }
  if (process.platform === "linux") {
    const file = unitPath();
    await exec("systemctl", ["--user", "disable", "--now", "rakazo-agentd"]).catch(() => undefined);
    await rm(file, { force: true });
    await exec("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
    return [`Removed ${file}`];
  }
  throw new Error("Service installation supports macOS and Linux");
}
