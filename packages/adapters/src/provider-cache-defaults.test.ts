import { describe, expect, it } from "vitest";
import { resolvePiCacheRetention } from "./pi-cache-retention.js";
import { PROVIDER_CACHE_PROFILES, resolveCacheCapabilities } from "./provider-cache-defaults.js";

const deepseekChat = { api: "openai-completions" as const };

describe("provider cache defaults", () => {
  it("gives DeepSeek and Z.AI their automatic-prefix timing window with no request-level mode", () => {
    for (const provider of ["deepseek", "zai"]) {
      const { cacheCapabilities, notes } = resolveCacheCapabilities(provider);
      expect(notes).toEqual([]);
      expect(cacheCapabilities).toMatchObject({
        scope: "account",
        minimumTokens: 0,
      });
      // An automatic cache has no request-level retention control; auto-writing one is a
      // mode these Chat Completions endpoints reject in resolvePiCacheRetention.
      expect(cacheCapabilities!.retentionMode).toBeUndefined();
      expect(() =>
        resolvePiCacheRetention(deepseekChat, cacheCapabilities?.retentionMode),
      ).not.toThrow();
    }
    expect(PROVIDER_CACHE_PROFILES.deepseek!.retentionMs).toBe(6 * 60 * 60 * 1000);
    expect(PROVIDER_CACHE_PROFILES.zai!.retentionMs).toBe(2 * 60 * 60 * 1000);
    expect(PROVIDER_CACHE_PROFILES.deepseek!.retentionMs).toBeGreaterThan(
      PROVIDER_CACHE_PROFILES.zai!.retentionMs,
    );
  });

  it("passes a connection's declared retention mode through untouched", () => {
    const { cacheCapabilities } = resolveCacheCapabilities("deepseek", {
      scope: "account",
      retentionMode: "long",
    });
    expect(cacheCapabilities!.retentionMode).toBe("long");
    // Validation stays the authority: an unsupported manual mode on Chat Completions throws.
    expect(() => resolvePiCacheRetention(deepseekChat, "long")).toThrow("Unsupported");
  });

  it("raises a copied five-minute window instead of pruning the prefix five minutes in", () => {
    const { cacheCapabilities, notes } = resolveCacheCapabilities("deepseek", {
      scope: "account",
      retentionMs: 300000,
      minimumTokens: 1,
    });
    expect(cacheCapabilities!.retentionMs).toBe(PROVIDER_CACHE_PROFILES.deepseek!.retentionMs);
    expect(cacheCapabilities!.minimumTokens).toBe(0);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("keeps prefixes for at least");
    expect(notes[1]).toContain("caches from the first token");
  });

  it("clamps a window longer than the provider can keep", () => {
    const { cacheCapabilities, notes } = resolveCacheCapabilities("zai", {
      scope: "account",
      retentionMs: 30 * 24 * 60 * 60 * 1000,
    });
    expect(cacheCapabilities!.retentionMs).toBe(PROVIDER_CACHE_PROFILES.zai!.maxRetentionMs);
    expect(notes[0]).toContain("bounded by");
  });

  it("keeps the cost fields and scope a connection declared", () => {
    const { cacheCapabilities } = resolveCacheCapabilities("deepseek", {
      scope: "connection",
      inputCostPerMillion: 0.3,
      readCostPerMillion: 0.006,
    });
    expect(cacheCapabilities).toMatchObject({
      scope: "connection",
      inputCostPerMillion: 0.3,
      readCostPerMillion: 0.006,
    });
  });

  it("leaves an Anthropic-shaped endpoint to Pi's own breakpoints", () => {
    const declared = { scope: "account" as const, retentionMs: 300000 };
    expect(resolveCacheCapabilities("deepseek", declared, "anthropic-messages")).toEqual({
      cacheCapabilities: declared,
      notes: [],
    });
    expect(resolveCacheCapabilities("deepseek", undefined, "anthropic-messages")).toEqual({
      cacheCapabilities: undefined,
      notes: [],
    });
    expect(
      resolveCacheCapabilities("deepseek", undefined, "chat-completions").cacheCapabilities,
    ).toMatchObject({ retentionMs: PROVIDER_CACHE_PROFILES.deepseek!.retentionMs });
  });

  it("honors an explicit opt-out and leaves unrelated providers untouched", () => {
    const off = { scope: "account" as const, retentionMode: "none" as const };
    expect(resolveCacheCapabilities("deepseek", off)).toEqual({
      cacheCapabilities: off,
      notes: [],
    });
    expect(resolveCacheCapabilities("anthropic")).toEqual({
      cacheCapabilities: undefined,
      notes: [],
    });
    const declared = { scope: "account" as const, retentionMs: 300000 };
    expect(resolveCacheCapabilities("anthropic", declared).cacheCapabilities).toBe(declared);
  });
});
