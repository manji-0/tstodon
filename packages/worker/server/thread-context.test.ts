import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
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

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const post = async (email: string, status: string, inReplyToId?: string) =>
  read(
    z.object({ id: z.string(), uri: z.string() }),
    (
      await json("/api/v1/statuses", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeaders(email)) },
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
  const origin = new URL(remote.actorUri).origin;
  const uri = `${origin}/notes/${slug}`;
  expect(
    await remote.send({
      id: `${origin}/activities/create-${slug}`,
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
    email ? { headers: await authHeaders(email) } : undefined,
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
    // Every reply names its parent and the parent's author, remote or local.
    const author = read(
      z.object({ id: z.string() }),
      (
        await json("/api/v1/accounts/verify_credentials", {
          headers: await authHeaders(email),
        })
      ).body,
    );
    const thread = read(
      z.object({
        descendants: z.array(
          z.object({
            id: z.string(),
            in_reply_to_id: z.string().nullable(),
            in_reply_to_account_id: z.string().nullable(),
          }),
        ),
      }),
      (await json(`/api/v1/statuses/${root.id}/context`)).body,
    );
    const carolId = RemoteAccountId.encode(carol.actorUri);
    expect(
      thread.descendants.map((status) => [
        status.id,
        status.in_reply_to_id,
        status.in_reply_to_account_id,
      ]),
    ).toEqual([
      [first.id, root.id, author.id],
      [answer.id, first.id, carolId],
      [second.id, answer.id, author.id],
    ]);
    const single = read(
      z.object({ in_reply_to_id: z.string().nullable() }),
      (await json(`/api/v1/statuses/${second.id}`)).body,
    );
    expect(single.in_reply_to_id).toBe(answer.id);

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
          headers: await authHeaders(email),
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

  it("leaves out replies from blocked, muted, and domain-blocked authors", async () => {
    const email = "thread-context-blocker@example.com";
    const headers = async () => ({
      "content-type": "application/json",
      ...(await authHeaders(email)),
    });
    const root = await post(email, "replies welcome");
    const blocked = await remoteActor("thread-blocked");
    const elsewhere = await remoteActor("thread-elsewhere", "blocked-thread.example");
    const kept = await remoteActor("thread-kept");
    const mutedLocal = "thread-context-muted@example.com";
    const mutedAccount = read(
      z.object({ id: z.string() }),
      (
        await json("/api/v1/accounts/verify_credentials", {
          headers: await authHeaders(mutedLocal),
        })
      ).body,
    );
    await receiveReply(blocked, "thread-from-blocked", root.uri);
    await receiveReply(elsewhere, "thread-from-blocked-domain", root.uri);
    const keptReply = await receiveReply(kept, "thread-from-kept", root.uri);
    await post(mutedLocal, "a local reply", root.id);

    for (const [path, body] of [
      [`/api/v1/accounts/${RemoteAccountId.encode(blocked.actorUri)}/block`, {}],
      [`/api/v1/accounts/${mutedAccount.id}/mute`, {}],
      ["/api/v1/domain_blocks", { domain: "blocked-thread.example" }],
    ] as const) {
      expect(
        (await json(path, { method: "POST", headers: await headers(), body: JSON.stringify(body) }))
          .status,
      ).toBe(200);
    }

    expect((await context(root.id, email)).descendants).toEqual([keptReply.id]);
    // Someone else still sees the whole thread.
    expect((await context(root.id)).descendants).toHaveLength(4);
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

  it("walks runs of local and remote parents alternately", async () => {
    const email = "thread-context-runs@example.com";
    const dave = await remoteActor("thread-dave");
    const root = await post(email, "runs root");
    const local1 = await post(email, "runs local 1", root.id);
    const remote1 = await receiveReply(dave, "thread-runs-1", local1.uri);
    const remote2 = await receiveReply(dave, "thread-runs-2", remote1.uri);
    const remote3 = await receiveReply(dave, "thread-runs-3", remote2.uri);
    const local2 = await post(email, "@thread-dave@remote.example runs local 2", remote3.id);
    const local3 = await post(email, "runs local 3", local2.id);
    const leaf = await receiveReply(dave, "thread-runs-4", local3.uri);

    expect((await context(leaf.id)).ancestors).toEqual([
      root.id,
      local1.id,
      remote1.id,
      remote2.id,
      remote3.id,
      local2.id,
      local3.id,
    ]);
    // Anonymous readers get the nearest 20 parents at most; this chain fits.
    expect((await context(leaf.id, email)).ancestors).toHaveLength(7);
  });

  it("ends the ancestors at the deepest status this server has", async () => {
    const email = "thread-context-missing@example.com";
    const frank = await remoteActor("thread-frank");
    const orphan = await receiveReply(
      frank,
      "thread-missing-1",
      "https://remote.example/notes/never-fetched",
    );
    const reply = await post(email, "@thread-frank@remote.example answering", orphan.id);
    const leaf = await post(email, "and on", reply.id);
    expect((await context(leaf.id)).ancestors).toEqual([orphan.id, reply.id]);
  });

  it("ends a forged loop between remote statuses", async () => {
    const email = "thread-context-remote-loop@example.com";
    const gina = await remoteActor("thread-gina");
    const root = await post(email, "remote loop start");
    const first = await receiveReply(gina, "thread-remote-loop-1", root.uri);
    const second = await receiveReply(gina, "thread-remote-loop-2", first.uri);
    const leaf = await post(email, "@thread-gina@remote.example below the loop", second.id);
    // The first remote note claims to answer the second, which answers it.
    await env.DB.prepare("UPDATE remote_statuses SET in_reply_to_uri = ? WHERE id = ?")
      .bind(second.uri, first.id)
      .run();
    expect((await context(leaf.id)).ancestors).toEqual([first.id, second.id]);
  });
});
