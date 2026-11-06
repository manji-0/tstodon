import { describe, expect, it } from "vite-plus/test";
import {
  isBlockedFederatedHost,
  isFederatedHostRefused,
  parseFederatedUrl,
  webfingerScheme,
} from "./federated-fetch";

describe("isBlockedFederatedHost", () => {
  it("blocks loopback by default", () => {
    expect(isBlockedFederatedHost("127.0.0.1", "example.com")).toBe(true);
    expect(isBlockedFederatedHost("localhost", "example.com")).toBe(true);
  });

  it("allows hosts listed in the e2e allowlist", () => {
    const allow = new Set(["127.0.0.1"]);
    expect(isBlockedFederatedHost("127.0.0.1", "127.0.0.1:8792", allow)).toBe(false);
  });

  it("still blocks the local instance domain even when not loopback", () => {
    expect(isBlockedFederatedHost("peer.example", "peer.example")).toBe(true);
  });

  it("blocks private and link-local ranges", () => {
    expect(isBlockedFederatedHost("10.0.0.1", "example.com")).toBe(true);
    expect(isBlockedFederatedHost("192.168.1.1", "example.com")).toBe(true);
    expect(isBlockedFederatedHost("169.254.1.1", "example.com")).toBe(true);
    expect(isBlockedFederatedHost("172.16.0.1", "example.com")).toBe(true);
    expect(isBlockedFederatedHost("172.31.255.255", "example.com")).toBe(true);
    expect(isBlockedFederatedHost("172.32.0.1", "example.com")).toBe(false);
    expect(isBlockedFederatedHost("peer.example", "example.com")).toBe(false);
  });
});

describe("isFederatedHostRefused", () => {
  it.each([
    "127.0.0.2",
    "127.255.255.254",
    "127.1",
    "2130706433",
    "0x7f000001",
    "0x7f.0.0.1",
    "0177.0.0.1",
    "0.0.0.0",
    "0.1.2.3",
    "10.1.2.3",
    "100.64.0.1",
    "100.127.255.255",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "[::1]",
    "::1",
    "[::]",
    "[::ffff:7f00:1]",
    "[::ffff:127.0.0.1]",
    "[fd00::1]",
    "[fe80::1]",
    "[2001:db8::1]",
    "localhost",
    "localhost.",
    "LOCALHOST",
    "api.localhost",
    "metadata.google.internal",
    "example.com",
    "example.com.",
    "EXAMPLE.COM",
  ])("refuses %s", (host) => {
    expect(isFederatedHostRefused(host, "example.com")).toBe(true);
  });

  it.each([
    "peer.example",
    "peer.example.",
    "100.63.255.255",
    "100.128.0.1",
    "172.32.0.1",
    "8.8.8.8",
  ])("admits %s", (host) => {
    expect(isFederatedHostRefused(host, "example.com")).toBe(false);
  });

  it("refuses this instance's own host when its domain carries a port", () => {
    expect(isFederatedHostRefused("peer.example", "peer.example:8443")).toBe(true);
  });

  it("admits a loopback host the allow list names, with or without a trailing dot", () => {
    const allowHosts = new Set(["127.0.0.1"]);
    expect(isFederatedHostRefused("127.0.0.1", "127.0.0.1:8792", { allowHosts })).toBe(false);
    expect(isFederatedHostRefused("127.0.0.1.", "127.0.0.1:8792", { allowHosts })).toBe(false);
  });
});

describe("parseFederatedUrl", () => {
  it("accepts http(s) urls and strips hashes", () => {
    const parsed = parseFederatedUrl("https://peer.example/users/alice#frag");
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value.href).toBe("https://peer.example/users/alice");
    }
  });

  it("rejects non-http schemes and invalid urls", () => {
    expect(parseFederatedUrl("ftp://peer.example/x").isErr()).toBe(true);
    expect(parseFederatedUrl("not a url").isErr()).toBe(true);
  });
});

describe("webfingerScheme", () => {
  it("uses plain HTTP only for an allow-listed loopback host", () => {
    expect(webfingerScheme("peer.example")).toBe("https");
    expect(webfingerScheme("peer.example", new Set(["peer.example"]))).toBe("https");
    expect(webfingerScheme("127.0.0.1")).toBe("https");
    expect(webfingerScheme("127.0.0.1", new Set(["127.0.0.1"]))).toBe("http");
    expect(webfingerScheme("LOCALHOST", new Set(["localhost"]))).toBe("http");
  });
});
