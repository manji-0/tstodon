import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
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

const asAdmin = async (path: string, body: unknown = {}) => {
  const response = await json(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(await authHeaders("thread-silence-admin@example.com", { admin: true })),
    },
    body: JSON.stringify(body),
  });
  expect(response.status, path).toBe(200);
};

const follow = async (email: string, accountId: string) => {
  const response = await json(`/api/v1/accounts/${accountId}/follow`, {
    method: "POST",
    headers: await authHeaders(email),
  });
  expect(response.status).toBe(200);
};

const followAccepted = async (email: string, remote: Remote, slug: string) => {
  await follow(email, RemoteAccountId.encode(remote.actorUri));
  const viewer = await signedInAccount(email);
  const row = await env.DB.prepare(
    "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
  )
    .bind(viewer.id, remote.actorUri)
    .first<{ follow_activity_id: string }>();
  expect(
    await remote.send({
      id: `${remote.actorUri}/accepts/${slug}`,
      type: "Accept",
      object: row?.follow_activity_id,
    }),
  ).toBe(202);
};

const batchIds = async (ids: ReadonlyArray<string>, email?: string): Promise<string[]> => {
  const query = ids.map((id) => `id[]=${id}`).join("&");
  const response = await json(
    `/api/v1/statuses?${query}`,
    email ? { headers: await authHeaders(email) } : undefined,
  );
  expect(response.status).toBe(200);
  return read(z.array(z.object({ id: z.string() })), response.body).map((status) => status.id);
};

// Mastodon's `StatusFilter#silenced_account?`: a silenced account's status is
// left out for a reader who does not follow the account, whether the account
// or its domain is silenced, and never for the account itself.
describe("thread context for silenced authors", () => {
  it("shows a limited domain's reply only to readers who follow its author", async () => {
    const owner = "thread-silence-domain-owner@example.com";
    const follower = "thread-silence-domain-follower@example.com";
    const stranger = "thread-silence-domain-stranger@example.com";
    const limited = await remoteActor("thread-limited", "limited-thread.example");
    await followAccepted(follower, limited, "thread-limited");
    const root = await post(owner, "limited replies");
    const reply = await receiveReply(limited, "thread-limited-1", root.uri);
    await asAdmin("/api/v1/admin/domain_blocks", {
      domain: "limited-thread.example",
      severity: "silence",
    });

    expect((await context(root.id, follower)).descendants).toEqual([reply.id]);
    expect((await context(root.id, stranger)).descendants).toEqual([]);
    expect((await context(root.id, owner)).descendants).toEqual([]);
    expect((await context(root.id)).descendants).toEqual([]);
  });

  it("shows a silenced remote actor's reply only to readers who follow it", async () => {
    const owner = "thread-silence-actor-owner@example.com";
    const follower = "thread-silence-actor-follower@example.com";
    const stranger = "thread-silence-actor-stranger@example.com";
    const silenced = await remoteActor("thread-silenced-actor");
    await followAccepted(follower, silenced, "thread-silenced-actor");
    const root = await post(owner, "silenced actor replies");
    const reply = await receiveReply(silenced, "thread-silenced-actor-1", root.uri);
    await asAdmin(`/api/v1/admin/accounts/${RemoteAccountId.encode(silenced.actorUri)}/silence`);

    expect((await context(root.id, follower)).descendants).toEqual([reply.id]);
    expect((await context(root.id, stranger)).descendants).toEqual([]);
    expect((await context(root.id)).descendants).toEqual([]);
  });

  // `StatusPolicy#show?` refuses an `unavailable?` author, followed or not.
  it.each([
    ["its domain", "suspended-domain-thread.example"],
    ["the actor itself", "suspended-actor-thread.example"],
  ] as const)("hides a reply from followers once %s is suspended", async (_, host) => {
    const owner = `thread-suspend-owner@${host}`;
    const follower = `thread-suspend-follower@${host}`;
    const author = await remoteActor("thread-suspended", host);
    await followAccepted(follower, author, `thread-suspended-${host}`);
    const root = await post(owner, "replies before a suspension");
    const reply = await receiveReply(author, `thread-suspended-1-${host}`, root.uri);
    expect((await context(root.id, follower)).descendants).toEqual([reply.id]);
    expect(await batchIds([reply.id], follower)).toEqual([reply.id]);

    if (host.startsWith("suspended-domain")) {
      await asAdmin("/api/v1/admin/domain_blocks", { domain: host, severity: "suspend" });
    } else {
      await asAdmin(`/api/v1/admin/accounts/${RemoteAccountId.encode(author.actorUri)}/suspend`);
    }

    expect((await context(root.id, follower)).descendants).toEqual([]);
    expect(await batchIds([reply.id], follower)).toEqual([]);
  });

  // `following?` reads accepted follows only, not a request waiting for an answer.
  it("does not count a follow request that is not accepted yet", async () => {
    const owner = "tsp-owner@example.com";
    const requester = "tsp-requester@example.com";
    const locked = "tsp-locked@example.com";
    const lockedId = (await signedInAccount(locked)).id;
    const requesterId = (await signedInAccount(requester)).id;
    const remote = await remoteActor("thread-silenced-pending");
    const locking = await json("/api/v1/accounts/update_credentials", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(await authHeaders(locked)) },
      body: JSON.stringify({ locked: true }),
    });
    expect(locking.status).toBe(200);
    await follow(requester, lockedId);
    await follow(requester, RemoteAccountId.encode(remote.actorUri));
    const states = await env.DB.prepare(
      `SELECT kind AS state FROM follows WHERE follower_account_id = ?1
       UNION ALL SELECT state FROM outbound_follows WHERE account_id = ?1`,
    )
      .bind(requesterId)
      .all<{ state: string }>();
    expect(states.results.map((row) => row.state).sort()).toEqual(["Pending", "Requested"]);

    const root = await post(owner, "pending followers");
    const local = await post(locked, "a locked reply", root.id);
    const reply = await receiveReply(remote, "thread-silenced-pending-1", root.uri);
    await asAdmin(`/api/v1/admin/accounts/${lockedId}/silence`);
    await asAdmin(`/api/v1/admin/accounts/${RemoteAccountId.encode(remote.actorUri)}/silence`);

    expect((await context(root.id, locked)).descendants).toEqual([local.id]);
    expect((await context(root.id, requester)).descendants).toEqual([]);
    expect(await batchIds([local.id, reply.id], requester)).toEqual([]);
  });

  it("shows a silenced local account's statuses to its followers and itself", async () => {
    const owner = "thread-silence-local-owner@example.com";
    const follower = "thread-silence-local-follower@example.com";
    const stranger = "thread-silence-local-stranger@example.com";
    const silenced = "thread-silence-local-author@example.com";
    const silencedId = (await signedInAccount(silenced)).id;
    await follow(follower, silencedId);
    const root = await post(silenced, "a silenced root");
    const answer = await post(owner, "an answer", root.id);
    const reply = await post(silenced, "a silenced reply", answer.id);
    await asAdmin(`/api/v1/admin/accounts/${silencedId}/silence`);

    for (const reader of [follower, silenced]) {
      expect(await context(answer.id, reader)).toEqual({
        ancestors: [root.id],
        descendants: [reply.id],
      });
    }
    for (const reader of [stranger, owner, undefined]) {
      expect(await context(answer.id, reader)).toEqual({ ancestors: [], descendants: [] });
    }
    // `permitted_statuses_from_ids` filters a batch lookup the same way.
    expect(await batchIds([root.id, answer.id], follower)).toEqual([root.id, answer.id]);
    expect(await batchIds([root.id, answer.id], stranger)).toEqual([answer.id]);
    expect(await batchIds([root.id, answer.id])).toEqual([answer.id]);
    // A status fetched by id answers to `StatusPolicy#show?` alone.
    expect((await json(`/api/v1/statuses/${root.id}`)).status).toBe(200);
  });
});

describe("a batch lookup by id", () => {
  it("leaves out statuses by authors the reader blocks, mutes, or domain-blocks", async () => {
    const reader = "batch-filter-reader@example.com";
    const muted = "batch-filter-muted@example.com";
    const blocked = "batch-filter-blocked@example.com";
    const kept = await post("batch-filter-kept@example.com", "kept");
    const mutedStatus = await post(muted, "muted");
    const blockedStatus = await post(blocked, "blocked");
    const elsewhere = await remoteActor("batch-filter-elsewhere", "batch-blocked.example");
    const remoteStatus = await receiveReply(elsewhere, "batch-filter-remote", kept.uri);
    const headers = { "content-type": "application/json", ...(await authHeaders(reader)) };
    for (const [path, body] of [
      [`/api/v1/accounts/${(await signedInAccount(muted)).id}/mute`, {}],
      [`/api/v1/accounts/${(await signedInAccount(blocked)).id}/block`, {}],
      ["/api/v1/domain_blocks", { domain: "batch-blocked.example" }],
    ] as const) {
      const response = await json(path, { method: "POST", headers, body: JSON.stringify(body) });
      expect(response.status, path).toBe(200);
    }

    const ids = [kept.id, mutedStatus.id, blockedStatus.id, remoteStatus.id];
    expect(await batchIds(ids, reader)).toEqual([kept.id]);
    expect(await batchIds(ids)).toEqual(ids);
  });
});
