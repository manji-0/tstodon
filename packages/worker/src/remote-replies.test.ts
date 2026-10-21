import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { deliveredCreate } from "../test/delivery-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
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

const StatusSchema = z.object({
  id: z.string(),
  uri: z.string(),
  content: z.string(),
  in_reply_to_id: z.string().nullable(),
  in_reply_to_account_id: z.string().nullable(),
});

const reply = async (email: string, status: string, visibility: string, inReplyToId: string) =>
  json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await accessAuthHeaders(email)) },
    body: JSON.stringify({ status, visibility, in_reply_to_id: inReplyToId }),
  });

/** Deliver a remote note and return its cached status id, as the addressed account sees it. */
const receive = async (
  remote: Remote,
  slug: string,
  audience: Readonly<{ to: string[]; cc?: string[] }>,
  viewerEmail: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; objectUri: string }> => {
  const objectUri = `https://remote.example/notes/${slug}`;
  expect(
    await remote.send({
      id: `https://remote.example/activities/create-${slug}`,
      type: "Create",
      object: {
        id: objectUri,
        type: "Note",
        attributedTo: remote.actorUri,
        content: `<p>${slug}</p>`,
        published: "2026-10-20T00:00:00.000Z",
        ...audience,
        tag: audience.to
          .filter((uri) => uri.startsWith("https://example.com/users/"))
          .map((href) => ({ type: "Mention", href })),
        ...extra,
      },
    }),
  ).toBe(202);
  const { results } = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
    .bind(objectUri)
    .all<{ id: string }>();
  const id = results?.[0]?.id;
  if (!id) {
    throw new Error(`remote note ${slug} was not stored`);
  }
  expect(
    (await json(`/api/v1/statuses/${id}`, { headers: await accessAuthHeaders(viewerEmail) }))
      .status,
  ).toBe(200);
  return { id, objectUri };
};

describe("replies to remote statuses", () => {
  it("answers a remote direct message in its conversation and delivers to the sender", async () => {
    const email = "remote-reply-dm@example.com";
    const account = await me(email);
    const actorUrl = `https://example.com/users/${account.username}`;
    const bob = await remoteActor("reply-bob");
    const incoming = await receive(bob, "reply-dm-1", { to: [actorUrl] }, email);

    const answered = await reply(email, "@reply-bob@remote.example thanks!", "direct", incoming.id);
    expect(answered.status).toBe(200);
    const status = read(StatusSchema, answered.body);
    expect(status.in_reply_to_id).toBe(incoming.id);
    expect(status.in_reply_to_account_id).toBe(RemoteAccountId.encode(bob.actorUri));

    const delivered = await deliveredCreate(account.id, status.uri);
    expect(delivered?.activity.object.inReplyTo).toBe(incoming.objectUri);
    expect(delivered?.activity.object.to).toEqual([bob.actorUri]);
    expect(delivered?.inboxes).toEqual([`${bob.actorUri}/inbox`]);

    // One conversation, rooted at the remote message, ending with the reply.
    const conversations = read(
      z.array(
        z.object({
          id: z.string(),
          accounts: z.array(z.object({ id: z.string() })),
          last_status: z.object({ id: z.string() }).nullable(),
        }),
      ),
      (await json("/api/v1/conversations", { headers: await accessAuthHeaders(email) })).body,
    );
    expect(conversations.map((conversation) => conversation.id)).toEqual([incoming.id]);
    expect(conversations[0]?.last_status?.id).toBe(status.id);
    expect(conversations[0]?.accounts.map((entry) => entry.id)).toEqual([
      RemoteAccountId.encode(bob.actorUri),
    ]);

    // Bob answers the reply: the thread stays one conversation.
    const followUp = await receive(bob, "reply-dm-2", { to: [actorUrl] }, email, {
      inReplyTo: status.uri,
    });
    const continued = read(
      z.array(z.object({ id: z.string(), last_status: z.object({ id: z.string() }).nullable() })),
      (await json("/api/v1/conversations", { headers: await accessAuthHeaders(email) })).body,
    );
    expect(continued.map((conversation) => conversation.id)).toEqual([incoming.id]);
    expect(continued[0]?.last_status?.id).toBe(followUp.id);

    // Reading it back keeps the remote parent.
    const fetched = read(
      StatusSchema,
      (await json(`/api/v1/statuses/${status.id}`, { headers: await accessAuthHeaders(email) }))
        .body,
    );
    expect(fetched.in_reply_to_id).toBe(incoming.id);
  });

  it("addresses a public reply to the remote author, and federates local parents too", async () => {
    const email = "remote-reply-public@example.com";
    const account = await me(email);
    const carol = await remoteActor("reply-carol");
    const incoming = await receive(
      carol,
      "reply-public-1",
      { to: ["https://www.w3.org/ns/activitystreams#Public"] },
      email,
    );

    const answered = read(
      StatusSchema,
      (await reply(email, "nice post", "public", incoming.id)).body,
    );
    const delivered = await deliveredCreate(account.id, answered.uri);
    expect(delivered?.activity.object.inReplyTo).toBe(incoming.objectUri);
    expect(delivered?.activity.object.cc).toEqual([
      `https://example.com/users/${account.username}/followers`,
      carol.actorUri,
    ]);
    expect(delivered?.inboxes).toEqual([`${carol.actorUri}/inbox`]);

    // The note object names its parent, local or remote.
    const local = read(
      StatusSchema,
      (await reply(email, "following up on myself", "public", answered.id)).body,
    );
    const object = read(
      z.object({ inReplyTo: z.string().nullable() }),
      (await json(new URL(local.uri).pathname)).body,
    );
    expect(object.inReplyTo).toBe(answered.uri);
    const remoteObject = read(
      z.object({ inReplyTo: z.string().nullable() }),
      (await json(new URL(answered.uri).pathname)).body,
    );
    expect(remoteObject.inReplyTo).toBe(incoming.objectUri);
  });

  it("stops walking a reply chain that loops back on itself", async () => {
    const email = "remote-reply-loop@example.com";
    const account = await me(email);
    const actorUrl = `https://example.com/users/${account.username}`;
    const eve = await remoteActor("reply-eve");
    const incoming = await receive(eve, "reply-loop-1", { to: [actorUrl] }, email);
    const answered = read(
      StatusSchema,
      (await reply(email, "@reply-eve@remote.example loop?", "direct", incoming.id)).body,
    );
    // A remote note claiming to answer the local reply that answers it.
    await env.DB.prepare("UPDATE remote_statuses SET in_reply_to_uri = ? WHERE id = ?")
      .bind(answered.uri, incoming.id)
      .run();
    const listed = await json("/api/v1/conversations", {
      headers: await accessAuthHeaders(email),
    });
    // The shared step budget ends the walk; where a forged loop is cut may
    // differ by starting note, so only termination is asserted.
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.body) && listed.body.length).toBeGreaterThan(0);
  });

  it("refuses to answer a remote direct message addressed to someone else", async () => {
    const recipient = "remote-reply-addressee@example.com";
    const recipientAccount = await me(recipient);
    const dave = await remoteActor("reply-dave");
    const incoming = await receive(
      dave,
      "reply-private-1",
      { to: [`https://example.com/users/${recipientAccount.username}`] },
      recipient,
    );
    expect(
      (await reply("remote-reply-outsider@example.com", "hi", "direct", incoming.id)).status,
    ).toBe(404);
  });
});
