import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
import type { AgentRunRequest, CacheCapabilities } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { ContextCacheTracker } from "./context-selection.js";
import { resolveCacheCapabilities } from "./provider-cache-defaults.js";
import { createRuntimeContextPolicy } from "./runtime-context.js";

const HOUR = 60 * 60 * 1000;
const INSTRUCTIONS = "You are a Rakazo bot. Stable instructions only.";
const model = {
  id: "deepseek-flash",
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  contextWindow: 131072,
  maxTokens: 4096,
} as Model<Api>;

/**
 * DeepSeek's context cache as documented: automatic, byte-exact prefix matching, entries
 * cleared after hours to days of disuse, hits reported through `prompt_cache_hit_tokens`.
 * Only prefix reuse is modelled; routing and best-effort eviction are not.
 */
class DeepSeekPrefixCache {
  private readonly entries: { parts: string[]; at: number }[] = [];
  constructor(
    private readonly now: () => number,
    private readonly retentionMs = 6 * HOUR,
  ) {}
  /** Characters of the request that a cached prefix already covers. */
  hit(parts: readonly string[]): number {
    let best = 0;
    for (const entry of this.entries) {
      if (this.now() - entry.at >= this.retentionMs) continue;
      let chars = 0;
      for (let index = 0; index < entry.parts.length && index < parts.length; index++) {
        if (entry.parts[index] !== parts[index]) break;
        chars += entry.parts[index]!.length;
      }
      best = Math.max(best, chars);
    }
    return best;
  }
  store(parts: readonly string[]) {
    this.entries.push({ parts: [...parts], at: this.now() });
  }
}

/**
 * Replays one DeepSeek thread with a two-hour gap between turns. DeepSeek keeps prefixes
 * that long; a five-minute window (Anthropic's) would not, which is what the third test
 * covers. Each turn carries enough text to exceed the short-history allowance, because
 * below it a cold prediction keeps originals and the prefix survives by accident.
 */
function replay(capabilities: CacheCapabilities | undefined, turns = 24) {
  let now = 0;
  const tracker = new ContextCacheTracker(() => now);
  const server = new DeepSeekPrefixCache(() => now);
  const sent: { id: string; text: string }[] = [];
  let sentTokens = 0;
  let hitTokens = 0;
  let warm = 0;
  let keptLast = 0;
  for (let turn = 0; turn < turns; turn++) {
    const prompt = `Turn ${turn} objective: ${"detail ".repeat(600)}`;
    const history = sent.map((entry) => ({
      id: entry.id,
      createdAt: "2026-01-01T00:00:00Z",
      role: "user" as const,
      content: entry.text,
    }));
    const messages = sent.map(
      (entry, index) =>
        ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: [{ type: "text", text: entry.text }],
          timestamp: 0,
          rakazoHistory: true,
          rakazoMessageId: entry.id,
        }) as Message,
    );
    messages.push({
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: now,
    } as Message);
    const context: Context = { systemPrompt: INSTRUCTIONS, tools: [], messages };
    const request: AgentRunRequest = {
      botId: "bot",
      threadId: "thread",
      runId: `run-${turn}`,
      instructions: INSTRUCTIONS,
      prompt,
      history,
      tools: [],
      model: { provider: "deepseek", id: "deepseek-flash", cacheCapabilities: capabilities },
      contextStrategy: "cache-aware",
    };
    const policy = createRuntimeContextPolicy(request, undefined, { cacheTracker: tracker });
    const prepared = policy.prepareContext(context, model);
    const wire = [
      INSTRUCTIONS,
      ...prepared.messages.map((message) => JSON.stringify(message.content)),
    ];
    const hit = server.hit(wire);
    server.store(wire);
    const sentEstimate = Math.ceil(wire.join("\u0000").length / 4);
    const hitEstimate = Math.ceil(hit / 4);
    sentTokens += sentEstimate;
    hitTokens += hitEstimate;
    policy.onUsage({ inputTokens: sentEstimate, outputTokens: 8, cacheReadTokens: hitEstimate });
    if (policy.getDecision()!.predictedCache === "likely-warm") warm += 1;
    keptLast = prepared.messages.length;
    sent.push({ id: `m-${turn}`, text: prompt }, { id: `a-${turn}`, text: "Acknowledged." });
    now += 2 * HOUR;
  }
  return { hitRate: hitTokens / sentTokens, warm, keptLast, turns };
}

describe("DeepSeek prefix cache hit rate", () => {
  it("stays under 60% when the connection declares no cache window", () => {
    const result = replay(undefined);
    expect(result.warm).toBe(0);
    expect(result.hitRate).toBeLessThan(0.6);
  });

  it("reaches 90% with the provider window and keeps every earlier message", () => {
    const { cacheCapabilities, notes } = resolveCacheCapabilities("deepseek");
    expect(notes).toEqual([]);
    const result = replay(cacheCapabilities);
    expect(result.warm).toBeGreaterThan(result.turns - 3);
    expect(result.hitRate).toBeGreaterThan(0.9);
    // Every earlier message survives; a cold prediction would keep a catalogue plus the
    // last few exchanges instead.
    expect(result.keptLast).toBeGreaterThan(40);
  });

  it("recovers a five-minute window copied onto the DeepSeek connection", () => {
    const copied = { scope: "account" as const, retentionMs: 300000, minimumTokens: 1 };
    const asIs = replay(copied);
    expect(asIs.warm).toBe(0);
    expect(asIs.hitRate).toBeLessThan(0.6);
    const resolved = replay(resolveCacheCapabilities("deepseek", copied).cacheCapabilities);
    expect(resolved.hitRate).toBeGreaterThan(0.9);
    expect(resolved.hitRate).toBeGreaterThan(asIs.hitRate * 1.8);
    expect(resolved.keptLast).toBeGreaterThan(asIs.keptLast + 25);
  });
});
