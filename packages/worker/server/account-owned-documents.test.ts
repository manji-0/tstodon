import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";

/**
 * What an ActivityPub fetch of a local account's documents gets once the
 * account is suspended or deleted, as Mastodon's `AccountOwnedConcern`
 * (`check_account_suspension`): 403 while the suspension can be undone, 410
 * once the account is gone for good, both cached for 3 minutes. The actor
 * itself is still served while suspended (with `suspended: true`).
 */

const ORIGIN = "https://example.com";
const AP_ACCEPT = "application/activity+json";

const fetchAs = (path: string) =>
  SELF.fetch(new URL(path, ORIGIN), { headers: { Accept: AP_ACCEPT } });

const post = async (email: string, status: string) => {
  const response = await SELF.fetch(new URL("/api/v1/statuses", ORIGIN), {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ status }),
  });
  expect(response.status).toBe(200);
  return expectContract(ApiStatus, await response.json());
};

const ownedPaths = (username: string, statusId: string): ReadonlyArray<string> => {
  const user = `/users/${username}`;
  return [
    `${user}/outbox`,
    `${user}/outbox?page=true`,
    `${user}/followers`,
    `${user}/followers?page=1`,
    `${user}/following`,
    `${user}/following?page=1`,
    `${user}/collections/featured`,
    `${user}/collections/tags`,
    `${user}/statuses/${statusId}`,
    `${user}/statuses/${statusId}/replies`,
    `${user}/statuses/${statusId}/replies?page=true`,
    `${user}/quote_authorizations/1`,
  ];
};

describe("an ActivityPub fetch of a suspended or deleted account's documents", () => {
  it("is refused while the account is suspended, signed or not", async () => {
    const email = "owned-suspended@example.com";
    const account = await signedInAccount(email);
    const status = await post(email, "before the suspension");
    const reader = await remoteActor("owned-suspended-reader", "owned-suspended.example");
    await env.DB.prepare(
      "INSERT INTO account_moderation (account_id, moderation) VALUES (?, 'Suspended')",
    )
      .bind(account.id)
      .run();

    for (const path of ownedPaths(account.username, status.id)) {
      for (const response of [await fetchAs(path), await reader.fetch(path)]) {
        expect(response.status, path).toBe(403);
        expect(response.headers.get("Cache-Control"), path).toBe("max-age=180, public");
        expect(await response.text(), path).not.toContain("before the suspension");
      }
    }

    const actor = await fetchAs(`/users/${account.username}`);
    expect(actor.status).toBe(200);
    expect(z.object({ suspended: z.literal(true) }).safeParse(await actor.json()).success).toBe(
      true,
    );
  });

  it("is gone for good once the account is deleted", async () => {
    const email = "owned-deleted@example.com";
    const account = await signedInAccount(email);
    const status = await post(email, "before the deletion");
    const deleted = await SELF.fetch(new URL(`/api/v1/admin/accounts/${account.id}`, ORIGIN), {
      method: "DELETE",
      headers: await authHeaders("owned-deleted-admin@example.com", { admin: true }),
    });
    expect(deleted.status).toBe(200);

    for (const path of ownedPaths(account.username, status.id)) {
      const response = await fetchAs(path);
      expect(response.status, path).toBe(410);
      expect(response.headers.get("Cache-Control"), path).toBe("max-age=180, public");
    }
    for (const path of ownedPaths("owned_never_existed", status.id)) {
      expect((await fetchAs(path)).status, path).toBe(404);
    }
  });
});
