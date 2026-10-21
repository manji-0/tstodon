import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";

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

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const post = async (email: string, status: string, inReplyToId?: string) =>
  read(
    z.object({ id: z.string(), uri: z.string() }),
    (
      await json("/api/v1/statuses", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await accessAuthHeaders(email)) },
        body: JSON.stringify({
          status,
          visibility: "public",
          ...(inReplyToId ? { in_reply_to_id: inReplyToId } : {}),
        }),
      })
    ).body,
  );

/** Deliver a remote reply and return its cached status id and URI. */
const receiveReply = async (
  remote: Remote,
  slug: string,
  inReplyTo: string,
  to: ReadonlyArray<string> = [PUBLIC],
): Promise<{ id: string; uri: string }> => {
  const uri = `https://remote.example/notes/${slug}`;
  expect(
    await remote.send({
      id: `https://remote.example/activities/create-${slug}`,
      type: "Create",
      object: {
        id: uri,
        type: "Note",
        attributedTo: remote.actorUri,
        content: `<p>${slug}</p>`,
        published: "2026-10-20T00:00:00.000Z",
        to,
        inReplyTo,
        tag: to
          .filter((entry) => entry.startsWith("https://example.com/users/"))
          .map((href) => ({ type: "Mention", href })),
      },
    }),
  ).toBe(202);
  const { results } = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
    .bind(uri)
    .all<{ id: string }>();
  const id = results?.[0]?.id;
  if (!id) {
    throw new Error(`remote reply ${slug} was not stored`);
  }
  return { id, uri };
};

const ContextSchema = z.object({
  ancestors: z.array(z.object({ id: z.string() })),
  descendants: z.array(z.object({ id: z.string() })),
});

const context = async (id: string, email?: string) => {
  const response = await json(
    `/api/v1/statuses/${id}/context`,
    email ? { headers: await accessAuthHeaders(email) } : undefined,
  );
  expect(response.status).toBe(200);
  const parsed = read(ContextSchema, response.body);
  return {
    ancestors: parsed.ancestors.map((status) => status.id),
    descendants: parsed.descendants.map((status) => status.id),
  };
};

describe("thread context across local and remote statuses", () => {
  it("interleaves remote and local replies in both directions", async () => {
    const email = "thread-context-author@example.com";
    const carol = await remoteActor("thread-carol");
    const root = await post(email, "a thought");
    const first = await receiveReply(carol, "thread-reply-1", root.uri);
    const answer = await post(email, "@thread-carol@remote.example indeed", first.id);
    const second = await receiveReply(carol, "thread-reply-2", answer.uri);

    expect(await context(root.id)).toEqual({
      ancestors: [],
      descendants: [first.id, answer.id, second.id],
    });
    expect(await context(answer.id)).toEqual({
      ancestors: [root.id, first.id],
      descendants: [second.id],
    });
    // A remote status opens its own thread.
    expect(await context(second.id)).toEqual({
      ancestors: [root.id, first.id, answer.id],
      descendants: [],
    });
  });

  it("shows a remote direct reply only to the account it addresses", async () => {
    const email = "thread-context-dm@example.com";
    const account = read(
      z.object({ username: z.string() }),
      (
        await json("/api/v1/accounts/verify_credentials", {
          headers: await accessAuthHeaders(email),
        })
      ).body,
    );
    const dan = await remoteActor("thread-dan");
    const root = await post(email, "ask me privately");
    const direct = await receiveReply(dan, "thread-direct-1", root.uri, [
      `https://example.com/users/${account.username}`,
    ]);

    expect((await context(root.id, email)).descendants).toEqual([direct.id]);
    expect((await context(root.id)).descendants).toEqual([]);
    expect((await json(`/api/v1/statuses/${direct.id}/context`)).status).toBe(404);
  });

  it("ends a forged reply loop", async () => {
    const email = "thread-context-loop@example.com";
    const erin = await remoteActor("thread-erin");
    const root = await post(email, "loop start");
    const reply = await receiveReply(erin, "thread-loop-1", root.uri);
    const answer = await post(email, "@thread-erin@remote.example and back", reply.id);
    // The remote note claims to answer the local reply that answers it.
    await env.DB.prepare("UPDATE remote_statuses SET in_reply_to_uri = ? WHERE id = ?")
      .bind(answer.uri, reply.id)
      .run();
    const thread = await context(answer.id);
    expect(thread.ancestors).toEqual([reply.id]);
    expect(thread.descendants).toEqual([reply.id]);
  });
});
