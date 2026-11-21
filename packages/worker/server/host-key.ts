import type { Hostname } from "@tstodon/domain";

/**
 * The `remote_actors.host_key` / `uri_host_key` range of the hosts at or
 * under `domain`, Mastodon's `by_domain_and_subdomains`: a key is the host
 * spelled backwards with a trailing dot (migration 0163), so the hosts under
 * `example.com` are the keys from `moc.elpmaxe.` up to `moc.elpmaxe/`.
 */
export const hostKeyRange = (domain: Hostname): Readonly<{ from: string; to: string }> => {
  // By code point, as the migration's `substr` reverses it.
  const reversed = Array.from(domain).reverse().join("");
  return { from: `${reversed}.`, to: `${reversed}/` };
};
