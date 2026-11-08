import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { openStream } from "../test/stream-fixture";
import { RemoteAccountId } from "./remote-account-id";

const ORIGIN = "https://example.com";

const json = async (email: string, path: string, init: RequestInit = {}) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined };
};

const ConversationSchema = z.object({
  id: z.string(),
  unread: z.boolean(),
  accounts: z.array(z.object({ id: z.string() })),
  last_status: z.object({ id: z.string(), content: z.string() }).nullable(),
});

const conversationOf = (payload: string) => {
  const parsed = schemaResult(ConversationSchema)(JSON.parse(payload));
  if (parsed.isErr()) {
    throw new Error("conversation rejected");
  }
  return parsed.value;
};

const postTo = async (
  author: string,
  recipient: string,
  visibility: "direct" | "public",
  text: string,
) => {
  const { username } = await signedInAccount(recipient);
  const posted = await json(author, "/api/v1/statuses", {
    method: "POST",
    body: JSON.stringify({ status: `@${username} ${text}`, visibility }),
  });
  expect(posted.status).toBe(200);
  return z.object({ id: z.string() }).parse(posted.body).id;
};

describe("direct stream", () => {
  it("send the recipient and the author a conversation for a local direct note, and nothing for a public one", async () => {
    const author = "dm-author@example.com";
    const recipient = "dm-recipient@example.com";
    const [authorAccount, recipientAccount] = await Promise.all([
      signedInAccount(author),
      signedInAccount(recipient),
    ]);
    const direct = { kind: "Direct" } as const;
    const recipientSocket = await openStream({ email: recipient, query: "?stream=direct" });
    const authorSocket = await openStream({ email: author, query: "?stream=direct" });

    await postTo(author, recipient, "public", "not a message");
    expect(await recipientSocket.heardNothing(direct)).toBe(true);

    const statusId = await postTo(author, recipient, "direct", "hello there");
    const heard = await recipientSocket.next();
    expect(heard).toMatchObject({ stream: ["direct"], event: "conversation" });
    const conversation = conversationOf(heard.payload);
    expect(conversation.last_status).toMatchObject({ id: statusId });
    expect(conversation.last_status?.content).toContain("hello there");
    expect(conversation.accounts).toEqual([expect.objectContaining({ id: authorAccount.id })]);

    const own = conversationOf((await authorSocket.next()).payload);
    expect(own.id).toBe(conversation.id);
    expect(own.accounts).toEqual([expect.objectContaining({ id: recipientAccount.id })]);

    // It is the conversation the list shows.
    const listed = await json(recipient, "/api/v1/conversations");
    expect(z.array(ConversationSchema).parse(listed.body)).toEqual([conversation]);

    // A reply joins the same conversation.
    const replyId = await postTo(recipient, author, "direct", "hi back");
    expect(conversationOf((await authorSocket.next()).payload)).toMatchObject({
      id: expect.any(String),
      unread: true,
      last_status: { id: replyId },
    });
    recipientSocket.close();
    authorSocket.close();
  });

  it("send nothing for a direct note from an account the recipient blocks", async () => {
    const author = "dm-blocked-author@example.com";
    const recipient = "dm-blocker@example.com";
    const authorAccount = await signedInAccount(author);
    const blocked = await json(recipient, `/api/v1/accounts/${authorAccount.id}/block`, {
      method: "POST",
      body: "{}",
    });
    expect(blocked.status).toBe(200);
    const recipientSocket = await openStream({ email: recipient, query: "?stream=direct" });
    const authorSocket = await openStream({ email: author, query: "?stream=direct" });

    await postTo(author, recipient, "direct", "can you hear me");
    expect(await authorSocket.next()).toMatchObject({ event: "conversation" });
    expect(await recipientSocket.heardNothing({ kind: "Direct" })).toBe(true);
    recipientSocket.close();
    authorSocket.close();
  });

  it("send a remote direct note that mentions the account as a conversation", async () => {
    const email = "dm-remote-recipient@example.com";
    const account = await signedInAccount(email);
    const socket = await openStream({ email, query: "?stream=direct" });
    const remote = await remoteActor("dm-stream-sender");
    const origin = new URL(remote.actorUri).origin;
    const to = `${ORIGIN}/users/${account.username}`;
    const note = (slug: string, audience: ReadonlyArray<string>) => ({
      id: `${origin}/activities/create-${slug}`,
      type: "Create",
      object: {
        id: `${origin}/notes/${slug}`,
        type: "Note",
        attributedTo: remote.actorUri,
        content: `<p>${slug}</p>`,
        published: "2026-10-20T00:00:00.000Z",
        to: audience,
        tag: [{ type: "Mention", href: to }],
      },
    });

    expect(
      await remote.send(note("dm-stream-public", ["https://www.w3.org/ns/activitystreams#Public"])),
    ).toBe(202);
    expect(await socket.heardNothing({ kind: "Direct" })).toBe(true);

    expect(await remote.send(note("dm-stream-direct", [to]))).toBe(202);
    const heard = await socket.next();
    expect(heard).toMatchObject({ stream: ["direct"], event: "conversation" });
    const conversation = conversationOf(heard.payload);
    expect(conversation.last_status?.content).toBe("<p>dm-stream-direct</p>");
    expect(conversation.accounts).toEqual([
      expect.objectContaining({ id: RemoteAccountId.encode(remote.actorUri) }),
    ]);
    socket.close();
  });

  it("send the account's direct stream the read conversation, and nothing on removal", async () => {
    const author = "dm-read-author@example.com";
    const recipient = "dm-read-recipient@example.com";
    const recipientSocket = await openStream({ email: recipient, query: "?stream=direct" });
    const otherSocket = await openStream({ email: recipient, query: "?stream=direct" });
    const authorSocket = await openStream({ email: author, query: "?stream=direct" });

    const statusId = await postTo(author, recipient, "direct", "please read me");
    const unread = conversationOf((await recipientSocket.next()).payload);
    expect(unread.unread).toBe(true);
    expect(conversationOf((await otherSocket.next()).payload).id).toBe(unread.id);
    await authorSocket.next();

    const read = await json(recipient, `/api/v1/conversations/${unread.id}/read`, {
      method: "POST",
      body: "{}",
    });
    expect(read.status).toBe(200);
    for (const socket of [recipientSocket, otherSocket]) {
      const heard = await socket.next();
      expect(heard).toMatchObject({ stream: ["direct"], event: "conversation" });
      expect(conversationOf(heard.payload)).toMatchObject({
        id: unread.id,
        unread: false,
        last_status: { id: statusId },
      });
    }
    // Only the account that read it hears about it.
    expect(await authorSocket.heardNothing({ kind: "Direct" })).toBe(true);

    const removed = await json(recipient, `/api/v1/conversations/${unread.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(await recipientSocket.heardNothing({ kind: "Direct" })).toBe(true);
    expect(await authorSocket.heardNothing({ kind: "Direct" })).toBe(true);
    for (const socket of [recipientSocket, otherSocket, authorSocket]) {
      socket.close();
    }
  });
});
