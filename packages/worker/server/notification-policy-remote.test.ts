import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";

// Mastodon's `NotifyService` applies the recipient's notification policy to
// every sender, remote ones included (`DropCondition`, `FilterCondition`).

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();

const send = async (email: string, method: string, path: string, body?: unknown) => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status).toBe(200);
  return response.json();
};

const Account = z.object({ id: z.string(), username: z.string() });
const Policy = z.object({
  for_private_mentions: z.string(),
  summary: z.object({
    pending_requests_count: z.number(),
    pending_notifications_count: z.number(),
  }),
});

const local = async (email: string) => {
  const account = Account.parse(await send(email, "GET", "/api/v1/accounts/verify_credentials"));
  return { email, ...account, url: `https://example.com/users/${account.username}` };
};
type Local = Awaited<ReturnType<typeof local>>;

/** What became of the notifications sent to `recipient`: those listed and those held as requests. */
const outcome = async (recipient: Local) => {
  const listed = z
    .array(z.object({ type: z.string() }))
    .parse(await send(recipient.email, "GET", "/api/v1/notifications"));
  const policy = Policy.parse(await send(recipient.email, "GET", "/api/v2/notifications/policy"));
  return { listed: listed.length, held: policy.summary.pending_notifications_count };
};

const NOTIFIED = { listed: 1, held: 0 };
const HELD = { listed: 0, held: 1 };
const DROPPED = { listed: 0, held: 0 };

const mention = async (
  sender: Remote,
  recipient: Local,
  slug: string,
  note: Record<string, unknown> = {},
): Promise<void> => {
  const origin = new URL(sender.actorUri).origin;
  expect(
    await sender.send({
      id: `${origin}/activities/create-${slug}`,
      type: "Create",
      object: {
        id: `${origin}/notes/${slug}`,
        type: "Note",
        attributedTo: sender.actorUri,
        content: `<p>${slug}</p>`,
        published: new Date().toISOString(),
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        cc: [recipient.url],
        tag: [{ type: "Mention", href: recipient.url }],
        ...note,
      },
    }),
  ).toBe(202);
};

const directMessage = (
  sender: Remote,
  recipient: Local,
  slug: string,
  note: Record<string, unknown> = {},
): Promise<void> => mention(sender, recipient, slug, { to: [recipient.url], cc: [], ...note });

/** The recipient's accepted follow of a remote account. */
const follows = async (recipient: Local, followed: Remote, slug: string): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO outbound_follows (id, account_id, actor_uri, follow_activity_id, state)
     VALUES (?, ?, ?, ?, 'Accepted')`,
  )
    .bind(slug, recipient.id, followed.actorUri, `https://example.com/follows/${slug}`)
    .run();
};

/** A remote account's follow of the recipient, accepted `days` ago. */
const followedBy = async (recipient: Local, follower: Remote, days: number): Promise<void> => {
  expect(
    await follower.send({
      id: `${follower.actorUri}/follows/1`,
      type: "Follow",
      object: recipient.url,
    }),
  ).toBe(202);
  await env.DB.prepare(
    "UPDATE remote_follows SET created_at = ? WHERE remote_actor_uri = ? AND target_account_id = ?",
  )
    .bind(daysAgo(days), follower.actorUri, recipient.id)
    .run();
  // The follow notification is not what these tests count.
  await send(recipient.email, "POST", "/api/v1/notifications/clear");
};

const firstSeen = (actor: Remote, days: number) =>
  env.DB.prepare("UPDATE remote_actors SET created_at = ? WHERE actor_uri = ?")
    .bind(daysAgo(days), actor.actorUri)
    .run();

const setPolicy = (recipient: Local, policy: Record<string, string>) =>
  send(recipient.email, "PATCH", "/api/v2/notifications/policy", policy);

describe("a remote stranger's direct message", () => {
  it("waits in a notification request by default", async () => {
    const recipient = await local("np-remote-default@example.com");
    const stranger = await remoteActor("np-default-stranger");
    expect(
      Policy.parse(await send(recipient.email, "GET", "/api/v2/notifications/policy"))
        .for_private_mentions,
    ).toBe("filter");

    await directMessage(stranger, recipient, "np-default");
    expect(await outcome(recipient)).toEqual(HELD);
    const requests = z
      .array(z.object({ account: z.object({ acct: z.string() }), notifications_count: z.string() }))
      .parse(await send(recipient.email, "GET", "/api/v1/notifications/requests"));
    expect(requests).toEqual([
      { account: { acct: "np-default-stranger@remote.example" }, notifications_count: "1" },
    ]);
  });

  it("is dropped or notified as `for_private_mentions` says", async () => {
    const recipient = await local("np-remote-choice@example.com");
    const stranger = await remoteActor("np-choice-stranger");

    await setPolicy(recipient, { for_private_mentions: "drop" });
    await directMessage(stranger, recipient, "np-choice-dropped");
    expect(await outcome(recipient)).toEqual(DROPPED);

    await setPolicy(recipient, { for_private_mentions: "accept" });
    await directMessage(stranger, recipient, "np-choice-accepted");
    expect(await outcome(recipient)).toEqual(NOTIFIED);
  });

  it("notifies when the recipient follows the sender", async () => {
    const recipient = await local("np-remote-followed@example.com");
    const friend = await remoteActor("np-followed-friend");
    await follows(recipient, friend, "np-followed");

    await directMessage(friend, recipient, "np-followed");
    expect(await outcome(recipient)).toEqual(NOTIFIED);
  });

  it("notifies when it answers the recipient's own direct message to the sender", async () => {
    const recipient = await local("np-remote-answer@example.com");
    const stranger = await remoteActor("np-answer-stranger");
    const opening = z
      .object({ uri: z.string(), mentions: z.array(z.object({ acct: z.string() })) })
      .parse(
        await send(recipient.email, "POST", "/api/v1/statuses", {
          status: "@np-answer-stranger@remote.example hello",
          visibility: "direct",
        }),
      );
    expect(opening.mentions).toEqual([{ acct: "np-answer-stranger@remote.example" }]);

    await directMessage(stranger, recipient, "np-answer", { inReplyTo: opening.uri });
    expect(await outcome(recipient)).toEqual(NOTIFIED);
  });

  it("waits when it answers a direct message that is not the recipient's", async () => {
    const recipient = await local("np-remote-other-thread@example.com");
    const stranger = await remoteActor("np-other-thread-stranger");
    await setPolicy(recipient, { for_private_mentions: "accept" });
    await directMessage(stranger, recipient, "np-other-thread-first");
    await send(recipient.email, "POST", "/api/v1/notifications/clear");
    await setPolicy(recipient, { for_private_mentions: "filter" });

    await directMessage(stranger, recipient, "np-other-thread-second", {
      inReplyTo: "https://remote.example/notes/np-other-thread-first",
    });
    expect(await outcome(recipient)).toEqual(HELD);
  });

  it("is a public mention to the other categories, which leave it alone", async () => {
    const recipient = await local("np-remote-public@example.com");
    const stranger = await remoteActor("np-public-stranger");
    await firstSeen(stranger, 60);

    await mention(stranger, recipient, "np-public");
    expect(await outcome(recipient)).toEqual(NOTIFIED);
  });
});

describe("the notification policy for a remote sender", () => {
  it("applies `for_not_following` only to a sender the recipient does not follow", async () => {
    const recipient = await local("np-remote-not-following@example.com");
    const friend = await remoteActor("np-not-following-friend");
    const stranger = await remoteActor("np-not-following-stranger");
    await follows(recipient, friend, "np-not-following");
    await setPolicy(recipient, { for_not_following: "filter" });

    await mention(friend, recipient, "np-not-following-friend");
    expect(await outcome(recipient)).toEqual(NOTIFIED);
    await mention(stranger, recipient, "np-not-following-stranger");
    expect(await outcome(recipient)).toEqual({ listed: 1, held: 1 });
  });

  it("counts a follower of less than three days as no follower", async () => {
    const recipient = await local("np-remote-not-follower@example.com");
    const recent = await remoteActor("np-recent-follower");
    const established = await remoteActor("np-established-follower");
    await followedBy(recipient, recent, 1);
    await followedBy(recipient, established, 4);
    await setPolicy(recipient, { for_not_followers: "filter" });

    await mention(established, recipient, "np-established");
    expect(await outcome(recipient)).toEqual(NOTIFIED);
    await mention(recent, recipient, "np-recent");
    expect(await outcome(recipient)).toEqual({ listed: 1, held: 1 });
  });

  it("applies `for_new_accounts` to an account published in the last thirty days", async () => {
    const recipient = await local("np-remote-new-account@example.com");
    const old = await remoteActor("np-old-account", "remote.example", { published: daysAgo(400) });
    const oldUndated = await remoteActor("np-old-undated-account");
    const fresh = await remoteActor("np-new-account", "remote.example", { published: daysAgo(2) });
    const freshUndated = await remoteActor("np-new-undated-account");
    const freshFriend = await remoteActor("np-new-friend", "remote.example", {
      published: daysAgo(2),
    });
    // An old account seen here for the first time is not new; without a
    // `published` date, the time this server first stored it stands in.
    await firstSeen(fresh, 60);
    await firstSeen(oldUndated, 31);
    await follows(recipient, freshFriend, "np-new-friend");
    await setPolicy(recipient, { for_new_accounts: "filter" });

    await mention(old, recipient, "np-old-account");
    await mention(oldUndated, recipient, "np-old-undated-account");
    await mention(freshFriend, recipient, "np-new-friend");
    expect(await outcome(recipient)).toEqual({ listed: 3, held: 0 });
    await mention(fresh, recipient, "np-new-account");
    await mention(freshUndated, recipient, "np-new-undated-account");
    expect(await outcome(recipient)).toEqual({ listed: 3, held: 2 });
  });
});
