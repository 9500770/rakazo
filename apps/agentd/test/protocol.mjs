// Deeper protocol coverage on a real macOS host: files, limits, timeout, cancel,
// isolation, concurrency, env, modes. Mock server only; no credentials.
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const here = path.dirname(new URL(import.meta.url).pathname);
const require = createRequire(path.join(here, "../../../packages/adapters/package.json"));
const { WebSocketServer } = require("ws");
const bundle = path.join(here, "../dist/agentd.mjs");
const home = process.env.PROTO_HOME ?? (await mkdtemp(path.join(tmpdir(), "agentd-proto-")));
await mkdir(home, { recursive: true });
const logs = [];
const results = [];
const cfgPath = path.join(home, "config.json");

function baseConfig(mode) {
  return {
    version: 1, serverUrl: "http://127.0.0.1:0", name: "proto", mode, askMinutes: 30,
    notify: false, notifyMinutes: 15, workspaceRoot: path.join(home, "computers"),
    env: { AGENTD_TEST_VAR: "injected" }, retryMs: { min: 100, max: 400 },
    sessionRefreshHours: 6, logMaxBytes: 1 << 20,
    device: { deviceId: "dev_proto", userId: "usr_proto", token: "proto-token" },
    signIn: null, account: null,
  };
}
await writeFile(cfgPath, JSON.stringify(baseConfig("auto")), { mode: 0o600 });

const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/api/devices/connect" });
await new Promise((r) => wss.once("listening", r));
const port = wss.address().port;
const config = JSON.parse(await readFile(cfgPath, "utf8"));
config.serverUrl = `http://127.0.0.1:${port}`;
await writeFile(cfgPath, JSON.stringify(config), { mode: 0o600 });

let child = null;
const frames = new Map();
let socket = null;
function spawnAgent() {
  child = spawn(process.execPath, [bundle, "run"], {
    env: { ...process.env, RAKAZO_AGENT_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => logs.push(d.toString()));
  child.stderr.on("data", (d) => logs.push(d.toString()));
}
function nextConnection(ms = 15000) {
  return Promise.race([
    new Promise((resolve) => wss.once("connection", (ws) => {
      socket = ws;
      ws.on("message", (data) => {
        const m = JSON.parse(data.toString());
        const list = frames.get(m.id) ?? [];
        list.push(m.frame);
        frames.set(m.id, list);
      });
      resolve(ws);
    })),
    new Promise((_, reject) => setTimeout(() => reject(new Error("no connection; " + logs.join("").slice(-800))), ms)),
  ]);
}
function send(id, request) {
  frames.set(id, []);
  socket.send(JSON.stringify({ type: "request", id, request }));
}
async function wait(id, pred, ms = 60000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = (frames.get(id) ?? []).find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout on ${id}: ${JSON.stringify(frames.get(id))}`);
}
const all = (id) => frames.get(id) ?? [];
const finalOf = (id) => { const f = all(id).filter((x) => x.done || x.error !== undefined); return f[f.length - 1]; };
const text = (id) => all(id).filter((f) => f.value && f.value.type === "stdout").map((f) => f.value.data).join("");
const errText = (id) => all(id).filter((f) => f.value && f.value.type === "stderr").map((f) => f.value.data).join("");
const exitCode = (id) => { const f = all(id).findLast((x) => x.value && x.value.type === "exit"); return f?.value.code; };
const cli = (...args) => spawnSync(process.execPath, [bundle, ...args], {
  env: { ...process.env, RAKAZO_AGENT_HOME: home }, encoding: "utf8",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function test(name, fn) {
  const t0 = Date.now();
  process.stderr.write(`>> ${name} ... `);
  try { const r = await fn(); results.push({ name, ...r }); process.stderr.write(`ok ${Date.now() - t0}ms\n`); }
  catch (error) { results.push({ name, failed: error.message }); process.stderr.write(`FAIL ${Date.now() - t0}ms ${error.message}\n`); }
}
const req = (extra) => ({ botId: "bot_a", ...extra });

spawnAgent();
await nextConnection();
send("env", req({ method: "environment" }));
await wait("env", (f) => f.value || f.error);
send("prov", req({ method: "provision" })); await wait("prov", (f) => f.value || f.error);
send("prep", req({ method: "prepare" })); await wait("prep", (f) => f.done || f.error);

await test("environment", async () => {
  const e = await wait("env", (f) => f.value || f.error);
  return { platform: e.value?.platform, shell: e.value?.shell, homeOk: e.value?.home?.startsWith("/Users/") };
});

await test("execute: stdout + exit 0", async () => {
  send("t1", req({ method: "execute", command: { argv: ["sh", "-c", "echo hello-agentd"] } }));
  await wait("t1", (f) => f.done || f.error, 20000);
  return { out: text("t1").trim(), code: exitCode("t1"), done: Boolean(finalOf("t1").done) };
});

await test("execute: exit code 7 propagates", async () => {
  send("t2", req({ method: "execute", command: { argv: ["sh", "-c", "exit 7"] } }));
  await wait("t2", (f) => f.done || f.error, 20000);
  return { code: exitCode("t2") };
});

await test("execute: stderr separated from stdout", async () => {
  send("t3", req({ method: "execute", command: { argv: ["sh", "-c", "echo out; echo err >&2"] } }));
  await wait("t3", (f) => f.done || f.error, 20000);
  return { out: text("t3").trim(), err: errText("t3").trim() };
});

await test("execute: cwd outside home refused", async () => {
  send("t4", req({ method: "execute", command: { argv: ["sh", "-c", "pwd"], cwd: "/etc" } }));
  await wait("t4", (f) => f.done || f.error, 20000);
  return { err: (errText("t4") || finalOf("t4").error || "").trim(), code: exitCode("t4") };
});

await test("env: config env injected", async () => {
  send("t5", req({ method: "execute", command: { argv: ["sh", "-c", "printf %s \"$AGENTD_TEST_VAR\""] } }));
  await wait("t5", (f) => f.done || f.error, 20000);
  return { out: text("t5").trim() };
});

await test("env: per-request env + unsetEnv", async () => {
  send("t6", req({ method: "execute", command: {
    argv: ["sh", "-c", "printf 'A=%s B=%s' \"$FOO\" \"$AGENTD_TEST_VAR\""],
    env: { FOO: "bar" }, unsetEnv: ["AGENTD_TEST_VAR"],
  } }));
  await wait("t6", (f) => f.done || f.error, 20000);
  return { out: text("t6").trim() };
});

await test("timeout: 800ms kills sleep 10", async () => {
  const started = Date.now();
  send("t7", req({ method: "execute", command: { argv: ["sh", "-c", "sleep 10"], timeoutMs: 800 } }));
  const f = await wait("t7", (x) => x.done || x.error, 20000);
  const ms = Date.now() - started;
  await sleep(300);
  const stray = spawnSync("sh", ["-c", "pgrep -f 'sleep 10' | wc -l"], { encoding: "utf8" });
  return { ms, final: f.error ?? "done", stray: stray.stdout.trim() };
});

await test("cancel: cancelRunWork stops sleep 30", async () => {
  const started = Date.now();
  send("t8", req({ method: "execute", runId: "run-cancel", command: { argv: ["sh", "-c", "sleep 30"] } }));
  await sleep(600);
  send("t9", req({ method: "cancelRunWork", targetRunId: "run-cancel" }));
  const f = await wait("t8", (x) => x.done || x.error, 15000);
  return { ms: Date.now() - started, final: f.error ?? "done" };
});

await test("files: binary roundtrip + listFiles", async () => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  send("f1", req({ method: "writeFile", file: { path: "work/b/b.bin", content: bytes.toString("base64") } }));
  await wait("f1", (f) => f.done || f.error, 20000);
  send("f2", req({ method: "readFile", path: "work/b/b.bin" }));
  const r = await wait("f2", (f) => f.value || f.error, 20000);
  const back = r.value ? Buffer.from(r.value, "base64") : null;
  send("f3", req({ method: "listFiles", path: "work/b" }));
  const list = await wait("f3", (f) => f.value !== undefined || f.error, 20000);
  return {
    write: finalOf("f1")?.done ? "ok" : finalOf("f1")?.error,
    roundtrip: back ? back.equals(bytes) : `error: ${r.error}`,
    listing: Array.isArray(list.value) ? list.value.map((x) => x.name ?? x.path) : list.error,
  };
});

await test("files: 8MB write refused", async () => {
  const big = Buffer.alloc(8 * 1024 * 1024 + 1, 0x41).toString("base64");
  send("f4", req({ method: "writeFile", file: { path: "work/b/big.bin", content: big } }));
  const f = await wait("f4", (x) => x.done || x.error, 30000);
  return { final: f.error ?? "accepted" };
});

await test("isolation: bot_b cannot read bot_a's file", async () => {
  send("f5", { botId: "bot_b", method: "readFile", path: "work/b/b.bin" });
  const f = await wait("f5", (x) => x.value !== undefined || x.error, 20000);
  return { final: f.error ?? "READABLE(value)" };
});

await test("concurrency: 17 parallel commands hit the cap", async () => {
  const ids = Array.from({ length: 17 }, (_, i) => `c${i}`);
  for (const id of ids) send(id, req({ method: "execute", runId: id, command: { argv: ["sh", "-c", "sleep 2"] } }));
  const finals = await Promise.all(ids.map((id) => wait(id, (f) => f.done || f.error, 40000).catch((e) => ({ error: e.message }))));
  const busy = finals.filter((f) => f.error && /busy|capacity/i.test(String(f.error))).length;
  const ran = finals.filter((f) => f.done || (f.value && f.value.type === "exit")).length;
  return { ran, busy, other: finals.filter((f) => f.error && !/busy|capacity/i.test(String(f.error))).map((f) => f.error).slice(0, 3) };
});

await test("modes: ask denies, unlock allows, deny blocks", async () => {
  const setMode = async (mode) => {
    const c = JSON.parse(await readFile(cfgPath, "utf8"));
    c.mode = mode;
    await writeFile(cfgPath, JSON.stringify(c), { mode: 0o600 });
    await sleep(2300);
  };
  await setMode("ask");
  send("m1", req({ method: "execute", command: { argv: ["sh", "-c", "echo should-not-run"] } }));
  const denied = await wait("m1", (f) => f.done || f.error, 20000);
  await cli("unlock", "--minutes", "1");
  await sleep(2100);
  send("m2", req({ method: "execute", command: { argv: ["sh", "-c", "echo after-unlock"] } }));
  await wait("m2", (f) => f.done || f.error, 20000);
  await setMode("deny");
  send("m3", req({ method: "execute", command: { argv: ["sh", "-c", "echo nope"] } }));
  const deny = await wait("m3", (f) => f.done || f.error, 20000);
  await setMode("auto");
  send("m4", req({ method: "execute", command: { argv: ["sh", "-c", "echo back-auto"] } }));
  await wait("m4", (f) => f.done || f.error, 20000);
  return { askDenied: denied.error ?? "RAN", afterUnlock: text("m2").trim(), deny: deny.error ?? "RAN", auto: text("m4").trim() };
});

await test("pause: blocks without losing the socket", async () => {
  await cli("pause");
  await sleep(300);
  send("p1", req({ method: "execute", command: { argv: ["sh", "-c", "echo paused-run"] } }));
  const f = await wait("p1", (x) => x.done || x.error, 20000);
  await cli("resume");
  await sleep(300);
  send("p2", req({ method: "execute", command: { argv: ["sh", "-c", "echo resumed-run"] } }));
  await wait("p2", (x) => x.done || x.error, 20000);
  return { whilePaused: f.error ?? "RAN", afterResume: text("p2").trim() };
});

await test("screen: darwin observe", async () => {
  send("s1", req({ method: "screenObserve" }));
  const f = await wait("s1", (x) => x.value !== undefined || x.error || x.done, 90000).catch((e) => ({ error: e.message }));
  return { final: f.error ? String(f.error).slice(0, 160) : f.value ? Object.keys(f.value).slice(0, 6) : f };
});

await test("reconnect: socket drop recovers", async () => {
  const started = Date.now();
  socket.terminate();
  await nextConnection(20000);
  return { ms: Date.now() - started };
});

console.log(JSON.stringify({ home, alive: child.exitCode === null, results }, null, 2));
if (child.exitCode === null) { child.kill("SIGTERM"); await sleep(500); }
wss.close();
