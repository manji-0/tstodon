import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const featuredTags = async (accountId: string) => {
  const response = await SELF.fetch(
    `https://example.com/api/v1/accounts/${accountId}/featured_tags`,
    { headers: await authHeaders("featured-tags-viewer@example.com") },
  );
  return { status: response.status, body: await response.json() };
};

describe("GET /api/v1/accounts/:id/featured_tags for a remote account", () => {
  it("answers an empty list for a known remote account, which keeps none", async () => {
    const remote = await remoteActor("featured-tags-remote");
    expect(await featuredTags(RemoteAccountId.encode(remote.actorUri))).toEqual({
      status: 200,
      body: [],
    });
  });

  it("answers 404 for a remote account this server does not know", async () => {
    const unknown = RemoteAccountId.encode("https://remote.example/users/featured-tags-unknown");
    expect((await featuredTags(unknown)).status).toBe(404);
  });
});
