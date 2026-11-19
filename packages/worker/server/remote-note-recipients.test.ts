import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { ApiConversation, ApiNotification, ApiStatus } from "@tstodon/api";
import type { LocalAccount } from "@tstodon/domain";
import { expectContract } from "../test/api-contract";
import { accessTokenFor, signedInAccount } from "../test/auth-fixture";
import { meter, patchD1, resetMeter, settle } from "../test/meter";
import { drainHeld, holdQueue, QUERIES_PER_INVOCATION, QUEUE_BATCH } from "../test/queue-hold";
import { remoteActor } from "../test/remote-actor-fixture";
import { openStream } from "../test/stream-fixture";
import { deleteAccount } from "./account-store";
import { parseRows } from "./d1";
import { INLINE_NOTE_RECIPIENTS } from "./remote-status-persist";

/**
 * A remote note may name any number of local accounts, as in Mastodon: each
 * one can read it and finds it in its conversations, and each one it
 * mentions is notified. The inbox request notifies a fixed number of them;
 * the rest are notified by queued jobs, so the request's D1 statements do not
 * grow with the recipients, and neither does one queue invocation's.
 */

const get = async (token: string, path: string) => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a remote direct note to many local accounts", () => {
  it(
    "lets each one read it, lists it in each one's conversations, and notifies each one",
    { timeout: 120_000 },
    async () => {
      const author = await remoteActor("crowddm", "crowd-dm.example");
      // Each accepts private mentions from strangers, so each mention is
      // delivered: the costlier path, which the budget below is for.
      const accounts = async (prefix: string, count: number): Promise<LocalAccount[]> =>
        Promise.all(
          Array.from({ length: count }, async (_, n) => {
            const account = await signedInAccount(`${prefix}-${n}@example.com`);
            const response = await SELF.fetch("https://example.com/api/v2/notifications/policy", {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${await accessTokenFor(account.id)}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ for_private_mentions: "accept" }),
            });
            expect(response.status).toBe(200);
            await response.body?.cancel();
            return account;
          }),
        );
      const deliver = async (name: string, recipients: ReadonlyArray<LocalAccount>) => {
        const noteUri = `https://crowd-dm.example/notes/${name}`;
        const actors = recipients.map((account) => `https://example.com/users/${account.username}`);
        const delivery = await author.delivery({
          id: `${noteUri}/create`,
          type: "Create",
          object: {
            id: noteUri,
            type: "Note",
            attributedTo: author.actorUri,
            content: "<p>hello all of you</p>",
            published: new Date().toISOString(),
            to: actors,
            tag: actors.map((href) => ({ type: "Mention", href })),
          },
        });
        await settle();
        resetMeter();
        const response = await SELF.fetch(delivery);
        expect(response.status).toBe(202);
        await settle();
        const statements = meter.tally.statements;
        const [row] = parseRows(
          z.object({ id: z.string() }),
          (
            await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
              .bind(noteUri)
              .all()
          ).results,
        );
        if (!row) throw new Error(`${noteUri} was not stored`);
        return { id: row.id, statements };
      };

      const thirty = await accounts("crowd-dm-a", 30);
      const sixty = await accounts("crowd-dm-b", 60);
      // Every recipient of the 30 has its `direct` stream open, as do the ones
      // of the 60 the request serves itself, so the request and the queued
      // jobs render each one's conversation too: the costliest case.
      const sockets = await Promise.all(
        [
          ...thirty.map((_, n) => `crowd-dm-a-${n}@example.com`),
          ...sixty.slice(0, INLINE_NOTE_RECIPIENTS).map((_, n) => `crowd-dm-b-${n}@example.com`),
        ].map((email) => openStream({ email, query: "?stream=direct" })),
      );
      patchD1();
      const queued = holdQueue();
      // To an account of neither set, so their conversation lists start alike.
      await deliver("warm", await accounts("crowd-dm-warm", 1));
      queued.bodies.length = 0;
      const toThirty = await deliver("thirty", thirty);
      const toSixty = await deliver("sixty", sixty);

      // A few statements of the stream renders vary from run to run; 30 more
      // recipients served inline would add over a thousand.
      expect(
        Math.abs(toSixty.statements - toThirty.statements),
        `the inbox request made ${toThirty.statements} statements for 30 recipients, ${toSixty.statements} for 60`,
      ).toBeLessThan(20);
      expect(toThirty.statements).toBeLessThan(QUERIES_PER_INVOCATION);
      const mostPerInvocation = await drainHeld(queued, ["FinishRemoteNoteRecipient"]);
      expect(
        mostPerInvocation,
        `one queue invocation of ${QUEUE_BATCH} jobs made ${mostPerInvocation} statements`,
      ).toBeLessThan(QUERIES_PER_INVOCATION);

      for (const account of thirty) {
        const token = await accessTokenFor(account.id);
        const status = await get(token, `/api/v1/statuses/${toThirty.id}`);
        expect(status.status, account.username).toBe(200);
        expectContract(ApiStatus, status.body);
        const conversations = expectContract(
          z.array(ApiConversation),
          (await get(token, "/api/v1/conversations")).body,
        );
        expect(
          conversations.map((conversation) => conversation.last_status?.id),
          account.username,
        ).toContain(toThirty.id);
        const notifications = expectContract(
          z.array(ApiNotification),
          (await get(token, "/api/v1/notifications?types[]=mention")).body,
        );
        expect(
          notifications.filter(
            (notification) =>
              notification.type === "mention" && notification.status?.id === toThirty.id,
          ),
          account.username,
        ).toHaveLength(1);
      }
      for (const socket of sockets) {
        socket.close();
      }
    },
  );
});

describe("a queued FinishRemoteNoteRecipient job", () => {
  /** A remote note stored mentioning `mentioned`, and a job for `accountId`'s mention of it. */
  const storedNote = async (name: string, mentioned: ReadonlyArray<LocalAccount>) => {
    const author = await remoteActor(`queued${name}`, "crowd-dm.example");
    const noteUri = `https://crowd-dm.example/notes/queued-${name}`;
    const actors = mentioned.map((account) => `https://example.com/users/${account.username}`);
    expect(
      await author.send({
        id: `${noteUri}/create`,
        type: "Create",
        object: {
          id: noteUri,
          type: "Note",
          attributedTo: author.actorUri,
          content: "<p>later</p>",
          published: new Date().toISOString(),
          to: ["https://www.w3.org/ns/activitystreams#Public", ...actors],
          tag: actors.map((href) => ({ type: "Mention", href })),
        },
      }),
    ).toBe(202);
    const [row] = parseRows(
      z.object({ id: z.string() }),
      (
        await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
          .bind(noteUri)
          .all()
      ).results,
    );
    if (!row) throw new Error(`${noteUri} was not stored`);
    const job = (accountId: string) => ({
      kind: "FinishRemoteNoteRecipient",
      statusId: row.id,
      actorUri: author.actorUri,
      accountId,
      steps: ["Mention"],
    });
    return { statusId: row.id, job };
  };

  const mentionCount = async (accountId: string, statusId: string): Promise<number> =>
    parseRows(
      z.object({ n: z.number() }),
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM notifications WHERE account_id = ? AND status_id = ? AND kind = 'mention'",
        )
          .bind(accountId, statusId)
          .all()
      ).results,
    )[0]?.n ?? 0;

  it("is done, not retried, when its account was deleted before it ran", async () => {
    const gone = await signedInAccount("queued-gone@example.com");
    const { job } = await storedNote("gone", [gone]);
    expect((await deleteAccount(env.DB, gone.id)).isOk()).toBe(true);
    await drainHeld({ bodies: [job(gone.id)] }, ["FinishRemoteNoteRecipient"]);
  });

  it("is retried when the note's mentions cannot be read, rather than screened without them", async () => {
    const reader = await signedInAccount("queued-unread@example.com");
    const { job } = await storedNote("unread", [reader]);
    const proto = Object.getPrototypeOf(env.DB);
    const prepare = proto.prepare;
    vi.spyOn(proto, "prepare").mockImplementation(function (this: D1Database, sql: unknown) {
      if (typeof sql === "string" && sql.includes("silent = 0") && sql.includes("ORDER BY rowid")) {
        throw new Error("mentions unreadable");
      }
      return Reflect.apply(prepare, this, [sql]);
    });
    await expect(
      drainHeld({ bodies: [job(reader.id)] }, ["FinishRemoteNoteRecipient"]),
    ).rejects.toThrow("job retried");
  });

  it("notifies nobody an Update has since made silent", async () => {
    const [kept, dropped] = await Promise.all([
      signedInAccount("queued-kept@example.com"),
      signedInAccount("queued-dropped@example.com"),
    ]);
    const { statusId, job } = await storedNote("silenced", [kept]);
    // As an Update that drops the mention leaves it: a silent mention.
    await env.DB.prepare(
      "INSERT INTO remote_status_mentions (status_id, account_id, silent) VALUES (?, ?, 1)",
    )
      .bind(statusId, dropped.id)
      .run();
    await drainHeld({ bodies: [job(dropped.id)] }, ["FinishRemoteNoteRecipient"]);
    expect(await mentionCount(dropped.id, statusId)).toBe(0);
  });
});
