import type { CacheCapabilities } from "@rakazo/adapter-kit";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * How a provider caches prompt prefixes. Declared here only for providers that cache
 * server-side with no client marker: Pi sends them no `cache_control`, so the prefix is
 * matched byte for byte and nothing in the request can extend or qualify it.
 *
 * `retentionMs` is the window we are willing to treat as still warm. It is a provider fact,
 * not a user preference, because a declaration that is shorter than the provider's real
 * window makes `ContextCacheTracker.predict` report "likely-cold", which prunes history to
 * the last few exchanges — and pruning rewrites the very prefix that would have hit.
 * The cost is asymmetric: predicting warm when the cache expired re-sends a prefix at full
 * price, while predicting cold when it is warm guarantees a miss.
 *
 * A profile deliberately has no `retentionMode`: these caches are automatic, so no request
 * field could extend or qualify them, and an auto-written mode would be a request-level
 * control (`resolvePiCacheRetention`) the provider rejects. Timing predictions only.
 */
export interface ProviderCacheProfile {
  /** Conservative lower bound of the provider's documented retention. */
  retentionMs: number;
  /** Ceiling for a declared window; a longer declaration cannot be honored. */
  maxRetentionMs: number;
  /** Tokens the provider needs before it caches at all; 0 when there is no documented floor. */
  minimumTokens: number;
}

export const PROVIDER_CACHE_PROFILES: Readonly<Record<string, ProviderCacheProfile>> = {
  // DeepSeek context caching: automatic, best-effort, unused entries cleared after hours to
  // days, no minimum prefix length, no write surcharge.
  deepseek: {
    retentionMs: 6 * HOUR,
    maxRetentionMs: 48 * HOUR,
    minimumTokens: 0,
  },
  // Z.AI (GLM) context caching: automatic implicit caching with a "reasonable" validity
  // period that the docs leave unpinned, so stay shorter than DeepSeek's bound.
  zai: {
    retentionMs: 2 * HOUR,
    maxRetentionMs: 24 * HOUR,
    minimumTokens: 0,
  },
};

export interface CacheCapabilitiesResolution {
  cacheCapabilities?: CacheCapabilities;
  /** Why a declared value was overridden or clamped; empty when nothing changed. */
  notes: string[];
}

/**
 * Fills in capabilities a connection left unset and rejects declarations the provider
 * cannot honor. A connection that explicitly disables caching keeps that decision.
 */
export function resolveCacheCapabilities(
  provider: string,
  declared?: CacheCapabilities,
  apiProtocol?: string,
): CacheCapabilitiesResolution {
  // An Anthropic-shaped endpoint caches at client-stamped breakpoints with the retention
  // Pi chooses, so a provider profile would only add markers that endpoint never needed.
  if (apiProtocol === "anthropic-messages") return { cacheCapabilities: declared, notes: [] };
  const profile = PROVIDER_CACHE_PROFILES[provider];
  if (!profile) return { cacheCapabilities: declared, notes: [] };
  if (declared?.retentionMode === "none") return { cacheCapabilities: declared, notes: [] };
  const notes: string[] = [];
  const declaredRetention = declared?.retentionMs;
  if (
    declaredRetention !== undefined &&
    (!Number.isFinite(declaredRetention) || declaredRetention < profile.retentionMs)
  ) {
    notes.push(
      `${provider} keeps prefixes for at least ${profile.retentionMs}ms; ` +
        `declared ${String(declaredRetention)}ms would predict a cold cache and prune the prefix`,
    );
  }
  let retentionMs = Math.max(declaredRetention ?? 0, profile.retentionMs);
  if (retentionMs > profile.maxRetentionMs) {
    notes.push(
      `${provider} cache retention is bounded by ${profile.maxRetentionMs}ms; ` +
        `declared ${retentionMs}ms was clamped`,
    );
    retentionMs = profile.maxRetentionMs;
  }
  const declaredMinimum = declared?.minimumTokens;
  if (declaredMinimum !== undefined && declaredMinimum > profile.minimumTokens) {
    notes.push(
      `${provider} caches from the first token; a ${declaredMinimum}-token floor would report a ` +
        "warm prefix as cold",
    );
  }
  return {
    cacheCapabilities: {
      // A declared retentionMode passes through untouched; the profile adds none because
      // an automatic cache has no request-level control to request.
      ...declared,
      scope: declared?.scope ?? "account",
      retentionMs,
      minimumTokens: Math.min(declaredMinimum ?? profile.minimumTokens, profile.minimumTokens),
    },
    notes,
  };
}
