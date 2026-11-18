/**
 * The hosts allowed to federate (limited federation), remembering which of
 * them the operator named in `FEDERATION_ALLOW_HOSTS`. Every host here may
 * federate; only the operator's skip the private-address and DNS checks, so
 * a local test server can be reached while a domain an admin allowed at
 * runtime (`domain_allows`) is still checked like any other.
 */
export class FederationAllowHosts extends Set<string> {
  readonly operatorHosts: ReadonlySet<string>;

  constructor(operatorHosts: ReadonlySet<string>, storedHosts: Iterable<string> = []) {
    super([...operatorHosts, ...storedHosts]);
    this.operatorHosts = operatorHosts;
  }
}

/**
 * The hosts a federated request may reach without the private-address and
 * DNS checks: the operator's, when `allowHosts` says which they are, or every
 * host of a plain set.
 */
export const hostsExemptFromAddressChecks = (
  allowHosts: ReadonlySet<string> = new Set(),
): ReadonlySet<string> =>
  allowHosts instanceof FederationAllowHosts ? allowHosts.operatorHosts : allowHosts;
