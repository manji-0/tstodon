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

  it("reads an internationalized domain as its ASCII form, as TagManager#normalize_domain", () => {
    expect(Hostname.fromInput("Bücher.Example")).toBe("xn--bcher-kva.example");
    expect(Hostname.fromInput("https://bücher.example/about")).toBe("xn--bcher-kva.example");
    expect(Hostname.fromInput("123")).toBe("123");
  });

  it("names a domain Mastodon's DomainValidator accepts", () => {
    expect(Hostname.isValidDomain(Hostname.ofAuthority("xn--bcher-kva.example"))).toBe(true);
    expect(Hostname.isValidDomain(Hostname.ofAuthority("a-b.example"))).toBe(true);
    expect(Hostname.isValidDomain(Hostname.ofAuthority("foo bar"))).toBe(false);
    expect(Hostname.isValidDomain(Hostname.ofAuthority("under_score.example"))).toBe(false);
    expect(Hostname.isValidDomain(Hostname.ofAuthority("empty..label"))).toBe(false);
    expect(Hostname.isValidDomain(Hostname.ofAuthority(`${"a".repeat(64)}.example`))).toBe(false);
  });

  it("takes a URI's host without its port", () => {
    expect(Hostname.ofUri("https://Peer.Test:8792/users/bob")).toBe("peer.test");
    expect(Hostname.ofUri("not a uri")).toBeUndefined();
  });

  it("names a fully qualified domain without its trailing dot", () => {
    expect(Hostname.ofAuthority("Dot.Example.:8792")).toBe("dot.example");
    expect(Hostname.fromInput("dot.example.")).toBe("dot.example");
    expect(Hostname.ofUri("https://dot.example./users/d")).toBe("dot.example");
  });
});
