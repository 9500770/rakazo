/**
 * Which outbound proxy env sends a URL through, if any. Mirrors undici's EnvHttpProxyAgent
 * rules (scheme-specific proxy vars, NO_PROXY suffix matching) so safety checks and the actual
 * transport agree on where a request really goes.
 *
 * The reason this exists separately: egress guards resolve hostnames locally and refuse
 * private answers. On networks with poisoned DNS (blocked domains return bogus private
 * addresses), a request that is in fact tunneled through an operator-configured proxy never
 * uses those local answers — the proxy resolves the hostname itself — so refusing on them
 * breaks every blocked destination. Callers skip the local address check exactly and only
 * when this reports a proxy.
 */
export function outboundProxyForUrl(url: {
  protocol: string;
  hostname: string;
}): string | undefined {
  const { env } = process;
  const proxy =
    url.protocol === "https:"
      ? (env.https_proxy ?? env.HTTPS_PROXY)
      : (env.http_proxy ?? env.HTTP_PROXY);
  if (!proxy) return undefined;
  if (!/^https?:\/\//i.test(proxy)) throw new Error("Only HTTP proxies are supported");
  const bypass = env.no_proxy ?? env.NO_PROXY ?? "";
  if (!bypass.trim()) return proxy;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  for (const raw of bypass.split(",")) {
    const entry = raw.trim().toLowerCase().replace(/^\./, "");
    if (!entry) continue;
    if (entry === "*" || host === entry || host.endsWith(`.${entry}`)) return undefined;
  }
  return proxy;
}

/** Whether any outbound proxy is configured at all, regardless of per-URL NO_PROXY matching. */
export function anyOutboundProxyConfigured(): boolean {
  const { env } = process;
  return Boolean(env.http_proxy ?? env.HTTP_PROXY ?? env.https_proxy ?? env.HTTPS_PROXY);
}
