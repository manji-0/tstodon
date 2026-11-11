import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { notifyAccount } from "./notify";

/** Accounts signed in as admins; every request they make keeps the role. */
const admins = new Set<string>();

const call = async (
  email: string,
  path: string,
  init: Readonly<{ method?: string; body?: Record<string, unknown> }> = {},
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(await authHeaders(email, { admin: admins.has(email) })),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const contentType = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    body: contentType.includes("json") ? await response.json() : await response.text(),
  };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const post = async (email: string, body: Record<string, unknown>): Promise<string> => {
  const response = await call(email, "/api/v1/statuses", { method: "POST", body });
  expect(response.status).toBe(200);
  return read(z.object({ id: z.string() }), response.body).id;
};

const notificationTypesFrom = async (email: string, senderId: string): Promise<string[]> => {
  const response = await call(email, "/api/v1/notifications");
  expect(response.status).toBe(200);
  return read(
    z.array(z.object({ type: z.string(), account: z.object({ id: z.string() }) })),
    response.body,
  )
    .filter((notification) => notification.account.id === senderId)
    .map((notification) => notification.type);
};

const person = async (email: string, options: Readonly<{ admin?: boolean }> = {}) => {
  if (options.admin) {
    admins.add(email);
  }
  const account = await signedInAccount(email, { admin: admins.has(email) });
  return { email, id: account.id, username: account.username };
};

const relate = async (email: string, targetId: string, action: string, body = {}) =>
  expect(
    (await call(email, `/api/v1/accounts/${targetId}/${action}`, { method: "POST", body })).status,
  ).toBe(200);

// The notification list hides senders the reader blocks or mutes, so each case
// lifts the block or mute again before reading: what was silenced must never
// have been recorded, as with Mastodon's NotifyService.
describe("notifications from a silenced sender", () => {
  it("records no quoted_update from an author the quoter blocks", async () => {
    const author = await person("silence-quote-author@example.com");
    const quoter = await person("silence-quote-quoter@example.com");
    const original = await post(author.email, { status: "quote me" });
    await post(quoter.email, { status: "quoting", quoted_status_id: original });

    await relate(quoter.email, author.id, "block");
    const edited = await call(author.email, `/api/v1/statuses/${original}`, {
      method: "PUT",
      body: { status: "quote me, edited" },
    });
    expect(edited.status).toBe(200);
    await relate(quoter.email, author.id, "unblock");

    expect(await notificationTypesFrom(quoter.email, author.id)).not.toContain("quoted_update");
  });

  it("records no status, mention or reblog from an author whose notifications are muted", async () => {
    const author = await person("silence-mute-author@example.com");
    const reader = await person("silence-mute-reader@example.com");
    const own = await post(reader.email, { status: "boost me" });
    await relate(reader.email, author.id, "follow", { notify: true });

    await relate(reader.email, author.id, "mute", { notifications: true });
    await post(author.email, { status: "a post the follower asked to hear about" });
    await post(author.email, { status: `hello @${reader.username}` });
    expect(
      (await call(author.email, `/api/v1/statuses/${own}/reblog`, { method: "POST" })).status,
    ).toBe(200);
    await relate(reader.email, author.id, "unmute");

    expect(await notificationTypesFrom(reader.email, author.id)).toEqual([]);

    // The same activity from an unmuted author is delivered.
    await post(author.email, { status: `hello again @${reader.username}` });
    expect(await notificationTypesFrom(reader.email, author.id)).toEqual(
      expect.arrayContaining(["status", "mention"]),
    );
  });

  it("records a mention from staff the recipient blocks or mutes, as Mastodon's from_staff?", async () => {
    const moderator = await person("silence-staff-admin@example.com", { admin: true });
    const reader = await person("silence-staff-reader@example.com");

    await relate(reader.email, moderator.id, "block");
    await post(moderator.email, { status: `a word from the staff @${reader.username}` });
    await relate(reader.email, moderator.id, "unblock");
    expect(await notificationTypesFrom(reader.email, moderator.id)).toEqual(["mention"]);

    await relate(reader.email, moderator.id, "mute", { notifications: true });
    await post(moderator.email, { status: `another word @${reader.username}` });
    await relate(reader.email, moderator.id, "unmute");
    expect(await notificationTypesFrom(reader.email, moderator.id)).toEqual(["mention", "mention"]);

    // Only a mention gets through: the blocked moderator cannot even see the
    // reader's status to reblog it (`StatusPolicy#show?`).
    const own = await post(reader.email, { status: "boost me" });
    await relate(reader.email, moderator.id, "block");
    expect(
      (await call(moderator.email, `/api/v1/statuses/${own}/reblog`, { method: "POST" })).status,
    ).toBe(404);
    await relate(reader.email, moderator.id, "unblock");
    expect(await notificationTypesFrom(reader.email, moderator.id)).toEqual(["mention", "mention"]);
  });

  it("files a staff mention past the recipient's notification policy", async () => {
    const moderator = await person("silence-staff-policy-admin@example.com", { admin: true });
    const reader = await person("silence-staff-policy-reader@example.com");
    const policy = await call(reader.email, "/api/v2/notifications/policy", {
      method: "PATCH",
      body: { for_not_following: "filter" },
    });
    expect(policy.status).toBe(200);

    await post(moderator.email, { status: `please read this @${reader.username}` });

    expect(await notificationTypesFrom(reader.email, moderator.id)).toEqual(["mention"]);
  });

  it("drops a mention from an admin the admin recipient blocks: neither outranks the other", async () => {
    const sender = await person("silence-peer-admin-sender@example.com", { admin: true });
    const reader = await person("silence-peer-admin-reader@example.com", { admin: true });

    await relate(reader.email, sender.id, "block");
    await post(sender.email, { status: `between admins @${reader.username}` });
    await relate(reader.email, sender.id, "unblock");

    expect(await notificationTypesFrom(reader.email, sender.id)).toEqual([]);
  });
});

// Mastodon's `blocked_mention?` (`FeedManager#filter_from_mentions?`): a
// mention is dropped when the recipient blocks, or mutes notifications of, an
// account the post mentions or the author of the post it replies to.
describe("a mention involving an account the recipient silenced", () => {
  it("records no mention alongside an account the recipient blocks", async () => {
    const author = await person("blocked-mention-author@example.com");
    const reader = await person("blocked-mention-reader@example.com");
    const other = await person("blocked-mention-other@example.com");

    await relate(reader.email, other.id, "block");
    await post(author.email, { status: `hi @${reader.username} and @${other.username}` });
    await relate(reader.email, other.id, "unblock");
    expect(await notificationTypesFrom(reader.email, author.id)).toEqual([]);

    // The blocked account is not the reason the author is silenced.
    await post(author.email, { status: `hi again @${reader.username}` });
    expect(await notificationTypesFrom(reader.email, author.id)).toEqual(["mention"]);
  });

  it("records no mention alongside an account whose notifications the recipient mutes", async () => {
    const author = await person("muted-mention-author@example.com");
    const reader = await person("muted-mention-reader@example.com");
    const quiet = await person("muted-mention-quiet@example.com");
    const loud = await person("muted-mention-loud@example.com");

    await relate(reader.email, quiet.id, "mute", { notifications: true });
    await relate(reader.email, loud.id, "mute", { notifications: false });
    await post(author.email, { status: `hi @${reader.username} and @${quiet.username}` });
    // A mute that keeps notifications does not drop the mention.
    await post(author.email, { status: `hi @${reader.username} and @${loud.username}` });
    await relate(reader.email, quiet.id, "unmute");
    await relate(reader.email, loud.id, "unmute");

    expect(await notificationTypesFrom(reader.email, author.id)).toEqual(["mention"]);
  });

  it("records no mention in a reply to an author the recipient blocks", async () => {
    const author = await person("reply-mention-author@example.com");
    const reader = await person("reply-mention-reader@example.com");
    const blocked = await person("reply-mention-blocked@example.com");
    const parent = await post(blocked.email, { status: "a post the reader will not see" });

    await relate(reader.email, blocked.id, "block");
    await post(author.email, {
      status: `look at this @${reader.username}`,
      in_reply_to_id: parent,
    });
    await relate(reader.email, blocked.id, "unblock");

    expect(await notificationTypesFrom(reader.email, author.id)).toEqual([]);
  });

  it("records a staff mention alongside an account the recipient blocks, as from_staff?", async () => {
    const moderator = await person("blocked-mention-staff@example.com", { admin: true });
    const reader = await person("blocked-mention-staff-reader@example.com");
    const other = await person("blocked-mention-staff-other@example.com");

    await relate(reader.email, other.id, "block");
    await post(moderator.email, { status: `a word @${reader.username} @${other.username}` });
    await relate(reader.email, other.id, "unblock");

    expect(await notificationTypesFrom(reader.email, moderator.id)).toEqual(["mention"]);
  });
});

// Mastodon's `DropCondition#drop?` opens with `@recipient.unavailable?`: a
// suspended account is notified of nothing, its own kinds included.
describe("notifications to a suspended account", () => {
  it("records nothing while the account is suspended", async () => {
    const moderator = await person("suspended-recipient-admin@example.com", { admin: true });
    const author = await person("suspended-recipient-author@example.com");
    const reader = await person("suspended-recipient-reader@example.com");
    const own = await post(reader.email, { status: "favourite me" });
    const suspend = async (action: string, body?: Record<string, unknown>) =>
      expect(
        (
          await call(moderator.email, `/api/v1/admin/accounts/${reader.id}/${action}`, {
            method: "POST",
            ...(body ? { body } : {}),
          })
        ).status,
      ).toBe(200);

    await suspend("action", { type: "suspend" });
    await post(author.email, { status: `are you there @${reader.username}` });
    // A suspended author's status cannot be favourited through the API, so
    // these go straight to the notification path.
    for (const [fromAccountId, kind] of [
      [author.id, "favourite"],
      [reader.id, "poll"],
    ] as const) {
      expect(
        (
          await notifyAccount(env, { accountId: reader.id, fromAccountId, kind, statusId: own })
        ).isOk(),
      ).toBe(true);
    }
    await suspend("unsuspend");

    expect(await notificationTypesFrom(reader.email, author.id)).toEqual([]);
    expect(await notificationTypesFrom(reader.email, reader.id)).toEqual([]);

    // Once reinstated, the account is notified again.
    await post(author.email, { status: `welcome back @${reader.username}` });
    expect(await notificationTypesFrom(reader.email, author.id)).toEqual(["mention"]);
  });
});

describe("notifications from the recipient", () => {
  it("records none for the account's own mention, favourite, reblog or quote", async () => {
    const author = await person("self-notify-author@example.com");
    const own = await post(author.email, { status: "my own post" });

    await post(author.email, { status: `talking to myself @${author.username}` });
    expect(
      (await call(author.email, `/api/v1/statuses/${own}/favourite`, { method: "POST" })).status,
    ).toBe(200);
    expect(
      (await call(author.email, `/api/v1/statuses/${own}/reblog`, { method: "POST" })).status,
    ).toBe(200);
    await post(author.email, { status: "quoting myself", quoted_status_id: own });

    expect(await notificationTypesFrom(author.email, author.id)).toEqual([]);
  });

  it("records only poll, severed_relationships, moderation_warning and annual_report", async () => {
    const account = await person("self-notify-kinds@example.com");
    const kinds = [
      "mention",
      "favourite",
      "reblog",
      "admin.report",
      "poll",
      "severed_relationships",
      "moderation_warning",
      "annual_report",
    ];
    for (const kind of kinds) {
      const notified = await notifyAccount(env, {
        accountId: account.id,
        fromAccountId: account.id,
        kind,
      });
      expect(notified.isOk()).toBe(true);
    }

    const stored = await env.DB.prepare(
      "SELECT kind FROM notifications WHERE account_id = ? ORDER BY kind",
    )
      .bind(account.id)
      .all<{ kind: string }>();
    expect(stored.results.map((row) => row.kind)).toEqual([
      "annual_report",
      "moderation_warning",
      "poll",
      "severed_relationships",
    ]);
  });
});
