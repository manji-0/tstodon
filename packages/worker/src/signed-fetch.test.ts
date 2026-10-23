import { schemaResult } from "@tstodon/core";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { remoteActor } from "../test/remote-actor-fixture";

const json = async (path: string, init?: RequestInit) => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  return { status: response.status, body: await response.json() };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const account = async (email: string) =>
  read(
    z.object({ id: z.string(), username: z.string() }),
    (
      await json("/api/v1/accounts/verify_credentials", {
        headers: await accessAuthHeaders(email),
      })
    ).body,
  );

/** The note's object path, from a status posted by `email`. */
const post = async (email: string, status: string, visibility: string): Promise<string> => {
  const created = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await accessAuthHeaders(email)) },
    body: JSON.stringify({ status, visibility }),
  });
  expect(created.status).toBe(200);
  return new URL(read(z.object({ uri: z.string() }), created.body).uri).pathname;
};

const follow = async (actorUri: string, accountId: string, id: string) => {
  await env.DB.prepare(
    `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind, created_at)
     VALUES (?, ?, ?, 'Fulfilled', 'Accepted', '2026-10-21T00:00:00.000Z')`,
  )
    .bind(id, actorUri, accountId)
    .run();
};

describe("authorized fetch of non-public notes", () => {
  it("serves a followers-only note to a signed fetch from an accepted follower", async () => {
    const email = "signed-fetch-private@example.com";
    const author = await account(email);
    const follower = await remoteActor("signed-fetch-follower");
    const stranger = await remoteActor("signed-fetch-stranger");
    await follow(follower.actorUri, author.id, "signed-fetch-follow");
    const path = await post(email, "followers only", "private");

    const allowed = await follower.fetch(path);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("private");
    expect(read(z.object({ type: z.literal("Note") }), await allowed.json()).type).toBe("Note");

    expect((await stranger.fetch(path)).status).toBe(404);
    expect((await SELF.fetch(`https://example.com${path}`)).status).toBe(404);
  });

  it("serves a direct note only to the actors it addresses", async () => {
    const email = "signed-fetch-direct@example.com";
    const author = await account(email);
    const recipient = await remoteActor("signed-fetch-recipient");
    const follower = await remoteActor("signed-fetch-direct-follower");
    await follow(follower.actorUri, author.id, "signed-fetch-direct-follow");
    const path = await post(email, "@signed-fetch-recipient@remote.example psst", "direct");

    expect((await recipient.fetch(path)).status).toBe(200);
    // Following the author does not open a direct note.
    expect((await follower.fetch(path)).status).toBe(404);
  });
});
