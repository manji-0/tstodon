import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiDomainBlockPreview } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

// Mastodon v4.7.5's `Api::V1::DomainBlocks::PreviewsController`.

const preview = async (email: string | undefined, domain: string, scopes?: string[]) => {
  const response = await SELF.fetch(
    `https://example.com/api/v1/domain_blocks/preview?domain=${encodeURIComponent(domain)}`,
    {
      headers:
        email === undefined ? {} : await authHeaders(email, scopes === undefined ? {} : { scopes }),
    },
  );
  return { status: response.status, body: await response.json() };
};

/** `email` follows `remote`; with `accepted` the remote accepts. */
const follow = async (email: string, remote: Remote, accepted: boolean): Promise<void> => {
  const response = await SELF.fetch(
    `https://example.com/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/follow`,
    { method: "POST", headers: await authHeaders(email) },
  );
  expect(response.status).toBe(200);
  if (!accepted) {
    return;
  }
  const account = await signedInAccount(email);
  const row = await env.DB.prepare(
    "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
  )
    .bind(account.id, remote.actorUri)
    .first();
  const followId = z.object({ follow_activity_id: z.string() }).parse(row).follow_activity_id;
  expect(
    await remote.send({ id: `${remote.actorUri}/accepts/1`, type: "Accept", object: followId }),
  ).toBe(202);
};

/** `remote` follows `email`. */
const followedBy = async (remote: Remote, email: string): Promise<void> => {
  const account = await signedInAccount(email);
  expect(
    await remote.send({
      id: `${remote.actorUri}/follows/1`,
      type: "Follow",
      object: `https://example.com/users/${account.username}`,
    }),
  ).toBe(202);
};

describe("GET /api/v1/domain_blocks/preview", () => {
  it("counts the accepted follows each way with the domain's actors", async () => {
    const email = "block-preview@example.com";
    const [ann, bea, cyd, other] = await Promise.all([
      remoteActor("ann", "preview.example"),
      remoteActor("bea", "preview.example"),
      remoteActor("cyd", "preview.example"),
      remoteActor("dee", "elsewhere.example"),
    ]);
    await follow(email, ann, true);
    await follow(email, bea, true);
    // A request the domain has not accepted is not a follow yet.
    await follow(email, cyd, false);
    await follow(email, other, true);
    await followedBy(ann, email);
    await followedBy(other, email);

    const counted = await preview(email, "preview.example");
    expect(counted.status).toBe(200);
    expect(expectContract(ApiDomainBlockPreview, counted.body)).toEqual({
      following_count: 2,
      followers_count: 1,
    });
    // The domain is normalized, as Mastodon's `TagManager#normalize_domain`.
    expect((await preview(email, "Preview.Example")).body).toEqual({
      following_count: 2,
      followers_count: 1,
    });
    expect((await preview(email, "unknown.example")).body).toEqual({
      following_count: 0,
      followers_count: 0,
    });
  });

  it("takes write:blocks, follow or write, as Mastodon", async () => {
    const email = "block-preview-scope@example.com";
    expect((await preview(undefined, "preview.example")).status).toBe(401);
    expect((await preview(email, "preview.example", ["read:blocks"])).status).toBe(403);
    expect((await preview(email, "preview.example", ["read"])).status).toBe(403);
    for (const scopes of [["write:blocks"], ["follow"], ["write"]]) {
      expect((await preview(email, "preview.example", scopes)).status).toBe(200);
    }
  });
});
