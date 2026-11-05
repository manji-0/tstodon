import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
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

const NotificationSchema = z.object({
  id: z.string(),
  type: z.string(),
  account: z.object({ id: z.string(), acct: z.string() }),
  status: z.object({ id: z.string() }).nullable(),
});

const notifications = async (email: string) =>
  read(
    z.array(NotificationSchema),
    (await json("/api/v1/notifications", { headers: await authHeaders(email) })).body,
  );

const me = async (email: string) =>
  read(
    z.object({ id: z.string(), username: z.string() }),
    (await json("/api/v1/accounts/verify_credentials", { headers: await authHeaders(email) })).body,
  );

const post = async (email: string, status: string) =>
  read(
    z.object({ id: z.string(), uri: z.string() }),
    (
      await json("/api/v1/statuses", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeaders(email)) },
        body: JSON.stringify({ status }),
      })
    ).body,
  );

describe("notifications from remote actors", () => {
  it("notifies a remote Like and Announce once, with the remote account", async () => {
    const email = "remote-notify-author@example.com";
    const status = await post(email, "like me from afar");
    const remote = await remoteActor("liker");
    const like = {
      id: "https://remote.example/activities/like-1",
      type: "Like",
      object: status.uri,
    };
    expect(await remote.send(like)).toBe(202);
    // A redelivery must not notify again.
    expect(await remote.send(like)).toBe(202);
    const announce = {
      id: "https://remote.example/activities/announce-1",
      type: "Announce",
      object: status.uri,
    };
    expect(await remote.send(announce)).toBe(202);
    expect(await remote.send(announce)).toBe(202);

    const listed = await notifications(email);
    const remoteId = RemoteAccountId.encode(remote.actorUri);
    const favourites = listed.filter((entry) => entry.type === "favourite");
    const reblogs = listed.filter((entry) => entry.type === "reblog");
    expect(favourites).toHaveLength(1);
    expect(reblogs).toHaveLength(1);
    expect(favourites[0]?.account).toEqual({ id: remoteId, acct: "liker@remote.example" });
    expect(favourites[0]?.status?.id).toBe(status.id);

    // The grouped v2 list resolves the remote account too.
    const grouped = await json("/api/v2/notifications", {
      headers: await authHeaders(email),
    });
    const page = read(
      z.object({
        accounts: z.array(z.object({ id: z.string() })),
        notification_groups: z.array(
          z.object({ type: z.string(), sample_account_ids: z.array(z.string()) }),
        ),
      }),
      grouped.body,
    );
    expect(page.accounts.map((account) => account.id)).toContain(remoteId);
    expect(
      page.notification_groups.find((group) => group.type === "favourite")?.sample_account_ids,
    ).toEqual([remoteId]);
  });

  it("notifies a remote Follow, as a request for a locked account", async () => {
    const open = "remote-notify-open@example.com";
    const locked = "remote-notify-locked@example.com";
    const openAccount = await me(open);
    const lockedAccount = await me(locked);
    expect(
      (
        await json("/api/v1/accounts/update_credentials", {
          method: "PATCH",
          headers: { "content-type": "application/json", ...(await authHeaders(locked)) },
          body: JSON.stringify({ locked: true }),
        })
      ).status,
    ).toBe(200);
    const remote = await remoteActor("follower");
    const follow = (username: string, n: number) => ({
      id: `https://remote.example/activities/follow-${username}-${n}`,
      type: "Follow",
      object: `https://example.com/users/${username}`,
    });
    expect(await remote.send(follow(openAccount.username, 1))).toBe(202);
    expect(await remote.send(follow(openAccount.username, 2))).toBe(202);
    expect(await remote.send(follow(lockedAccount.username, 1))).toBe(202);

    expect((await notifications(open)).map((entry) => entry.type)).toEqual(["follow"]);
    expect((await notifications(locked)).map((entry) => entry.type)).toEqual(["follow_request"]);
  });

  it("drops notifications from blocked actors and domains, and hides earlier ones", async () => {
    const email = "remote-notify-blocker@example.com";
    const status = await post(email, "keep away");
    const pest = await remoteActor("pest");
    const pestId = RemoteAccountId.encode(pest.actorUri);
    expect(
      await pest.send({
        id: "https://remote.example/activities/pest-like",
        type: "Like",
        object: status.uri,
      }),
    ).toBe(202);
    expect((await notifications(email)).map((entry) => entry.account.id)).toEqual([pestId]);

    // Blocking hides what already arrived, and nothing new is created.
    expect(
      (
        await json(`/api/v1/accounts/${pestId}/block`, {
          method: "POST",
          headers: await authHeaders(email),
        })
      ).status,
    ).toBe(200);
    expect(await notifications(email)).toEqual([]);
    expect(
      await pest.send({
        id: "https://remote.example/activities/pest-announce",
        type: "Announce",
        object: status.uri,
      }),
    ).toBe(202);
    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE from_actor_uri = ? AND kind = 'reblog'",
    )
      .bind(pest.actorUri)
      .first<{ n: number }>();
    expect(stored?.n).toBe(0);

    // The remote block is listed, reported in the relationship, and can be lifted.
    const blocks = await json("/api/v1/blocks", { headers: await authHeaders(email) });
    expect(
      read(z.array(z.object({ id: z.string() })), blocks.body).map((account) => account.id),
    ).toEqual([pestId]);
    const unblocked = await json(`/api/v1/accounts/${pestId}/unblock`, {
      method: "POST",
      headers: await authHeaders(email),
    });
    expect(read(z.object({ id: z.string(), blocking: z.boolean() }), unblocked.body)).toEqual({
      id: pestId,
      blocking: false,
    });
    expect((await notifications(email)).map((entry) => entry.account.id)).toEqual([pestId]);

    // Muting notifications hides them the same way; a plain mute does not.
    const muted = await json(`/api/v1/accounts/${pestId}/mute`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(email)) },
      body: JSON.stringify({ notifications: true }),
    });
    expect(read(z.object({ muting: z.boolean() }), muted.body).muting).toBe(true);
    expect(await notifications(email)).toEqual([]);
    const mutes = await json("/api/v1/mutes", { headers: await authHeaders(email) });
    expect(
      read(z.array(z.object({ id: z.string() })), mutes.body).map((account) => account.id),
    ).toEqual([pestId]);

    // A blocked domain sends nothing either.
    const other = "remote-notify-domain@example.com";
    const otherStatus = await post(other, "no remote.example please");
    expect(
      (
        await json("/api/v1/domain_blocks", {
          method: "POST",
          headers: { "content-type": "application/json", ...(await authHeaders(other)) },
          body: JSON.stringify({ domain: "remote.example" }),
        })
      ).status,
    ).toBe(200);
    const neighbour = await remoteActor("neighbour");
    expect(
      await neighbour.send({
        id: "https://remote.example/activities/neighbour-like",
        type: "Like",
        object: otherStatus.uri,
      }),
    ).toBe(202);
    expect(await notifications(other)).toEqual([]);
  });

  it("notifies from a followed actor on a blocked domain, as Mastodon's domain_blocking? && not_following?", async () => {
    const email = "remote-notify-domain-follower@example.com";
    const headers = { "content-type": "application/json", ...(await authHeaders(email)) };
    const status = await post(email, "followed across a domain block");
    const friend = await remoteActor("friend", "blocked-but-followed.example");
    expect(
      (
        await json("/api/v1/domain_blocks", {
          method: "POST",
          headers,
          body: JSON.stringify({ domain: "blocked-but-followed.example" }),
        })
      ).status,
    ).toBe(200);
    // The block severs every follow with the domain (#60, #67), so the follow
    // is written after it, as one accepted before a queued page severs it.
    const account = await me(email);
    await env.DB.prepare(
      `INSERT INTO outbound_follows (id, account_id, actor_uri, follow_activity_id, state)
       VALUES ('blocked-but-followed', ?, ?, 'https://example.com/follows/blocked-but-followed', 'Accepted')`,
    )
      .bind(account.id, friend.actorUri)
      .run();
    const stranger = await remoteActor("stranger", "blocked-but-followed.example");

    for (const [sender, slug] of [
      [friend, "friend-like"],
      [stranger, "stranger-like"],
    ] as const) {
      expect(
        await sender.send({
          id: `https://blocked-but-followed.example/activities/${slug}`,
          type: "Like",
          object: status.uri,
        }),
      ).toBe(202);
    }

    const stored = await env.DB.prepare(
      "SELECT from_actor_uri FROM notifications WHERE kind = 'favourite' AND from_actor_uri LIKE 'https://blocked-but-followed.example/%'",
    ).all<{ from_actor_uri: string }>();
    expect(stored.results.map((row) => row.from_actor_uri)).toEqual([friend.actorUri]);
  });

  it("matches a domain block on the account domain, not the actor URI's host, as Mastodon's account.domain", async () => {
    // A WebFinger domain that serves its actors from another host (#70).
    const remote = await remoteActor("split", "social.split-host.example", {
      accountDomain: "split-host.example",
    });
    const remoteId = RemoteAccountId.encode(remote.actorUri);
    const cases = [
      { email: "split-domain-account@example.com", blocked: "split-host.example", hit: true },
      { email: "split-domain-uri@example.com", blocked: "social.split-host.example", hit: false },
    ] as const;
    for (const [n, { email, blocked, hit }] of cases.entries()) {
      const headers = { "content-type": "application/json", ...(await authHeaders(email)) };
      const status = await post(email, `split host ${n}`);
      expect(
        (
          await json("/api/v1/domain_blocks", {
            method: "POST",
            headers,
            body: JSON.stringify({ domain: blocked }),
          })
        ).status,
      ).toBe(200);
      expect(
        await remote.send({
          id: `https://social.split-host.example/activities/split-like-${n}`,
          type: "Like",
          object: status.uri,
        }),
      ).toBe(202);
      const relationships = await json(`/api/v1/accounts/relationships?id[]=${remoteId}`, {
        headers,
      });
      expect({
        blocked,
        notified: (await notifications(email)).map((entry) => entry.type),
        domainBlocking: read(
          z.array(z.object({ domain_blocking: z.boolean() })),
          relationships.body,
        )[0]?.domain_blocking,
      }).toEqual({ blocked, notified: hit ? [] : ["favourite"], domainBlocking: hit });
    }
  });

  it("drops a remote mention alongside a blocked actor or replying to a blocked author, as blocked_mention?", async () => {
    const email = "remote-blocked-mention@example.com";
    const headers = { "content-type": "application/json", ...(await authHeaders(email)) };
    const account = await me(email);
    const actorUrl = `https://example.com/users/${account.username}`;
    const blockedLocalEmail = "remote-blocked-mention-local@example.com";
    const blockedLocal = await me(blockedLocalEmail);
    const parent = await post(blockedLocalEmail, "a post the reader will not see");
    const mentioner = await remoteActor("blocked-mention-sender", "mentions.example");
    const blockedRemote = await remoteActor("blocked-mention-target", "mentions.example");
    const block = (id: string, action: string) =>
      json(`/api/v1/accounts/${id}/${action}`, { method: "POST", headers, body: "{}" });
    // Known to the instance before it can be blocked.
    expect(
      await blockedRemote.send({
        id: "https://mentions.example/activities/blocked-target-like",
        type: "Like",
        object: parent.uri,
      }),
    ).toBe(202);
    expect((await block(RemoteAccountId.encode(blockedRemote.actorUri), "block")).status).toBe(200);
    expect((await block(blockedLocal.id, "block")).status).toBe(200);
    const mention = { type: "Mention", href: actorUrl, name: `@${account.username}@example.com` };
    const note = (n: number, extra: Record<string, unknown>) => ({
      id: `https://mentions.example/activities/create-${n}`,
      type: "Create",
      object: {
        id: `https://mentions.example/notes/${n}`,
        type: "Note",
        attributedTo: mentioner.actorUri,
        content: `<p>note ${n}</p>`,
        published: "2026-10-20T00:00:00.000Z",
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        ...extra,
      },
    });

    expect(
      await mentioner.send(
        note(1, {
          tag: [mention, { type: "Mention", href: blockedRemote.actorUri, name: "@target" }],
        }),
      ),
    ).toBe(202);
    expect(await mentioner.send(note(2, { tag: [mention], inReplyTo: parent.uri }))).toBe(202);
    expect(await mentioner.send(note(3, { tag: [mention] }))).toBe(202);

    const listed = await notifications(email);
    const mentions = listed.filter((entry) => entry.type === "mention");
    expect(mentions).toHaveLength(1);
    const delivered = await env.DB.prepare("SELECT object_uri FROM remote_statuses WHERE id = ?")
      .bind(mentions[0]?.status?.id ?? "")
      .first<{ object_uri: string }>();
    expect(delivered?.object_uri).toBe("https://mentions.example/notes/3");
  });

  it("notifies a mention in a new remote note, once", async () => {
    const email = "remote-notify-mentioned@example.com";
    const account = await me(email);
    const actorUrl = `https://example.com/users/${account.username}`;
    const remote = await remoteActor("mentioner");
    const note = (n: number, extra: Record<string, unknown>) => ({
      id: `https://remote.example/activities/create-${n}`,
      type: "Create",
      object: {
        id: `https://remote.example/notes/${n}`,
        type: "Note",
        attributedTo: remote.actorUri,
        content: `<p>note ${n}</p>`,
        published: "2026-10-20T00:00:00.000Z",
        ...extra,
      },
    });
    // A direct message addressed to the local account, with a Mention tag.
    const direct = note(1, {
      to: [actorUrl],
      tag: [{ type: "Mention", href: actorUrl, name: `@${account.username}@example.com` }],
    });
    expect(await remote.send(direct)).toBe(202);
    expect(await remote.send(direct)).toBe(202);
    // A public note that only names someone else, and one that names a status URL.
    expect(
      await remote.send(
        note(2, {
          to: ["https://www.w3.org/ns/activitystreams#Public"],
          tag: [{ type: "Mention", href: "https://remote.example/users/someone" }],
        }),
      ),
    ).toBe(202);
    expect(
      await remote.send(
        note(3, {
          to: ["https://www.w3.org/ns/activitystreams#Public"],
          tag: [{ type: "Mention", href: `${actorUrl}/statuses/1` }],
        }),
      ),
    ).toBe(202);

    const listed = await notifications(email);
    expect(listed.map((entry) => entry.type)).toEqual(["mention"]);
    const mention = listed[0];
    expect(mention?.account.id).toBe(RemoteAccountId.encode(remote.actorUri));
    // The direct remote status renders for the account it mentions.
    const stored = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
      .bind("https://remote.example/notes/1")
      .first<{ id: string }>();
    expect(mention?.status?.id).toBe(stored?.id);

    // An Announce of a remote note does not count as a mention.
    expect(
      await remote.send({
        id: "https://remote.example/activities/announce-note-4",
        type: "Announce",
        object: {
          id: "https://remote.example/notes/4",
          type: "Note",
          attributedTo: remote.actorUri,
          content: "<p>boosted</p>",
          published: "2026-10-20T00:00:00.000Z",
          to: [actorUrl],
        },
      }),
    ).toBe(202);
    expect((await notifications(email)).map((entry) => entry.type)).toEqual(["mention"]);
  });

  it("withdraws notifications when the activity is undone or the note deleted", async () => {
    const email = "remote-notify-undo@example.com";
    const account = await me(email);
    const actorUrl = `https://example.com/users/${account.username}`;
    const status = await post(email, "undo me");
    const remote = await remoteActor("undoer");
    const like = {
      id: "https://remote.example/activities/undo-like",
      type: "Like",
      object: status.uri,
    };
    const announce = {
      id: "https://remote.example/activities/undo-announce",
      type: "Announce",
      object: status.uri,
    };
    const follow = {
      id: "https://remote.example/activities/undo-follow",
      type: "Follow",
      object: actorUrl,
    };
    const noteUri = "https://remote.example/notes/undo-mention";
    for (const activity of [like, announce, follow]) {
      expect(await remote.send(activity)).toBe(202);
    }
    expect(
      await remote.send({
        id: "https://remote.example/activities/create-undo-mention",
        type: "Create",
        object: {
          id: noteUri,
          type: "Note",
          attributedTo: remote.actorUri,
          content: "<p>hi</p>",
          published: "2026-10-20T00:00:00.000Z",
          to: [actorUrl],
        },
      }),
    ).toBe(202);
    expect((await notifications(email)).map((entry) => entry.type).toSorted()).toEqual([
      "favourite",
      "follow",
      "mention",
      "reblog",
    ]);

    const undo = (activity: Record<string, unknown>, n: string) =>
      remote.send({
        id: `https://remote.example/activities/undo-${n}`,
        type: "Undo",
        object: activity,
      });
    expect(await undo(like, "1")).toBe(202);
    expect((await notifications(email)).map((entry) => entry.type).toSorted()).toEqual([
      "follow",
      "mention",
      "reblog",
    ]);
    expect(await undo(announce, "2")).toBe(202);
    expect(await undo(follow, "3")).toBe(202);
    expect((await notifications(email)).map((entry) => entry.type)).toEqual(["mention"]);
    expect(
      await remote.send({
        id: "https://remote.example/activities/delete-undo-mention",
        type: "Delete",
        object: noteUri,
      }),
    ).toBe(202);
    expect(await notifications(email)).toEqual([]);
  });

  it("removes a purged local sender's notifications", async () => {
    const author = "remote-notify-purge-author@example.com";
    const status = await post(author, "fave this");
    const fan = await me("remote-notify-purge-fan@example.com");
    expect(
      (
        await json(`/api/v1/statuses/${status.id}/favourite`, {
          method: "POST",
          headers: await authHeaders("remote-notify-purge-fan@example.com"),
        })
      ).status,
    ).toBe(200);
    expect((await notifications(author)).map((entry) => entry.account.id)).toEqual([fan.id]);
    await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(fan.id).run();
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE from_account_id = ?",
    )
      .bind(fan.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
