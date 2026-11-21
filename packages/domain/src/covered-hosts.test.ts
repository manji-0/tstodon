import { describe, expect, it } from "vite-plus/test";
import { CoveredHosts } from "./covered-hosts";
import { Hostname } from "./hostname";

const host = Hostname.ofAuthority;

type Rule = Readonly<{ domain: Hostname; severity: "silence" | "suspend" | "noop" }>;

const rule = (domain: string, severity: Rule["severity"]): Rule => ({
  domain: host(domain),
  severity,
});

const suspended = (rules: ReadonlyArray<Rule>): CoveredHosts =>
  CoveredHosts.of(rules, (r) => r.severity === "suspend");

describe("Hostname.variants", () => {
  it("lists the host and each parent domain, most specific first, as domain_variants", () => {
    expect(Hostname.variants(host("a.b.example.com"))).toEqual([
      "a.b.example.com",
      "b.example.com",
      "example.com",
      "com",
    ]);
    expect(Hostname.variants(host("localhost"))).toEqual(["localhost"]);
  });
});

describe("CoveredHosts", () => {
  it("covers the named domain and every subdomain of it", () => {
    const covered = suspended([rule("example.com", "suspend")]);

    expect(CoveredHosts.covers(covered, host("example.com"))).toBe(true);
    expect(CoveredHosts.covers(covered, host("social.example.com"))).toBe(true);
    expect(CoveredHosts.covers(covered, host("a.social.example.com"))).toBe(true);
  });

  it("does not cover a host that only ends with the same letters", () => {
    const covered = suspended([rule("example.com", "suspend")]);

    expect(CoveredHosts.covers(covered, host("badexample.com"))).toBe(false);
    expect(CoveredHosts.covers(covered, host("example.com.evil"))).toBe(false);
    expect(CoveredHosts.covers(covered, host("com"))).toBe(false);
  });

  it("lets the most specific rule decide, as DomainBlock.rule_for", () => {
    const covered = suspended([
      rule("example.com", "suspend"),
      rule("open.example.com", "noop"),
      rule("closed.open.example.com", "suspend"),
    ]);

    expect(CoveredHosts.covers(covered, host("other.example.com"))).toBe(true);
    expect(CoveredHosts.covers(covered, host("open.example.com"))).toBe(false);
    expect(CoveredHosts.covers(covered, host("a.open.example.com"))).toBe(false);
    expect(CoveredHosts.covers(covered, host("closed.open.example.com"))).toBe(true);
    expect(CoveredHosts.covers(covered, host("x.closed.open.example.com"))).toBe(true);
  });

  it("lets a more specific suspension apply under a lighter parent rule", () => {
    const covered = suspended([rule("example.com", "silence"), rule("bad.example.com", "suspend")]);

    expect(CoveredHosts.covers(covered, host("example.com"))).toBe(false);
    expect(CoveredHosts.covers(covered, host("bad.example.com"))).toBe(true);
    expect(CoveredHosts.covers(covered, host("a.bad.example.com"))).toBe(true);
  });

  it("covers nothing when there are no rules", () => {
    expect(CoveredHosts.covers(CoveredHosts.none, host("example.com"))).toBe(false);
  });
});
