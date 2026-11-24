import type { Hostname } from "@tstodon/domain";

/**
 * The `remote_actors.host_key` / `uri_host_key` range of the hosts at or
 * under `domain`, Mastodon's `by_domain_and_subdomains`: a key is the host's
 * labels in reverse order, each followed by a dot (the `host_keys` view), so the hosts under `example.com` are the keys from
 * `com.example.` up to `com.example/`.
 */
export const hostKeyRange = (domain: Hostname): Readonly<{ from: string; to: string }> => {
  const reversed = domain.split(".").reverse().join(".");
  return { from: `${reversed}.`, to: `${reversed}/` };
};
