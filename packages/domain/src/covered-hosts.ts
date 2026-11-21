import { Hostname } from "./hostname";

/**
 * The hosts one kind of instance domain rule (a suspension, `reject_media`,
 * `reject_reports`) applies to. A rule names a domain and covers its
 * subdomains, and a host follows its most specific rule only, as Mastodon's
 * `DomainBlock.rule_for`: under a suspension of `example.com`, a `noop` on
 * `open.example.com` exempts that host and its subdomains. `byDomain` holds
 * every rule's domain with whether its rule applies.
 */
export type CoveredHosts = Readonly<{
  kind: "CoveredHosts";
  byDomain: ReadonlyMap<Hostname, boolean>;
}>;

export const CoveredHosts = {
  none: { kind: "CoveredHosts", byDomain: new Map() } as const satisfies CoveredHosts,
  /** The hosts covered by `rules` whose rule `applies`. */
  of: <R extends Readonly<{ domain: Hostname }>>(
    rules: Iterable<R>,
    applies: (rule: R) => boolean,
  ): CoveredHosts => ({
    kind: "CoveredHosts",
    byDomain: new Map([...rules].map((rule) => [rule.domain, applies(rule)])),
  }),
  covers: (covered: CoveredHosts, host: Hostname): boolean => {
    for (const variant of Hostname.variants(host)) {
      const applies = covered.byDomain.get(variant);
      if (applies !== undefined) {
        return applies;
      }
    }
    return false;
  },
} as const;
