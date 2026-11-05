import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const json = async (path: string, init?: RequestInit) => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`response schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const send = async (email: string, path: string, method = "POST", body?: unknown) =>
  json(path, {
    method,
    headers: { ...(await authHeaders(email)), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const get = async (email: string, path: string) =>
  json(path, { headers: await authHeaders(email) });

const Ids = z.array(z.object({ id: z.string() }));
const ids = async (email: string, path: string): Promise<string[]> =>
  read(Ids, (await get(email, path)).body).map((entry) => entry.id);

const Relationship = z.object({
  id: z.string(),
  following: z.boolean(),
  followed_by: z.boolean(),
  requested: z.boolean(),
  blocking: z.boolean(),
});

const Counts = z.object({ followers_count: z.number(), following_count: z.number() });
const counts = async (email: string) =>
  read(Counts, (await get(email, "/api/v1/accounts/verify_credentials")).body);

const lock = async (email: string): Promise<void> => {
  const account = await signedInAccount(email);
  await env.DB.prepare("UPDATE accounts SET locked = 1 WHERE id = ?").bind(account.id).run();
};

const createList = async (email: string, title: string): Promise<string> =>
  read(z.object({ id: z.string() }), (await send(email, "/api/v1/lists", "POST", { title })).body)
    .id;

const addMember = async (email: string, listId: string, accountId: string) =>
  expect(
    (await send(email, `/api/v1/lists/${listId}/accounts`, "POST", { account_ids: [accountId] }))
      .status,
  ).toBe(200);

const block = async (email: string, accountId: string) => {
  const blocked = await send(email, `/api/v1/accounts/${accountId}/block`);
  expect(blocked.status).toBe(200);
  return read(Relationship, blocked.body);
};

const remoteId = (remote: Remote): string => RemoteAccountId.encode(remote.actorUri);

/** The activities of `kind` the account queued, with the inbox each goes to. */
const queued = async (email: string, kind: string) => {
  const account = await signedInAccount(email);
  const rows = await env.DB.prepare(
    `SELECT a.payload_json, d.inbox_url FROM outbound_activities a
     JOIN outbox_deliveries d ON d.activity_id = a.id AND d.inbox_url IS NOT NULL
     WHERE a.account_id = ? AND a.kind = ? ORDER BY a.rowid`,
  )
    .bind(account.id, kind)
    .all<{ payload_json: string; inbox_url: string }>();
  return rows.results.map((row) => ({
    inbox: row.inbox_url,
    activity: read(
      z.object({ id: z.string(), type: z.string(), actor: z.string(), object: z.unknown() }),
      JSON.parse(row.payload_json),
    ),
  }));
};

const acceptedRemoteFollow = async (email: string, remote: Remote): Promise<string> => {
  expect(
    (await send(email, `/api/v1/accounts/${remoteId(remote)}/follow`, "POST", {})).status,
  ).toBe(200);
  const account = await signedInAccount(email);
  const row = await env.DB.prepare(
    "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
  )
    .bind(account.id, remote.actorUri)
    .first<{ follow_activity_id: string }>();
  const followId = row?.follow_activity_id ?? "";
  expect(
    await remote.send({ id: `${remote.actorUri}/accepts/1`, type: "Accept", object: followId }),
  ).toBe(202);
  return followId;
};

const remoteFollows = async (remote: Remote, email: string): Promise<string> => {
  const account = await signedInAccount(email);
  const followId = `${remote.actorUri}/follows/1`;
  expect(
    await remote.send({
      id: followId,
      type: "Follow",
      object: `https://example.com/users/${account.username}`,
    }),
  ).toBe(202);
  return followId;
};

describe("blocking an account severs the follows between the two", () => {
  it("drops both local follows, the list membership, and the counts", async () => {
    const a = "block-sever-a@example.com";
    const b = "block-sever-b@example.com";
    const aId = (await signedInAccount(a)).id;
    const bId = (await signedInAccount(b)).id;
    expect((await send(a, `/api/v1/accounts/${bId}/follow`)).status).toBe(200);
    expect((await send(b, `/api/v1/accounts/${aId}/follow`)).status).toBe(200);
    const listId = await createList(a, "Friends");
    await addMember(a, listId, bId);

    expect(await block(a, bId)).toMatchObject({
      blocking: true,
      following: false,
      followed_by: false,
      requested: false,
    });
    expect(await ids(a, `/api/v1/lists/${listId}/accounts`)).toEqual([]);
    expect(await counts(a)).toEqual({ followers_count: 0, following_count: 0 });
    expect(await counts(b)).toEqual({ followers_count: 0, following_count: 0 });
  });

  it("rejects the target's pending request and withdraws the blocker's own", async () => {
    const a = "block-sever-locked-a@example.com";
    const b = "block-sever-locked-b@example.com";
    const aId = (await signedInAccount(a)).id;
    const bId = (await signedInAccount(b)).id;
    await lock(a);
    await lock(b);
    expect((await send(b, `/api/v1/accounts/${aId}/follow`)).status).toBe(200);
    expect((await send(a, `/api/v1/accounts/${bId}/follow`)).status).toBe(200);
    expect(await ids(a, "/api/v1/follow_requests")).toEqual([bId]);

    expect(await block(a, bId)).toMatchObject({ requested: false, followed_by: false });
    expect(await ids(a, "/api/v1/follow_requests")).toEqual([]);
    expect(await ids(b, "/api/v1/follow_requests")).toEqual([]);
  });

  it("federates Undo(Follow), Reject(Follow) and Block to a remote target", async () => {
    const a = "block-sever-remote-a@example.com";
    const remote = await remoteActor("block-sever-remote");
    const followId = await acceptedRemoteFollow(a, remote);
    const remoteFollowId = await remoteFollows(remote, a);
    const listId = await createList(a, "Remote friends");
    await addMember(a, listId, remoteId(remote));
    expect(await counts(a)).toEqual({ followers_count: 1, following_count: 1 });

    expect(await block(a, remoteId(remote))).toMatchObject({
      blocking: true,
      following: false,
      followed_by: false,
    });
    expect(await ids(a, `/api/v1/lists/${listId}/accounts`)).toEqual([]);
    expect(await counts(a)).toEqual({ followers_count: 0, following_count: 0 });

    const inbox = `${remote.actorUri}/inbox`;
    const actor = `https://example.com/users/${(await signedInAccount(a)).username}`;
    expect(await queued(a, "Undo")).toMatchObject([
      { inbox, activity: { type: "Undo", object: { id: followId, type: "Follow" } } },
    ]);
    expect(await queued(a, "Reject")).toMatchObject([
      {
        inbox,
        activity: {
          type: "Reject",
          actor,
          object: { id: remoteFollowId, type: "Follow", actor: remote.actorUri },
        },
      },
    ]);
    expect(await queued(a, "Block")).toMatchObject([
      { inbox, activity: { type: "Block", actor, object: remote.actorUri } },
    ]);
  });

  it("rejects a remote actor's pending request to the blocker", async () => {
    const a = "block-sever-remote-locked@example.com";
    await lock(a);
    const remote = await remoteActor("block-sever-requester");
    const remoteFollowId = await remoteFollows(remote, a);
    expect(await ids(a, "/api/v1/follow_requests")).toEqual([remoteId(remote)]);

    await block(a, remoteId(remote));
    expect(await ids(a, "/api/v1/follow_requests")).toEqual([]);
    expect(await queued(a, "Reject")).toMatchObject([
      { activity: { type: "Reject", object: { id: remoteFollowId, type: "Follow" } } },
    ]);
  });

  it("sends Undo(Block) when the blocker unblocks a remote target", async () => {
    const a = "block-sever-unblock@example.com";
    const remote = await remoteActor("block-sever-unblocked");
    await block(a, remoteId(remote));
    const [sent] = await queued(a, "Block");
    expect(sent).toBeDefined();

    expect((await send(a, `/api/v1/accounts/${remoteId(remote)}/unblock`)).status).toBe(200);
    expect(await queued(a, "Undo")).toMatchObject([
      {
        inbox: `${remote.actorUri}/inbox`,
        activity: { type: "Undo", object: { id: sent?.activity.id, type: "Block" } },
      },
    ]);
  });
});

describe("a remote actor's Block of a local account", () => {
  it("ends the follows both ways and answers with Undo(Follow) and Reject(Follow)", async () => {
    const a = "blocked-by-remote@example.com";
    const remote = await remoteActor("remote-blocker");
    const followId = await acceptedRemoteFollow(a, remote);
    const remoteFollowId = await remoteFollows(remote, a);
    expect(await counts(a)).toEqual({ followers_count: 1, following_count: 1 });

    const username = (await signedInAccount(a)).username;
    expect(
      await remote.send({
        id: `${remote.actorUri}#blocks/1`,
        type: "Block",
        object: `https://example.com/users/${username}`,
      }),
    ).toBe(202);
    expect(await counts(a)).toEqual({ followers_count: 0, following_count: 0 });
    expect(await queued(a, "Undo")).toMatchObject([
      { activity: { type: "Undo", object: { id: followId, type: "Follow" } } },
    ]);
    expect(await queued(a, "Reject")).toMatchObject([
      { activity: { type: "Reject", object: { id: remoteFollowId, type: "Follow" } } },
    ]);
  });
});
