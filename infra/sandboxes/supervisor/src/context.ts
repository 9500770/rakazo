import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSupervisorToken, uploadSizeFromEnv } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import Docker from "dockerode";
import { computerImageEnsurer } from "./computer-image.js";
import {
  assertComputerMountSources,
  COMPUTER_IMAGE,
  computerProxyEnv,
  computerProxyPolicyJson,
  PROXY_POLICY_TARGET,
  resolveComputerDns,
  resolveComputerEgressMode,
  resolveComputerMounts,
  resolveComputerNoProxy,
  resolveComputerProxy,
  resolveScreenNetworkMode,
  resolveTeamScreenLimit,
} from "./computer-spec.js";

loadRootEnv();

const dockerSocketPath = resolveDockerSocketPath();
export const docker = dockerSocketPath
  ? new Docker({ socketPath: dockerSocketPath })
  : new Docker();
const computerContext =
  process.env.RAKAZO_COMPUTER_CONTEXT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../computer");
export const ensureComputerImage = computerImageEnsurer(docker, COMPUTER_IMAGE, computerContext);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const dataDir = path.resolve(repositoryRoot, process.env.DATA_DIR ?? "./data");
export let supervisorInfo: Docker.ContainerInspectInfo | undefined;
export const supervisorToken = resolveSupervisorToken(process.env);
export const screenNetworkMode = resolveScreenNetworkMode(process.env.SANDBOX_SCREEN_NETWORK);
export const computerEgressSetting = resolveComputerEgressMode();
export const computerDns = resolveComputerDns();
export const computerMounts = resolveComputerMounts(undefined, [dataDir, dockerSocketPath]);
// Docker follows symlinks in a bind source, so also check where a locally visible source points.
assertComputerMountSources(
  computerMounts.map((mount) => ({
    ...mount,
    source: existsSync(mount.source) ? realpathSync(mount.source) : mount.source,
  })),
  [dataDir, dockerSocketPath],
);
export const computerProxy = resolveComputerProxy();
export const computerNoProxy = resolveComputerNoProxy();
export const computerProxyEnvironment = computerProxyEnv(computerProxy, computerNoProxy);

/**
 * The Chromium policy file mounted into every computer. Written inside the supervisor's data
 * dir so it persists like the bot homes and rides the same named volume when there is one.
 */
export async function ensureComputerProxyPolicy(): Promise<void> {
  if (!computerProxy) return;
  const dir = path.join(dataDir, "computer-proxy");
  const file = path.join(dir, path.basename(PROXY_POLICY_TARGET));
  const json = computerProxyPolicyJson(computerProxy, computerNoProxy);
  await mkdir(dir, { recursive: true });
  try {
    if ((await readFile(file, "utf8")) === json) return;
  } catch {
    // Missing file: write it below.
  }
  await writeFile(file, json, { mode: 0o644 });
}

export const teamScreenLimit = resolveTeamScreenLimit();
// Host-run supervisors on Docker Desktop (macOS/Windows) cannot reach container
// IPs, so computer control must use a published loopback port instead.
export const controlViaLoopback = process.env.SANDBOX_CONTROL_VIA_LOOPBACK === "true";
export const maxUploadSizeBytes = uploadSizeFromEnv(process.env);

export function resolveDockerSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  if (env.DOCKER_HOST) return undefined;
  if (env.DOCKER_SOCKET) return env.DOCKER_SOCKET;
  if (platform === "darwin") {
    const userSocket = path.join(env.HOME ?? homedir(), ".docker", "run", "docker.sock");
    if (existsSync(userSocket)) return userSocket;
  }
  return platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock";
}

export async function inspectSupervisorContainer() {
  if (supervisorInfo || !process.env.HOSTNAME) return supervisorInfo;
  try {
    supervisorInfo = await docker.getContainer(process.env.HOSTNAME).inspect();
    return supervisorInfo;
  } catch {
    return undefined;
  }
}
