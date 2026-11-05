import { afterEach, describe, expect, it, vi } from "vitest";
import { anyOutboundProxyConfigured, outboundProxyForUrl } from "./outbound-proxy.js";

const http = (value: string) => ({ protocol: "http:", hostname: value });
const https = (value: string) => ({ protocol: "https:", hostname: value });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("outbound proxy selection", () => {
  it("picks the proxy for the URL scheme, either case", () => {
    vi.stubEnv("HTTP_PROXY", "http://proxy.lan:1");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.lan:2");
    expect(outboundProxyForUrl(http("a.test"))).toBe("http://proxy.lan:1");
    expect(outboundProxyForUrl(https("a.test"))).toBe("http://proxy.lan:2");
    vi.unstubAllEnvs();
    vi.stubEnv("http_proxy", "http://proxy.lan:3");
    vi.stubEnv("https_proxy", "http://proxy.lan:4");
    expect(outboundProxyForUrl(http("a.test"))).toBe("http://proxy.lan:3");
    expect(outboundProxyForUrl(https("a.test"))).toBe("http://proxy.lan:4");
  });

  it("stays direct with no proxy configured", () => {
    expect(outboundProxyForUrl(https("a.test"))).toBeUndefined();
    expect(anyOutboundProxyConfigured()).toBe(false);
  });

  it("honors NO_PROXY suffix, wildcard and dot-prefix entries", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.lan:2");
    vi.stubEnv("NO_PROXY", "a.test,.corp.test,b.test");
    expect(outboundProxyForUrl(https("a.test"))).toBeUndefined();
    expect(outboundProxyForUrl(https("x.a.test"))).toBeUndefined();
    expect(outboundProxyForUrl(https("host.corp.test"))).toBeUndefined();
    expect(outboundProxyForUrl(https("b.test"))).toBeUndefined();
    expect(outboundProxyForUrl(https("other.test"))).toBe("http://proxy.lan:2");
    expect(anyOutboundProxyConfigured()).toBe(true);
    vi.stubEnv("NO_PROXY", "*");
    expect(outboundProxyForUrl(https("anything.test"))).toBeUndefined();
  });

  it("does not suffix-match across labels", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.lan:2");
    vi.stubEnv("NO_PROXY", "ba.test");
    expect(outboundProxyForUrl(https("a.test"))).toBe("http://proxy.lan:2");
  });

  it("refuses a non-HTTP proxy", () => {
    vi.stubEnv("HTTPS_PROXY", "socks5://127.0.0.1:1080");
    expect(() => outboundProxyForUrl(https("a.test"))).toThrow("Only HTTP proxies are supported");
  });
});
