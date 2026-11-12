#!/usr/bin/env node
/**
 * Live probe: does DeepSeek's automatic prefix cache actually depend on byte-stable prefixes?
 *
 * Same 6-turn conversation, three prompt layouts:
 *   A1 legacy-state-in-system : dynamic runtime state appended to the SYSTEM prompt
 *   A2 legacy-state+tool-change: A1 plus the tool list changes when a device drops offline
 *   B  fixed                   : system + tools constant, state appended to the USER turn
 *
 * At turn 4 a laptop flips to disconnected (the event our fix is about).
 * Reports real usage.prompt_cache_hit_tokens / prompt_cache_miss_tokens per turn.
 *
 * The API key is read from DEEPSEEK_API_KEY or decrypted from the local Rakazo database.
 * It is never printed.
 */
import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash, scryptSync } from "node:crypto";

const BASE = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.PROBE_MODEL ?? "deepseek-chat";
const TURNS = Number(process.env.PROBE_TURNS ?? 8);
const FLIP_TURN = Number(process.env.PROBE_FLIP_TURN ?? 5); // the laptop disconnects right before this turn's request
// Each variant gets its own tag so it builds its own cache prefix instead of reusing another variant's.
const RUN_TAG = process.env.PROBE_TAG ?? Date.now().toString(36);
const HISTORY_FILLER_LINES = Number(process.env.PROBE_FILLER_LINES ?? 60);

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function decrypt(ciphertext, encryptionKey, recordId) {
  if (!ciphertext.startsWith("v2:")) {
    const buf = Buffer.from(ciphertext, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const d = createDecipheriv("aes-256-gcm", createHash("sha256").update(encryptionKey).digest(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  }
  const buf = Buffer.from(ciphertext.slice(3), "base64");
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(28, 44);
  const enc = buf.subarray(44);
  const key = scryptSync(encryptionKey, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(Buffer.from(recordId));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

function loadKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const encryptionKey = sh("docker", ["exec", "rakazo-api-1", "printenv", "ENCRYPTION_KEY"]);
  const row = sh("docker", [
    "exec", "rakazo-postgres-1", "psql", "-U", "rakazo", "-d", "rakazo", "-tAc",
    `select c."secretId" || '|' || s.ciphertext from user_model_credentials c join secrets s on s.id = c."secretId" where c.provider = 'deepseek' limit 1`,
  ]);
  const sep = row.indexOf("|");
  const recordId = row.slice(0, sep);
  const ciphertext = row.slice(sep + 1);
  return decrypt(ciphertext, encryptionKey, recordId);
}

const filler = (turn) => Array.from({ length: HISTORY_FILLER_LINES }, (_, i) =>
  `Step ${turn}.${i + 1}: checked item ${i + 1} against the invariant prefix for turn ${turn}; no drift detected, nothing reordered, nothing re-rendered.`,
).join(" ");

const RULES = Array.from({ length: 90 }, (_, i) =>
  `Rule ${i + 1}: When you summarise part ${i + 1} of a long conversation, keep phrasing stable and reuse the invariant prefix so earlier tokens stay byte-identical.`,
);
const STATIC = ["You are a careful engineering assistant.", ...RULES].join("\n");

const TOOL_SHELL = { type: "function", function: { name: "user_computer_shell", description: "Run a command on the user's computer.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } };
const TOOL_OBSERVE = { type: "function", function: { name: "user_computer_observe", description: "Capture the user's screen.", parameters: { type: "object", properties: {} } } };

const devices = (offline) => offline
  ? "macbook-pro (disconnected), mac-mini (connected)"
  : "macbook-pro (connected), mac-mini (connected)";

async function call(key, body) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

const usage = (r) => {
  const u = r.usage ?? {};
  const hit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const miss = u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens ?? 0) - hit);
  return { prompt: u.prompt_tokens ?? 0, hit, miss };
};

async function runVariant(key, variant) {
  const tag = `${RUN_TAG}-${variant}`;
  const history = [];
  const rows = [];
  for (let turn = 1; turn <= TURNS; turn += 1) {
    const offline = turn >= FLIP_TURN;
    let messages;
    let tools;
    if (variant === "B") {
      messages = [{ role: "system", content: `[probe ${tag}]\n${STATIC}` }, ...history,
        { role: "user", content: `Question ${turn}: summarise what we have covered so far in one sentence.\n\n[runtime] user computers: ${devices(offline)}` }];
      tools = [TOOL_SHELL, TOOL_OBSERVE];
    } else {
      messages = [{ role: "system", content: `[probe ${tag}]\n${STATIC}\n\n## Runtime state\nuser computers: ${devices(offline)}` }, ...history,
        { role: "user", content: `Question ${turn}: summarise what we have covered so far in one sentence.` }];
      tools = variant === "A2" && offline ? [TOOL_SHELL] : [TOOL_SHELL, TOOL_OBSERVE];
    }
    const r = await call(key, { model: MODEL, messages, tools, max_tokens: 32, temperature: 0, stream: false });
    const u = usage(r);
    const answer = r.choices?.[0]?.message?.content ?? "";
    rows.push({ turn, offline, ...u });
    history.push({ role: "user", content: messages[messages.length - 1].content });
    history.push({ role: "assistant", content: `${answer} ${filler(turn)}`.trim() });
  }
  return rows;
}

const key = loadKey();
const out = {};
for (const variant of ["A1", "A2", "B"]) out[variant] = await runVariant(key, variant);

console.log(`model=${MODEL} turns=${TURNS} flip=${FLIP_TURN} tag=${RUN_TAG}`);
for (const [variant, rows] of Object.entries(out)) {
  const prompt = rows.reduce((s, r) => s + r.prompt, 0);
  const hit = rows.reduce((s, r) => s + r.hit, 0);
  const miss = rows.reduce((s, r) => s + r.miss, 0);
  const label = { A1: "legacy: state in system", A2: "legacy: state in system + tool list change", B: "fixed: state in user turn" }[variant];
  console.log(`\n${variant}  ${label}`);
  console.log("  turn  prompt   hit    miss   hitrate  event");
  for (const r of rows) {
    const pct = r.prompt ? ((r.hit / r.prompt) * 100).toFixed(1) : "0.0";
    console.log(`  ${String(r.turn).padStart(4)}  ${String(r.prompt).padStart(6)}  ${String(r.hit).padStart(5)}  ${String(r.miss).padStart(6)}   ${pct.padStart(5)}%  ${r.offline && r.turn === FLIP_TURN ? "device dropped" : ""}`);
  }
  console.log(`  total prompt=${prompt} hit=${hit} miss=${miss} hitrate=${((hit / prompt) * 100).toFixed(1)}%`);
}
