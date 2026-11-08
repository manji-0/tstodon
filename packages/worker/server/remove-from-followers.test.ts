import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { MastodonAccountPreviewSchema } from "../test/mastodon-preview-schemas";

const auth = (email: string): Promise<Record<string, string>> => authHeaders(email);

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const RelationshipSchema = z.object({
  id: z.string().min(1),
  following: z.boolean(),
  followed_by: z.boolean(),
});

const accountIdFor = async (email: string): Promise<string> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  return read(MastodonAccountPreviewSchema, response.body).id;
};

const follow = async (email: string, targetId: string): Promise<void> => {
  const response = await json(`/api/v1/accounts/${targetId}/follow`, {
    method: "POST",
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
};

describe("remove from followers", () => {
  it("drops a follower without touching the viewer's own follow", async () => {
    const viewerEmail = "remove-viewer@example.com";
    const followerEmail = "remove-follower@example.com";
    const viewerId = await accountIdFor(viewerEmail);
    const followerId = await accountIdFor(followerEmail);

    await follow(followerEmail, viewerId);
    await follow(viewerEmail, followerId);

    const followers = await json(`/api/v1/accounts/${viewerId}/followers`);
    expect(followers.status).toBe(200);
    expect(read(z.array(MastodonAccountPreviewSchema), followers.body).map((a) => a.id)).toContain(
      followerId,
    );

    const removed = await json(`/api/v1/accounts/${followerId}/remove_from_followers`, {
      method: "POST",
      headers: await auth(viewerEmail),
    });
    expect(removed.status).toBe(200);
    const relationship = read(RelationshipSchema, removed.body);
    expect(relationship.followed_by).toBe(false);
    expect(relationship.following).toBe(true);

    const after = await json(`/api/v1/accounts/${viewerId}/followers`);
    expect(read(z.array(MastodonAccountPreviewSchema), after.body).map((a) => a.id)).not.toContain(
      followerId,
    );
  });

  it("requires auth and 404s for unknown targets", async () => {
    expect(
      (await json("/api/v1/accounts/whatever/remove_from_followers", { method: "POST" })).status,
    ).toBe(401);
    const missing = await json("/api/v1/accounts/nope/remove_from_followers", {
      method: "POST",
      headers: await auth("remove-missing@example.com"),
    });
    expect(missing.status).toBe(404);
  });
});
