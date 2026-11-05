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
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const send = async (email: string, path: string, method: string, body?: unknown) =>
  json(path, {
    method,
    headers: { ...(await authHeaders(email)), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const get = async (email: string, path: string) =>
  json(path, { headers: await authHeaders(email) });

const accountId = (remote: Remote): string => RemoteAccountId.encode(remote.actorUri);

const acceptedFollow = async (email: string, remote: Remote, slug: string) => {
  expect(
    (await send(email, `/api/v1/accounts/${accountId(remote)}/follow`, "POST", {})).status,
  ).toBe(200);
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

const createList = async (email: string, title: string): Promise<string> =>
  read(z.object({ id: z.string() }), (await send(email, "/api/v1/lists", "POST", { title })).body)
    .id;

const memberIds = async (email: string, listId: string): Promise<string[]> =>
  read(
    z.array(z.object({ id: z.string() })),
    (await get(email, `/api/v1/lists/${listId}/accounts`)).body,
  ).map((account) => account.id);

const listsContaining = async (email: string, id: string): Promise<string[]> =>
  read(
    z.array(z.object({ id: z.string() })),
    (await get(email, `/api/v1/accounts/${id}/lists`)).body,
  ).map((list) => list.id);

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

/** A note by `author`, delivered to (and cached by) this instance. */
const note = async (
  author: Remote,
  slug: string,
  extra: Record<string, unknown> = {},
): Promise<string> => {
  const noteUri = `${new URL(author.actorUri).origin}/notes/${slug}`;
  expect(
    await author.send({
      id: `${noteUri}/activity`,
      type: "Create",
      object: {
        id: noteUri,
        type: "Note",
        attributedTo: author.actorUri,
        content: `<p>${slug}</p>`,
        published: "2026-10-20T00:00:00.000Z",
        to: [PUBLIC],
        cc: [`${author.actorUri}/followers`],
        ...extra,
      },
    }),
  ).toBe(202);
  return noteUri;
};

const boost = async (booster: Remote, objectUri: string, slug: string): Promise<string> => {
  const announceId = `${booster.actorUri}/statuses/${slug}/activity`;
  expect(
    await booster.send({
      id: announceId,
      type: "Announce",
      object: objectUri,
      published: "2026-10-21T00:00:00.000Z",
      to: [PUBLIC],
      cc: [`${booster.actorUri}/followers`],
    }),
  ).toBe(202);
  return announceId;
};

const EntrySchema = z.object({
  id: z.string(),
  uri: z.string(),
  reblog: z.object({ uri: z.string() }).nullable(),
});

const timeline = async (email: string, path: string) =>
  read(z.array(EntrySchema), (await get(email, path)).body);

/** Each entry as the URI a reader sees, a boost as `boost:` and the boosted URI. */
const uris = async (email: string, path: string): Promise<string[]> =>
  (await timeline(email, path)).map((entry) =>
    entry.reblog ? `boost:${entry.reblog.uri}` : entry.uri,
  );

const addMembers = async (email: string, listId: string, ids: string[]) =>
  expect(
    (await send(email, `/api/v1/lists/${listId}/accounts`, "POST", { account_ids: ids })).status,
  ).toBe(200);

describe("a list timeline with remote members", () => {
  it("shows the remote members' notes and boosts, paged by id", async () => {
    const member = await remoteActor("list-feed-member", "member.example");
    const outsider = await remoteActor("list-feed-outsider", "outsider.example");
    const owner = "list-feed-owner@example.com";
    await acceptedFollow(owner, member, "list-feed-member");
    await acceptedFollow(owner, outsider, "list-feed-outsider");
    const listId = await createList(owner, "Feed");
    await addMembers(owner, listId, [accountId(member)]);

    const first = await note(member, "list-feed-first");
    const followersOnly = await note(member, "list-feed-followers", {
      to: [`${member.actorUri}/followers`],
      cc: [],
    });
    const outsiderNote = await note(outsider, "list-feed-outside");
    await boost(member, outsiderNote, "list-feed-boost");
    await note(outsider, "list-feed-outside-other");

    const path = `/api/v1/timelines/list/${listId}`;
    expect(await uris(owner, path)).toEqual([`boost:${outsiderNote}`, followersOnly, first]);

    const entries = await timeline(owner, path);
    const newest = entries[0]?.id ?? "";
    const oldest = entries[2]?.id ?? "";
    expect(await uris(owner, `${path}?max_id=${newest}`)).toEqual([followersOnly, first]);
    expect(await uris(owner, `${path}?limit=1&min_id=${oldest}`)).toEqual([followersOnly]);
    expect(await uris(owner, `${path}?since_id=${oldest}`)).toEqual([
      `boost:${outsiderNote}`,
      followersOnly,
    ]);
  });

  it("applies home's blocks and the list's replies policy to remote members", async () => {
    const member = await remoteActor("list-rules-member", "rules.example");
    const blocked = await remoteActor("list-rules-blocked", "blocked.example");
    const owner = "list-rules-owner@example.com";
    await acceptedFollow(owner, member, "list-rules-member");
    await acceptedFollow(owner, blocked, "list-rules-blocked");
    const listId = await createList(owner, "Rules");
    await addMembers(owner, listId, [accountId(member), accountId(blocked)]);
    const root = await note(member, "list-rules-root");
    const reply = await note(member, "list-rules-reply", { inReplyTo: root });
    const blockedNote = await note(blocked, "list-rules-blocked-note");
    await note(member, "list-rules-cross", { inReplyTo: blockedNote });
    expect((await send(owner, `/api/v1/accounts/${accountId(blocked)}/block`, "POST")).status).toBe(
      200,
    );

    // The block ended the follow of `blocked` and with it the membership, so
    // under the default "list" policy `cross` is a reply to a non-member.
    expect(await memberIds(owner, listId)).toEqual([accountId(member)]);
    const path = `/api/v1/timelines/list/${listId}`;
    expect(await uris(owner, path)).toEqual([reply, root]);

    // Replies to the author itself pass whatever the policy.
    expect(
      (await send(owner, `/api/v1/lists/${listId}`, "PUT", { replies_policy: "none" })).status,
    ).toBe(200);
    expect(await uris(owner, path)).toEqual([reply, root]);
  });
});

describe("remote accounts on lists", () => {
  it("adds a followed remote account next to a local one and removes it again", async () => {
    const remote = await remoteActor("list-member-remote");
    const owner = "list-remote-owner@example.com";
    const local = await signedInAccount("list-remote-local@example.com");
    await acceptedFollow(owner, remote, "list-member");
    expect((await send(owner, `/api/v1/accounts/${local.id}/follow`, "POST", {})).status).toBe(200);
    const listId = await createList(owner, "Mixed");

    const added = await send(owner, `/api/v1/lists/${listId}/accounts`, "POST", {
      account_ids: [local.id, accountId(remote)],
    });
    expect(added.status).toBe(200);
    expect(await memberIds(owner, listId)).toEqual([local.id, accountId(remote)]);
    expect(await listsContaining(owner, accountId(remote))).toEqual([listId]);

    const removed = await send(owner, `/api/v1/lists/${listId}/accounts`, "DELETE", {
      account_ids: [accountId(remote)],
    });
    expect(removed.status).toBe(200);
    expect(await memberIds(owner, listId)).toEqual([local.id]);
    expect(await listsContaining(owner, accountId(remote))).toEqual([]);
  });

  it("refuses a remote account that is not followed, or only requested", async () => {
    const stranger = await remoteActor("list-stranger-remote");
    const requested = await remoteActor("list-requested-remote");
    const owner = "list-refusing-owner@example.com";
    const local = await signedInAccount("list-refused-local@example.com");
    expect(
      (await send(owner, `/api/v1/accounts/${accountId(requested)}/follow`, "POST", {})).status,
    ).toBe(200);
    const listId = await createList(owner, "Strangers");

    for (const remote of [stranger, requested]) {
      const added = await send(owner, `/api/v1/lists/${listId}/accounts`, "POST", {
        account_ids: [local.id, accountId(remote)],
      });
      expect(added.status).toBe(422);
    }
    expect(await memberIds(owner, listId)).toEqual([]);
  });

  it("drops the remote account from the owner's lists on unfollow", async () => {
    const remote = await remoteActor("list-unfollowed-remote");
    const owner = "list-unfollowing-owner@example.com";
    await acceptedFollow(owner, remote, "list-unfollowed");
    const first = await createList(owner, "First");
    const second = await createList(owner, "Second");
    for (const listId of [first, second]) {
      expect(
        (
          await send(owner, `/api/v1/lists/${listId}/accounts`, "POST", {
            account_ids: [accountId(remote)],
          })
        ).status,
      ).toBe(200);
    }
    expect((await listsContaining(owner, accountId(remote))).toSorted()).toEqual(
      [first, second].toSorted(),
    );

    expect(
      (await send(owner, `/api/v1/accounts/${accountId(remote)}/unfollow`, "POST")).status,
    ).toBe(200);
    expect(await listsContaining(owner, accountId(remote))).toEqual([]);
    expect(await memberIds(owner, first)).toEqual([]);

    await acceptedFollow(owner, remote, "list-refollowed");
    expect(await memberIds(owner, first)).toEqual([]);
  });
});
