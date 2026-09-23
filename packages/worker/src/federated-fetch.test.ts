import { describe, expect, it } from "vitest";
import { isBlockedFederatedHost } from "./federated-fetch";

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
});
