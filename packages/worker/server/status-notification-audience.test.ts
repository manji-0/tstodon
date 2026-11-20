import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import migration from "../app/db/migrations/0159_direct_status_notifications.sql?raw";
import { parseRows } from "./d1";

// Mastodon sends the `status` notification ("notify me when this account
// posts") from `FeedInsertWorker#notify?`, so only to a follower the home
// fan-out reached: every follower for a public, unlisted or private note, the
// mentioned followers for a direct one; never for a reply to someone else.

const call = async (email: string, path: string, body?: object): Promise<unknown> => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status, path).toBe(200);
  return response.json();
};

const post = async (email: string, body: object): Promise<string> =>
  z.object({ id: z.string() }).parse(await call(email, "/api/v1/statuses", body)).id;

/** The `status` notifications stored for `email`'s account about `statusId`. */
const statusNotifications = async (email: string, statusId: string): Promise<number> => {
  const account = await signedInAccount(email);
  const [row] = parseRows(
    z.object({ n: z.number() }),
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM notifications WHERE account_id = ? AND status_id = ? AND kind = 'status'",
      )
        .bind(account.id, statusId)
        .all()
    ).results,
  );
  return row?.n ?? 0;
};

const notifyingFollower = async (email: string, authorId: string): Promise<string> => {
  await call(email, `/api/v1/accounts/${authorId}/follow`, { notify: true });
  return (await signedInAccount(email)).username;
};

describe("the status notification of a followed account's post", () => {
  it("goes to each notifying follower for a private note", async () => {
    const author = await signedInAccount("sna-private-author@example.com");
    await notifyingFollower("sna-private-follower@example.com", author.id);

    const id = await post("sna-private-author@example.com", {
      status: "followers only",
      visibility: "private",
    });

    expect(await statusNotifications("sna-private-follower@example.com", id)).toBe(1);
  });

  it("goes only to the notifying followers a direct note mentions", async () => {
    const author = await signedInAccount("sna-direct-author@example.com");
    const mentioned = await notifyingFollower("sna-direct-mentioned@example.com", author.id);
    await notifyingFollower("sna-direct-other@example.com", author.id);

    const id = await post("sna-direct-author@example.com", {
      status: `@${mentioned} just for you`,
      visibility: "direct",
    });

    expect(await statusNotifications("sna-direct-mentioned@example.com", id)).toBe(1);
    expect(await statusNotifications("sna-direct-other@example.com", id)).toBe(0);
  });

  it("goes to no follower for a reply to someone else, and to each for a self-reply", async () => {
    const author = await signedInAccount("sna-reply-author@example.com");
    await signedInAccount("sna-reply-other@example.com");
    await notifyingFollower("sna-reply-follower@example.com", author.id);
    const others = await post("sna-reply-other@example.com", { status: "a thread" });
    const own = await post("sna-reply-author@example.com", { status: "my thread" });

    const reply = await post("sna-reply-author@example.com", {
      status: "a reply",
      in_reply_to_id: others,
    });
    const selfReply = await post("sna-reply-author@example.com", {
      status: "more of mine",
      in_reply_to_id: own,
    });

    expect(await statusNotifications("sna-reply-follower@example.com", reply)).toBe(0);
    expect(await statusNotifications("sna-reply-follower@example.com", selfReply)).toBe(1);
  });

  it("goes to no follower whose follow keeps other languages", async () => {
    const author = await signedInAccount("sna-language-author@example.com");
    await call("sna-language-ja@example.com", `/api/v1/accounts/${author.id}/follow`, {
      notify: true,
      languages: ["ja"],
    });
    await call("sna-language-en@example.com", `/api/v1/accounts/${author.id}/follow`, {
      notify: true,
      languages: ["en"],
    });

    const id = await post("sna-language-author@example.com", {
      status: "in English",
      language: "en",
    });

    expect(await statusNotifications("sna-language-ja@example.com", id)).toBe(0);
    expect(await statusNotifications("sna-language-en@example.com", id)).toBe(1);
  });
});

describe("migration 0159", () => {
  it("drops the stored status notifications of a direct note that does not mention their account", async () => {
    const author = await signedInAccount("sna-migrate-author@example.com");
    const mentioned = await notifyingFollower("sna-migrate-mentioned@example.com", author.id);
    const other = await signedInAccount("sna-migrate-other@example.com");
    await notifyingFollower("sna-migrate-other@example.com", author.id);
    const direct = await post("sna-migrate-author@example.com", {
      status: `@${mentioned} before the fix`,
      visibility: "direct",
    });
    const open = await post("sna-migrate-author@example.com", { status: "public" });
    // The notification the publish used to store for an unmentioned follower.
    await env.DB.prepare(
      "INSERT INTO notifications (id, account_id, from_account_id, kind, status_id) VALUES (?, ?, ?, 'status', ?)",
    )
      .bind(`9${direct}`, other.id, author.id, direct)
      .run();
    expect(await statusNotifications("sna-migrate-other@example.com", direct)).toBe(1);

    await env.DB.prepare(
      migration
        .split("\n")
        .filter((line) => !line.startsWith("--"))
        .join("\n")
        .trim()
        .replace(/;$/, ""),
    ).run();

    expect(await statusNotifications("sna-migrate-other@example.com", direct)).toBe(0);
    expect(await statusNotifications("sna-migrate-mentioned@example.com", direct)).toBe(1);
    expect(await statusNotifications("sna-migrate-other@example.com", open)).toBe(1);
  });
});
