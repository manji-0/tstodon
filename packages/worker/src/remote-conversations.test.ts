import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
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

const ConversationSchema = z.object({
  id: z.string(),
  unread: z.boolean(),
  accounts: z.array(z.object({ id: z.string() })),
  last_status: z.object({ id: z.string(), content: z.string() }).nullable(),
});

const conversations = async (email: string) =>
  read(
    z.array(ConversationSchema),
    (await json("/api/v1/conversations", { headers: await accessAuthHeaders(email) })).body,
  );

const directTimeline = async (email: string) =>
  read(
    z.array(z.object({ id: z.string(), content: z.string() })),
    (await json("/api/v1/timelines/direct", { headers: await accessAuthHeaders(email) })).body,
  );

/** Id of the status in the account's direct timeline whose content includes the text. */
const remoteStatusId = async (email: string, content: string): Promise<string> => {
  const listed = await directTimeline(email);
  const match = listed.find((status) => status.content.includes(content));
  if (!match) {
    throw new Error(`no direct status with ${content}`);
  }
  return match.id;
};

const sendDirect = async (
  remote: Remote,
  slug: string,
  to: string,
  extra: Record<string, unknown> = {},
): Promise<string> => {
  const origin = new URL(remote.actorUri).origin;
  const objectUri = `${origin}/notes/${slug}`;
  expect(
    await remote.send({
      id: `${origin}/activities/create-${slug}`,
      type: "Create",
      object: {
        id: objectUri,
        type: "Note",
        attributedTo: remote.actorUri,
        content: `<p>${slug}</p>`,
        published: "2026-10-20T00:00:00.000Z",
        to: [to],
        tag: [{ type: "Mention", href: to }],
        ...extra,
      },
    }),
  ).toBe(202);
  return objectUri;
};

describe("remote direct messages", () => {
  it("land in the direct timeline and one conversation per thread", async () => {
    const email = "remote-dm-recipient@example.com";
    const account = await me(email);
    const actorUrl = `https://example.com/users/${account.username}`;
    const remote = await remoteActor("dm-sender");
    const first = await sendDirect(remote, "dm-thread-1", actorUrl);
    await sendDirect(remote, "dm-thread-2", actorUrl, { inReplyTo: first });
    await sendDirect(remote, "dm-other", actorUrl);

    const timeline = await directTimeline(email);
    expect(timeline.map((status) => status.content)).toEqual([
      "<p>dm-other</p>",
      "<p>dm-thread-2</p>",
      "<p>dm-thread-1</p>",
    ]);

    const listed = await conversations(email);
    expect(listed).toHaveLength(2);
    const rootId = await remoteStatusId(email, "dm-thread-1");
    const thread = listed.find((conversation) => conversation.id === rootId);
    expect(thread?.unread).toBe(true);
    expect(thread?.last_status?.content).toBe("<p>dm-thread-2</p>");
    expect(thread?.accounts.map((entry) => entry.id)).toEqual([
      RemoteAccountId.encode(remote.actorUri),
    ]);

    // The addressed account can open the status; another local account cannot.
    const replyId = thread?.last_status?.id ?? "";
    expect(
      (await json(`/api/v1/statuses/${replyId}`, { headers: await accessAuthHeaders(email) }))
        .status,
    ).toBe(200);
    expect(
      (
        await json(`/api/v1/statuses/${replyId}`, {
          headers: await accessAuthHeaders("remote-dm-bystander@example.com"),
        })
      ).status,
    ).toBe(404);
    expect((await json(`/api/v1/statuses/${replyId}`)).status).toBe(404);

    // Reading and removing work on a remote-rooted conversation.
    expect(
      (
        await json(`/api/v1/conversations/${rootId}/read`, {
          method: "POST",
          headers: await accessAuthHeaders(email),
        })
      ).status,
    ).toBe(200);
    expect(
      (await conversations(email)).find((conversation) => conversation.id === rootId)?.unread,
    ).toBe(false);
    expect(
      (
        await json(`/api/v1/conversations/${rootId}`, {
          method: "DELETE",
          headers: await accessAuthHeaders(email),
        })
      ).status,
    ).toBe(200);
    expect((await conversations(email)).map((conversation) => conversation.id)).not.toContain(
      rootId,
    );
  });

  it("groups a remote reply under the local direct message it answers", async () => {
    const email = "remote-dm-local-root@example.com";
    const account = await me(email);
    const actorUrl = `https://example.com/users/${account.username}`;
    const remote = await remoteActor("dm-replier");
    const local = read(
      z.object({ id: z.string(), uri: z.string() }),
      (
        await json("/api/v1/statuses", {
          method: "POST",
          headers: { "content-type": "application/json", ...(await accessAuthHeaders(email)) },
          body: JSON.stringify({ status: "hello privately", visibility: "direct" }),
        })
      ).body,
    );
    await sendDirect(remote, "dm-reply-to-local", actorUrl, { inReplyTo: local.uri });

    const listed = await conversations(email);
    expect(listed.map((conversation) => conversation.id)).toEqual([local.id]);
    expect(listed[0]?.last_status?.content).toBe("<p>dm-reply-to-local</p>");
    expect(listed[0]?.accounts.map((entry) => entry.id)).toEqual([
      RemoteAccountId.encode(remote.actorUri),
    ]);
  });

  it("leaves out blocked and muted senders and blocked domains", async () => {
    const email = "remote-dm-blocker@example.com";
    const account = await me(email);
    const actorUrl = `https://example.com/users/${account.username}`;
    const blocked = await remoteActor("dm-blocked");
    const muted = await remoteActor("dm-muted");
    const kept = await remoteActor("dm-kept");
    await sendDirect(blocked, "dm-from-blocked", actorUrl);
    await sendDirect(muted, "dm-from-muted", actorUrl);
    await sendDirect(kept, "dm-from-kept", actorUrl);
    for (const [remote, action] of [
      [blocked, "block"],
      [muted, "mute"],
    ] as const) {
      expect(
        (
          await json(`/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/${action}`, {
            method: "POST",
            headers: await accessAuthHeaders(email),
          })
        ).status,
      ).toBe(200);
    }

    const elsewhere = await remoteActor("dm-blocked-domain", "blocked-dm.example");
    await sendDirect(elsewhere, "dm-from-blocked-domain", actorUrl);
    expect(
      (
        await json("/api/v1/domain_blocks", {
          method: "POST",
          headers: { "content-type": "application/json", ...(await accessAuthHeaders(email)) },
          body: JSON.stringify({ domain: "blocked-dm.example" }),
        })
      ).status,
    ).toBe(200);

    expect((await directTimeline(email)).map((status) => status.content)).toEqual([
      "<p>dm-from-kept</p>",
    ]);
    expect(
      (await conversations(email)).map((conversation) => conversation.last_status?.content),
    ).toEqual(["<p>dm-from-kept</p>"]);
  });
});
