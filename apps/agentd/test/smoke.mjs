// End-to-end smoke test for the headless agent, against a mock Rakazo device server.
// No real server, no credentials: it only exercises the socket, runner and sandbox.
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
// The repo root has `ws` linked already; this test is not installed as a package.
const { WebSocketServer } = createRequire(path.join(path.dirname(new URL(import.meta.url).pathname), "../../../packages/adapters/package.json"))("ws");

const here = path.dirname(new URL(import.meta.url).pathname);
const bundle = path.join(here, "../dist/agentd.mjs");
const home = process.env.SMOKE_HOME ?? (await mkdtemp(path.join(tmpdir(), "agentd-smoke-")));
await mkdir(home, { recursive: true });
const logs = [];

const mode = process.argv[2] ?? "auto";
await writeFile(
  path.join(home, "config.json"),
  JSON.stringify({
    version: 1,
    serverUrl: "http://127.0.0.1:0",
    name: "smoke",
    mode,
    askMinutes: 30,
    notify: false,
    notifyMinutes: 15,
    workspaceRoot: path.join(home, "computers"),
    env: {},
    retryMs: { min: 100, max: 400 },
    sessionRefreshHours: 6,
    device: { deviceId: "dev_smoke", userId: "usr_smoke", token: "smoke-token" },
    signIn: null,
    account: null,
  }),
  { mode: 0o600 },
);

const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/api/devices/connect" });
await new Promise((r) => wss.once("listening", r));
const { port } = wss.address();
const configPath = path.join(home, "config.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
config.serverUrl = `http://127.0.0.1:${port}`;
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

process.stderr.write(`home=${home} port=${port}\n\n`);
const child = spawn(process.execPath, [bundle, "run"], {
  env: { ...process.env, RAKAZO_AGENT_HOME: home },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => { logs.push(d.toString()); if (process.env.SMOKE_VERBOSE) process.stderr.write("AGENT " + d); });
child.stderr.on("data", (d) => { logs.push(d.toString()); if (process.env.SMOKE_VERBOSE) process.stderr.write("AGENT-ERR " + d); });
child.on("error", (error) => logs.push(`spawn error: ${error.message}\n`));
child.on("exit", (code, signal) => logs.push(`child exit code=${code} signal=${signal}\n`));

const socket = await Promise.race([
  new Promise((resolve) => wss.once("connection", (ws, req) => resolve({ ws, req }))),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`agent never connected; log:\n${logs.join("")}`)), 15_000),
  ),
]);
if (socket.req.headers.authorization !== "Bearer smoke-token") throw new Error("token not sent");

const frames = new Map();
socket.ws.on("message", (data) => {
  const message = JSON.parse(data.toString());
  const list = frames.get(message.id) ?? [];
  list.push(message.frame);
  frames.set(message.id, list);
});

function send(id, request) {
  frames.set(id, []);
  socket.ws.send(JSON.stringify({ type: "request", id, request }));
}
async function wait(id, predicate, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const list = frames.get(id) ?? [];
    const hit = list.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting on ${id}: ${JSON.stringify(frames.get(id))}`);
}

const base = { botId: "bot_smoke" };
const results = {};
const frame = async (id) => {
  const list = frames.get(id) ?? [];
  return list.map((f) => (f.value !== undefined ? f.value : f.error !== undefined ? `error: ${f.error}` : f));
};
try {
  // `execute` only runs on a provisioned computer, exactly as the server does it.
  send("1", { ...base, method: "environment" });
  const env = await wait("1", (f) => f.value || f.error);
  results.environment = env.value?.platform ?? env.error;

  send("2", { ...base, method: "provision" });
  await wait("2", (f) => f.value || f.error);
  send("3", { ...base, method: "prepare" });
  await wait("3", (f) => f.done || f.error);

  send("4", { ...base, method: "execute", command: { argv: ["sh", "-c", "echo agentd-ok; pwd"] } });
  await wait("4", (f) => f.done || f.error);
  results.execute = await frame("4");

  send("5", {
    ...base,
    method: "workspaceDirectories",
    directories: { action: "ensure", paths: ["work/a"] },
  });
  await wait("5", (f) => f.value !== undefined || f.error);
  results.ensure = await frame("5");

  send("6", { ...base, method: "writeFile", file: { path: "work/a/note.txt", content: Buffer.from("hi").toString("base64") } });
  await wait("6", (f) => f.done || f.error);
  results.writeFile = await frame("6");

  send("7", { ...base, method: "readFile", path: "work/a/note.txt" });
  const read = await wait("7", (f) => f.value || f.error);
  results.readFile = read.value ? Buffer.from(read.value, "base64").toString() : read.error;

  send("8", { ...base, method: "execute", command: { argv: ["sh", "-c", "sleep 5"] } });
  const denied = await wait("8", (f) => f.done || f.error);
  results.executeAsync = denied.error ?? "ran";
  // A dropped connection must come back on its own; the daemon has no other retry path.
  socket.ws.terminate();
  const again = await Promise.race([
    new Promise((resolve) => wss.once("connection", (ws) => resolve(ws))),
    new Promise((resolve) => setTimeout(() => resolve(null), 10_000)),
  ]);
  results.reconnect = again ? "reconnected" : "no reconnect";
} catch (error) {
  console.error("FAILED:", error.message);
  console.error(logs.join(""));
  process.exitCode = 1;
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((r) => {
      child.once("exit", r);
      setTimeout(r, 5000);
    });
  }
  wss.close();
}

console.log(JSON.stringify({ home, exitCode: child.exitCode, results, log: logs.join("").trim().split("\n").slice(0, 6) }, null, 2));
