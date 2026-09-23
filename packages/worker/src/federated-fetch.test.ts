import { describe, expect, it } from "vitest";
import { isBlockedFederatedHost, parseFederatedUrl } from "./federated-fetch";

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
