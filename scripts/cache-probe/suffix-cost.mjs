#!/usr/bin/env node
/**
 * How much does the per-turn runtime suffix actually cost in cache hits?
 * Four layouts, same steady-state conversation, no state flip:
 *   N : no runtime state at all                      (control / theoretical ceiling)
 *   P : PRODUCTION - suffix on this turn's user msg, history replayed WITHOUT it
 *   S : PERSISTED  - suffix stored in history and replayed (what deepseek.mjs does)
 *   A : legacy     - runtime state in the system prompt
 */
import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash, scryptSync } from "node:crypto";

const BASE = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.PROBE_MODEL ?? "deepseek-chat";
const TURNS = Number(process.env.PROBE_TURNS ?? 20);
const RUN_TAG = process.env.PROBE_TAG ?? Date.now().toString(36);
const FILLER_LINES = Number(process.env.PROBE_FILLER_LINES ?? 40);

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}
function decrypt(ciphertext, encryptionKey, recordId) {
  const buf = Buffer.from(ciphertext.slice(3), "base64");
  const salt = buf.subarray(0, 16), iv = buf.subarray(16, 28), tag = buf.subarray(28, 44), enc = buf.subarray(44);
  const key = scryptSync(encryptionKey, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(Buffer.from(recordId)); d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}
function loadKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const ek = sh("docker", ["exec", "rakazo-api-1", "printenv", "ENCRYPTION_KEY"]);
  const row = sh("docker", ["exec", "rakazo-postgres-1", "psql", "-U", "rakazo", "-d", "rakazo", "-tAc",
    `select c."secretId" || '|' || s.ciphertext from user_model_credentials c join secrets s on s.id = c."secretId" where c.provider = 'deepseek' limit 1`]);
  const sep = row.indexOf("|");
  return decrypt(row.slice(sep + 1), ek, row.slice(0, sep));
}

const filler = (t) => Array.from({ length: FILLER_LINES }, (_, i) =>
  `Step ${t}.${i + 1}: checked item ${i + 1} against the invariant prefix for turn ${t}; no drift detected, nothing reordered, nothing re-rendered.`).join(" ");
const RULES = Array.from({ length: 90 }, (_, i) =>
  `Rule ${i + 1}: When you summarise part ${i + 1} of a long conversation, keep phrasing stable and reuse the invariant prefix so earlier tokens stay byte-identical.`);
const STATIC = ["You are a careful engineering assistant.", ...RULES].join("\n");
const TOOL_SHELL = { type: "function", function: { name: "user_computer_shell", description: "Run a command on the user's computer.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } };
const TOOL_OBSERVE = { type: "function", function: { name: "user_computer_observe", description: "Capture the user's screen.", parameters: { type: "object", properties: {} } } };

// Same text the real bot renders for two online machines (run-instructions.ts userComputerTurnInstruction).
const SUFFIX = `\n\nThe user's computers connected right now:\n- gm-mac-mini-8jkn (macOS)\n- gm-macbook-pro-wmme (macOS)\nPass computer:"<alias>" to user_computer_* to pick one; omit it to use the default.`;
const SYSTEM_STATE = `\n\n## Runtime state\nuser computers: gm-macbook-pro-wmme (connected), gm-mac-mini-8jkn (connected)`;

async function call(key, body) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
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
  const sys = `[probe ${tag}]\n${STATIC}`;
  const history = [], rows = [];
  for (let turn = 1; turn <= TURNS; turn += 1) {
    const q = `Question ${turn}: summarise what we have covered so far in one sentence.`;
    let messages;
    if (variant === "N") messages = [{ role: "system", content: sys }, ...history, { role: "user", content: q }];
    else if (variant === "A") messages = [{ role: "system", content: sys + SYSTEM_STATE }, ...history, { role: "user", content: q }];
    else messages = [{ role: "system", content: sys }, ...history, { role: "user", content: q + SUFFIX }];
    const r = await call(key, { model: MODEL, messages, tools: [TOOL_SHELL, TOOL_OBSERVE], max_tokens: 32, temperature: 0, stream: false });
    const u = usage(r);
    const answer = r.choices?.[0]?.message?.content ?? "I cannot answer.".replace(" cannot", " will");
    rows.push({ turn, ...u });
    // P = production: the runtime suffix is NOT part of the stored message, so replay is raw.
    // S = persisted: replay the suffix exactly as it was sent.
    history.push({ role: "user", content: variant === "S" ? q + SUFFIX : q });
    history.push({ role: "assistant", content: `${answer} ${filler(turn)}`.trim() });
  }
  return rows;
}

const key = loadKey();
const out = {};
for (const v of ["N", "P", "S", "A"]) out[v] = await runVariant(key, v);

const LABEL = { N: "no injection (ceiling)", P: "PRODUCTION: suffix on user turn, replay raw", S: "persisted injection (deepseek.mjs)", A: "legacy: state in system prompt" };
console.log(`model=${MODEL} turns=${TURNS} tag=${RUN_TAG} suffixChars=${SUFFIX.length}`);
const steady = (rows) => rows.filter((r) => r.turn > 4);
for (const [v, rows] of Object.entries(out)) {
  const tot = rows.reduce((s, r) => s + r.prompt, 0);
  const hit = rows.reduce((s, r) => s + r.hit, 0);
  const miss = rows.reduce((s, r) => s + r.miss, 0);
  const st = steady(rows);
  const meanMiss = st.reduce((s, r) => s + r.miss, 0) / st.length;
  const meanPrompt = st.reduce((s, r) => s + r.prompt, 0) / st.length;
  console.log(`\n${v}  ${LABEL[v]}`);
  console.log(`   total hitrate ${((hit / tot) * 100).toFixed(2)}%   steady-state miss/turn ${meanMiss.toFixed(0)} on ${meanPrompt.toFixed(0)} ctx = ${((meanMiss / meanPrompt) * 100).toFixed(2)}%`);
  if (v === "P" || v === "S" || v === "A") {
    const n = steady(out.N);
    const delta = meanMiss - n.reduce((s, r) => s + r.miss, 0) / n.length;
    console.log(`   extra miss per turn vs N: ${delta.toFixed(0)} tokens`);
  }
}
