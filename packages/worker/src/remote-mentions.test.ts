import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { deliveredCreate } from "../test/delivery-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

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

const me = async (email: string) =>
  read(
    z.object({ id: z.string(), username: z.string() }),
    (await json("/api/v1/accounts/verify_credentials", { headers: await accessAuthHeaders(email) }))
      .body,
  );

const MentionSchema = z.object({ id: z.string(), username: z.string(), acct: z.string() });

const post = async (email: string, status: string, visibility: string) =>
  read(
    z.object({ id: z.string(), uri: z.string(), mentions: z.array(MentionSchema) }),
    (
      await json("/api/v1/statuses", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await accessAuthHeaders(email)) },
        body: JSON.stringify({ status, visibility }),
      })
    ).body,
  );

describe("mentions of remote accounts in local notes", () => {
  it("addresses a direct note to the mentioned remote account only", async () => {
    const email = "remote-mention-author@example.com";
    const account = await me(email);
    const bob = await remoteActor("mention-bob");
    const follower = await remoteActor("mention-follower");
    await env.DB.prepare(
      `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind, created_at)
       VALUES ('remote-mention-follow', ?, ?, 'Fulfilled', 'Accepted', '2026-10-21T00:00:00.000Z')`,
    )
      .bind(follower.actorUri, account.id)
      .run();
    const local = await me("remote-mention-local@example.com");

    const direct = await post(
      email,
      `@mention-bob@remote.example and @${local.username}@example.com, privately`,
      "direct",
    );
    // Both mentions render: the own-domain handle as the local account.
    expect(direct.mentions.map((mention) => mention.acct).toSorted()).toEqual(
      ["mention-bob@remote.example", local.username].toSorted(),
    );
    expect(
      direct.mentions.find((mention) => mention.acct === "mention-bob@remote.example")?.id,
    ).toBe(RemoteAccountId.encode(bob.actorUri));

    const delivered = await deliveredCreate(account.id, direct.uri);
    expect(delivered?.activity.object.to.toSorted()).toEqual(
      [bob.actorUri, `https://example.com/users/${local.username}`].toSorted(),
    );
    expect(delivered?.activity.object.cc).toEqual([]);
    expect(delivered?.activity.object.tag.map((tag) => tag.href).toSorted()).toEqual(
      [bob.actorUri, `https://example.com/users/${local.username}`].toSorted(),
    );
    // Only bob's inbox: not the follower's, and nothing for the local account.
    expect(delivered?.inboxes).toEqual([`${bob.actorUri}/inbox`]);

    // The remote account is a participant of the author's conversation.
    const conversations = read(
      z.array(z.object({ id: z.string(), accounts: z.array(z.object({ id: z.string() })) })),
      (await json("/api/v1/conversations", { headers: await accessAuthHeaders(email) })).body,
    );
    expect(
      conversations
        .find((conversation) => conversation.id === direct.id)
        ?.accounts.map((entry) => entry.id)
        .toSorted(),
    ).toEqual([RemoteAccountId.encode(bob.actorUri), local.id].toSorted());
  });

  it("adds mentioned remote accounts to a public note's followers delivery", async () => {
    const email = "remote-mention-public@example.com";
    const account = await me(email);
    const carol = await remoteActor("mention-carol");
    const follower = await remoteActor("mention-public-follower");
    await env.DB.prepare(
      `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind, created_at)
       VALUES ('remote-mention-public-follow', ?, ?, 'Fulfilled', 'Accepted', '2026-10-21T00:00:00.000Z')`,
    )
      .bind(follower.actorUri, account.id)
      .run();

    const note = await post(email, "hello @mention-carol@remote.example", "public");
    const delivered = await deliveredCreate(account.id, note.uri);
    expect(delivered?.activity.object.to).toEqual(["https://www.w3.org/ns/activitystreams#Public"]);
    expect(delivered?.activity.object.cc).toEqual([
      `https://example.com/users/${account.username}/followers`,
      carol.actorUri,
    ]);
    expect(delivered?.inboxes).toEqual(
      [`${carol.actorUri}/inbox`, `${follower.actorUri}/inbox`].toSorted(),
    );
  });

  it("posts a direct note whose remote handle does not resolve, keeping it home", async () => {
    const email = "remote-mention-unresolved@example.com";
    const account = await me(email);
    const note = await post(email, "@nobody@unresolvable.invalid hello", "direct");
    expect(note.mentions).toEqual([]);
    expect(await deliveredCreate(account.id, note.uri)).toBeUndefined();
  });
});
