import { describe, expect, it } from "vite-plus/test";
import { Hostname } from "./hostname";

describe("Hostname", () => {
  it("drops an authority's port and folds the case", () => {
    expect(Hostname.ofAuthority("Peer.Test:8792")).toBe("peer.test");
    expect(Hostname.ofAuthority("peer.test")).toBe("peer.test");
    expect(Hostname.ofAuthority("[::1]:8792")).toBe("[::1]");
  });

  it("reads a typed domain without scheme, path, leading @ or port", () => {
    expect(Hostname.fromInput(" https://Peer.Test:8792/path ")).toBe("peer.test");
    expect(Hostname.fromInput("@Peer.Test")).toBe("peer.test");
    expect(Hostname.fromInput("  ")).toBeUndefined();
    expect(Hostname.fromInput("https://")).toBeUndefined();
  });

  it("takes a URI's host without its port", () => {
    expect(Hostname.ofUri("https://Peer.Test:8792/users/bob")).toBe("peer.test");
    expect(Hostname.ofUri("not a uri")).toBeUndefined();
  });
});
