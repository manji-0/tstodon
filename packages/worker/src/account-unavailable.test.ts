import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { MastodonAccountPreviewSchema } from "../test/mastodon-preview-schemas";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

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

const AccountSchema = MastodonAccountPreviewSchema.extend({
  display_name: z.string(),
  suspended: z.boolean().optional(),
});
const Accounts = z.array(AccountSchema);
const Ids = z.array(z.object({ id: z.string() }));

const admin = () => authHeaders("unavailable-admin@example.com", { admin: true });

const accountIdOf = async (email: string): Promise<string> => (await signedInAccount(email)).id;

const post = async (email: string, path: string, body: unknown = {}) => {
  const response = await json(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.body;
};

const suspend = async (accountId: string) => {
  const response = await json(`/api/v1/admin/accounts/${accountId}/suspend`, {
    method: "POST",
    headers: await admin(),
  });
  expect(response.status).toBe(200);
};

const get = async (path: string, email?: string) => {
  const response = await json(path, email ? { headers: await authHeaders(email) } : undefined);
  expect(response.status).toBe(200);
  return response.body;
};

const idsAt = async (path: string, email?: string): Promise<string[]> =>
  read(Ids, await get(path, email)).map((entry) => entry.id);

describe("a suspended local account's own lists", () => {
  it("are empty: statuses, followers, following, featured tags, endorsements", async () => {
    const owner = "unavailable-owner@example.com";
    const friend = "unavailable-friend@example.com";
    const ownerId = await accountIdOf(owner);
    const friendId = await accountIdOf(friend);
    await post(owner, "/api/v1/statuses", { status: "hello #unavailablewave" });
    await post(owner, `/api/v1/accounts/${friendId}/follow`);
    await post(friend, `/api/v1/accounts/${ownerId}/follow`);
    await post(owner, `/api/v1/accounts/${friendId}/endorse`);
    await post(owner, "/api/v1/featured_tags", { name: "unavailablewave" });

    const lists = [
      `/api/v1/accounts/${ownerId}/statuses`,
      `/api/v1/accounts/${ownerId}/followers`,
      `/api/v1/accounts/${ownerId}/following`,
      `/api/v1/accounts/${ownerId}/featured_tags`,
      `/api/v1/accounts/${ownerId}/endorsements`,
    ];
    for (const path of lists) {
      expect((await idsAt(path, friend)).length, path).toBeGreaterThan(0);
    }

    await suspend(ownerId);

    for (const path of lists) {
      expect(await idsAt(path, friend), path).toEqual([]);
    }
  });
});

describe("a suspended account named in another account's data", () => {
  it("renders stripped in a followers list", async () => {
    const target = "stripped-target@example.com";
    const follower = "stripped-follower@example.com";
    const targetId = await accountIdOf(target);
    const followerId = await accountIdOf(follower);
    await post(follower, `/api/v1/accounts/${targetId}/follow`);

    await suspend(followerId);

    const followers = read(Accounts, await get(`/api/v1/accounts/${targetId}/followers`));
    const entry = followers.find((account) => account.id === followerId);
    expect(entry?.suspended).toBe(true);
    expect(entry?.display_name).toBe("");
  });

  it("renders stripped in familiar followers", async () => {
    const viewer = "familiar-viewer-sus@example.com";
    const target = "familiar-target-sus@example.com";
    const mutual = "familiar-mutual-sus@example.com";
    const targetId = await accountIdOf(target);
    const mutualId = await accountIdOf(mutual);
    await post(mutual, `/api/v1/accounts/${targetId}/follow`);
    await post(viewer, `/api/v1/accounts/${mutualId}/follow`);

    await suspend(mutualId);

    const groups = read(
      z.array(z.object({ id: z.string(), accounts: Accounts })),
      await get(`/api/v1/accounts/familiar_followers?id[]=${targetId}`, viewer),
    );
    const entry = groups[0]?.accounts.find((account) => account.id === mutualId);
    expect(entry?.suspended).toBe(true);
    expect(entry?.display_name).toBe("");
  });

  it("is left out of notifications, follow requests, lists, endorsements and favourites", async () => {
    const me = "listing-owner@example.com";
    const other = "listing-suspended@example.com";
    const meId = await accountIdOf(me);
    const otherId = await accountIdOf(other);
    const form = new FormData();
    form.set("locked", "true");
    expect(
      (
        await json("/api/v1/accounts/update_credentials", {
          method: "PATCH",
          headers: await authHeaders(me),
          body: form,
        })
      ).status,
    ).toBe(200);
    // A follow request to `me`, and `me` following `other` for the list.
    await post(other, `/api/v1/accounts/${meId}/follow`);
    const status = read(
      z.object({ id: z.string() }),
      await post(me, "/api/v1/statuses", { status: "favourite me" }),
    );
    await post(other, `/api/v1/statuses/${status.id}/favourite`);
    await post(me, `/api/v1/accounts/${otherId}/follow`);
    const list = read(
      z.object({ id: z.string() }),
      await post(me, "/api/v1/lists", { title: "L" }),
    );
    await post(me, `/api/v1/lists/${list.id}/accounts`, { account_ids: [otherId] });
    await post(me, `/api/v1/accounts/${otherId}/endorse`);

    const listings = [
      "/api/v1/follow_requests",
      `/api/v1/lists/${list.id}/accounts`,
      "/api/v1/endorsements",
      `/api/v1/statuses/${status.id}/favourited_by`,
    ];
    for (const path of listings) {
      expect(await idsAt(path, me), path).toContain(otherId);
    }
    const senders = async () =>
      read(
        z.array(z.object({ account: z.object({ id: z.string() }) })),
        await get("/api/v1/notifications", me),
      ).map((notification) => notification.account.id);
    expect(await senders()).toContain(otherId);
    const groupedSenders = async () =>
      read(
        z.object({
          accounts: Ids,
          notification_groups: z.array(z.object({ sample_account_ids: z.array(z.string()) })),
        }),
        await get("/api/v2/notifications", me),
      );
    expect((await groupedSenders()).accounts.map((account) => account.id)).toContain(otherId);

    await suspend(otherId);

    for (const path of listings) {
      expect(await idsAt(path, me), path).not.toContain(otherId);
    }
    expect(await senders()).not.toContain(otherId);
    const grouped = await groupedSenders();
    expect(grouped.accounts.map((account) => account.id)).not.toContain(otherId);
    expect(grouped.notification_groups.flatMap((group) => group.sample_account_ids)).not.toContain(
      otherId,
    );
  });

  it("is left out of blocks and mutes", async () => {
    const me = "blocks-owner@example.com";
    const blockedId = await accountIdOf("blocks-suspended@example.com");
    const mutedId = await accountIdOf("mutes-suspended@example.com");
    await post(me, `/api/v1/accounts/${blockedId}/block`);
    await post(me, `/api/v1/accounts/${mutedId}/mute`);
    expect(await idsAt("/api/v1/blocks", me)).toContain(blockedId);
    expect(await idsAt("/api/v1/mutes", me)).toContain(mutedId);

    await suspend(blockedId);
    await suspend(mutedId);

    expect(await idsAt("/api/v1/blocks", me)).not.toContain(blockedId);
    expect(await idsAt("/api/v1/mutes", me)).not.toContain(mutedId);
  });
});

const acceptedFollow = async (email: string, remote: Remote, slug: string) => {
  await post(email, `/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/follow`);
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

describe("a suspended remote actor", () => {
  it("has no statuses and is left out of favourited_by and endorsements", async () => {
    const me = "remote-sus-viewer@example.com";
    const remote = await remoteActor("sus-remote", "sus-remote.example");
    const remoteId = RemoteAccountId.encode(remote.actorUri);
    await acceptedFollow(me, remote, "sus-remote");
    const noteUri = "https://sus-remote.example/notes/one";
    expect(
      await remote.send({
        id: `${noteUri}/activity`,
        type: "Create",
        object: {
          id: noteUri,
          type: "Note",
          attributedTo: remote.actorUri,
          content: "<p>one</p>",
          published: "2026-10-20T00:00:00.000Z",
          to: [PUBLIC],
          cc: [`${remote.actorUri}/followers`],
        },
      }),
    ).toBe(202);
    const status = read(
      z.object({ id: z.string() }),
      await post(me, "/api/v1/statuses", { status: "like me" }),
    );
    const meId = await accountIdOf(me);
    expect(
      await remote.send({
        id: `${remote.actorUri}/likes/one`,
        type: "Like",
        object: `https://example.com/users/${(await signedInAccount(me)).username}/statuses/${status.id}`,
      }),
    ).toBe(202);
    await post(me, `/api/v1/accounts/${remoteId}/endorse`);

    expect((await idsAt(`/api/v1/accounts/${remoteId}/statuses`, me)).length).toBeGreaterThan(0);
    expect(await idsAt(`/api/v1/statuses/${status.id}/favourited_by`, me)).toContain(remoteId);
    expect(await idsAt(`/api/v1/accounts/${meId}/endorsements`)).toContain(remoteId);

    await suspend(remoteId);

    expect(await idsAt(`/api/v1/accounts/${remoteId}/statuses`, me)).toEqual([]);
    expect(await idsAt(`/api/v1/statuses/${status.id}/favourited_by`, me)).not.toContain(remoteId);
    expect(await idsAt(`/api/v1/accounts/${meId}/endorsements`)).not.toContain(remoteId);
  });
});

const favouritedBy = async (liker: string, author: string, times: number) => {
  for (let index = 0; index < times; index += 1) {
    const status = read(
      z.object({ id: z.string() }),
      await post(author, "/api/v1/statuses", { status: `like ${index}` }),
    );
    await post(liker, `/api/v1/statuses/${status.id}/favourite`);
  }
};

describe("notification pages around hidden senders", () => {
  it("keep paging past newest notifications from a suspended sender", async () => {
    const me = "paging-owner@example.com";
    const kept = "paging-kept@example.com";
    const gone = "paging-gone@example.com";
    const keptId = await accountIdOf(kept);
    const goneId = await accountIdOf(gone);
    await favouritedBy(kept, me, 1);
    await favouritedBy(gone, me, 4);
    await suspend(goneId);

    const v1 = await SELF.fetch("https://example.com/api/v1/notifications?limit=1", {
      headers: await authHeaders(me),
    });
    expect(v1.status).toBe(200);
    expect(await v1.json()).toEqual([]);
    expect(v1.headers.get("link") ?? "").toContain('rel="next"');

    const v2 = read(
      z.object({
        notification_groups: z.array(z.object({ sample_account_ids: z.array(z.string()) })),
      }),
      await get("/api/v2/notifications?limit=1", me),
    );
    expect(v2.notification_groups.flatMap((group) => group.sample_account_ids)).toEqual([keptId]);
  });
});

const ReportNotifications = z.array(
  z.object({
    type: z.string(),
    report: z.object({ target_account: AccountSchema }).optional(),
  }),
);

describe("a report against an account on a suspended domain", () => {
  it("keeps its admin.report notification with the target stripped", async () => {
    const remote = await remoteActor("reported", "reported-domain.example");
    const remoteId = RemoteAccountId.encode(remote.actorUri);
    const moderator = "report-domain-admin@example.com";
    await signedInAccount(moderator, { admin: true });
    await post("report-domain-reporter@example.com", "/api/v1/reports", {
      account_id: remoteId,
      category: "spam",
    });
    const reports = async () =>
      read(
        ReportNotifications,
        await (async () => {
          const response = await json("/api/v1/notifications?types[]=admin.report", {
            headers: await authHeaders(moderator, { admin: true }),
          });
          expect(response.status).toBe(200);
          return response.body;
        })(),
      );
    expect((await reports()).map((entry) => entry.report?.target_account.id)).toEqual([remoteId]);

    const blocked = await json("/api/v1/admin/domain_blocks", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await admin()) },
      body: JSON.stringify({ domain: "reported-domain.example", severity: "suspend" }),
    });
    expect(blocked.status).toBe(200);

    const [entry, ...rest] = await reports();
    expect(rest).toEqual([]);
    expect(entry?.report?.target_account).toMatchObject({
      id: remoteId,
      suspended: true,
      display_name: "",
    });
  });
});

describe("a storage error while presenting accounts", () => {
  it("answers 500 instead of leaving the accounts out", async () => {
    const me = "storage-error-owner@example.com";
    const viewer = await signedInAccount(me);
    const remote = await remoteActor("storage-error-follower", "storage-error.example");
    expect(
      await remote.send({
        id: `${remote.actorUri}/follows/storage-error`,
        type: "Follow",
        object: `https://example.com/users/${viewer.username}`,
      }),
    ).toBe(202);
    const followers = `/api/v1/accounts/${viewer.id}/followers`;
    expect(await idsAt(followers, me)).toEqual([RemoteAccountId.encode(remote.actorUri)]);
    expect((await idsAt("/api/v1/notifications", me)).length).toBe(1);
    await env.DB.exec("ALTER TABLE remote_actor_moderation RENAME TO remote_actor_moderation_off");
    try {
      for (const path of [followers, "/api/v1/notifications", "/api/v2/notifications"]) {
        const response = await json(path, { headers: await authHeaders(me) });
        expect(response.status, path).toBe(500);
      }
    } finally {
      await env.DB.exec("ALTER TABLE remote_actor_moderation_off RENAME TO remote_actor_moderation");
    }
  });
});
