/** What the Mastodon interop scripts share: the Mastodon origin and its provisioned users. */
import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { api, fail, type E2eUser } from "../lib.js";

export const MASTODON = process.env["E2E_MASTODON_ORIGIN"] ?? "https://mastodon.test";
export const MASTODON_DOMAIN = process.env["E2E_MASTODON_DOMAIN"] ?? "mastodon.test";

const MastodonAccount = schemaResult(
  z.looseObject({ id: z.string(), username: z.string(), uri: z.string() }),
);

/**
 * A user `bootstrap.sh` provisioned on Mastodon, by its token in
 * `E2E_MASTODON_TOKEN_<NAME>`. The actor URI comes from Mastodon: since 4.5 a
 * new account's is `/ap/users/<id>`, not `/users/<name>`.
 */
export const mastodonUser = async (name: string): Promise<E2eUser> => {
  const token = process.env[`E2E_MASTODON_TOKEN_${name.toUpperCase()}`];
  if (!token) {
    return fail(`no token for ${name}: run e2e/mastodon/bootstrap.sh and load .state/e2e.env`);
  }
  const headers = { Authorization: `Bearer ${token}` };
  const account = await api(
    MASTODON,
    headers,
    "/api/v1/accounts/verify_credentials",
    MastodonAccount,
    `${name} on Mastodon`,
  );
  return {
    origin: MASTODON,
    headers,
    browser: () => fail("no browser session for a Mastodon user"),
    id: account.id,
    username: account.username,
    acct: `@${account.username}@${MASTODON_DOMAIN}`,
    uri: account.uri,
  };
};
