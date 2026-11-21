import { SELF, env } from "cloudflare:test";
import { OutboxJob } from "@tstodon/domain";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { meter, meterWork, patchD1, resetMeter, settle } from "../test/meter";
import {
  drainHeld,
  holdQueue,
  kindOf,
  QUEUE_BATCH,
  QUEUE_INVOCATION_BUDGET,
} from "../test/queue-hold";
import { parseRows } from "./d1";
import { processOutboxJob } from "./outbox-job";
import { NOTIFYING_FOLLOWER_PAGE_SIZE } from "./remote-status-persist";
import { insertScheduledStatus } from "./scheduled-status-store";

// Mastodon v4.7.5 sends a local post's `status` notification from workers:
// `DistributionWorker` runs `FanOutOnWriteService`, whose
// `deliver_to_all_followers!` reads the followers `find_in_batches` and
// queues a `FeedInsertWorker` each, which queues `LocalNotificationWorker`.
// The publish request and the scheduled-status run here queue the work the
// same way, so neither grows with the author's notifying followers.

const PAGE_JOB = "NotifyLocalNoteFollowers";

afterEach(() => {
  vi.restoreAllMocks();
});

const post = async (email: string, body: object): Promise<string> => {
  const response = await SELF.fetch("https://example.com/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return z.object({ id: z.string() }).parse(await response.json()).id;
};

/** `count` accounts named `prefix-n` following `authorId` with notifications on. */
const notifyingFollowers = async (
  prefix: string,
  authorId: string,
  count: number,
): Promise<string[]> => {
  const emails = Array.from({ length: count }, (_, n) => `${prefix}-${n}@example.com`);
  for (let start = 0; start < emails.length; start += 10) {
    await Promise.all(
      emails.slice(start, start + 10).map(async (email) => {
        const response = await SELF.fetch(
          `https://example.com/api/v1/accounts/${authorId}/follow`,
          {
            method: "POST",
            headers: { "content-type": "application/json", ...(await authHeaders(email)) },
            body: JSON.stringify({ notify: true }),
          },
        );
        expect(response.status).toBe(200);
        await response.text();
      }),
    );
  }
  return emails;
};

/** The `status` notifications each of `emails` holds about `statusId`. */
const statusNotifications = async (
  emails: ReadonlyArray<string>,
  statusId: string,
): Promise<number[]> =>
  Promise.all(
    emails.map(async (email) => {
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
    }),
  );

const sentOf = (bodies: ReadonlyArray<unknown>, kind: string): number =>
  bodies.filter((body) => kindOf(body) === kind).length;

describe("a local note of an account many local accounts follow with notifications", () => {
  it(
    "notifies each notifying follower once, a page at a time through the queue",
    { timeout: 300_000 },
    async () => {
      const author = await signedInAccount("lnf-pages-author@example.com");
      const followers = await notifyingFollowers(
        "lnf-pages",
        author.id,
        NOTIFYING_FOLLOWER_PAGE_SIZE + 3,
      );
      const queued = holdQueue();
      const seen: unknown[] = [];
      const push = queued.bodies.push.bind(queued.bodies);
      queued.bodies.push = (...bodies: unknown[]) => {
        seen.push(...bodies);
        return push(...bodies);
      };

      const id = await post("lnf-pages-author@example.com", { status: "hello followers" });
      await drainHeld(queued, [PAGE_JOB]);

      expect(
        seen.filter(
          (body) => kindOf(body) === PAGE_JOB && Reflect.get(Object(body), "step")?.kind === "Page",
        ),
        "one page job for the second page",
      ).toHaveLength(1);
      expect(await statusNotifications(followers, id)).toEqual(followers.map(() => 1));
    },
  );

  it("notifies each follower once when the queue delivers its jobs twice", async () => {
    const author = await signedInAccount("lnf-twice-author@example.com");
    const followers = await notifyingFollowers("lnf-twice", author.id, 3);
    const queued = holdQueue();

    const id = await post("lnf-twice-author@example.com", { status: "said once" });
    expect(sentOf(queued.bodies, PAGE_JOB)).toBe(followers.length);
    queued.bodies.push(...queued.bodies.slice());
    await drainHeld(queued, [PAGE_JOB]);

    expect(await statusNotifications(followers, id)).toEqual([1, 1, 1]);
  });

  // A later page is read by a queued job, which must read who a direct
  // note names from the stored note.
  it("queues from a later page only the followers a direct note names", async () => {
    const author = await signedInAccount("lnf-direct-author@example.com");
    const [named, other] = await notifyingFollowers("lnf-direct", author.id, 2);
    const namedAccount = await signedInAccount(named ?? "");
    await signedInAccount(other ?? "");
    const id = await post("lnf-direct-author@example.com", {
      status: `@${namedAccount.username} just for you`,
      visibility: "direct",
    });
    const queued = holdQueue();

    const job = OutboxJob.parse({
      kind: PAGE_JOB,
      statusId: id,
      step: { kind: "Page", afterFollowId: " " },
    });
    if (job.isErr()) {
      throw new Error("page job rejected");
    }
    expect(await processOutboxJob(env, job.value)).toBe("ok");

    expect(queued.bodies).toEqual([
      { kind: PAGE_JOB, statusId: id, step: { kind: "Follower", accountId: namedAccount.id } },
    ]);
  });
});

describe("a scheduled local note of an account with notifying followers", () => {
  it(
    "publishes in the same D1 statements however many followers it notifies, and notifies each",
    { timeout: 300_000 },
    async () => {
      const few = await signedInAccount("lnf-scheduled-few@example.com");
      const many = await signedInAccount("lnf-scheduled-many@example.com");
      const fewFollowers = await notifyingFollowers("lnf-scheduled-few", few.id, 1);
      const manyFollowers = await notifyingFollowers(
        "lnf-scheduled-many",
        many.id,
        NOTIFYING_FOLLOWER_PAGE_SIZE + 3,
      );
      patchD1();
      const queued = holdQueue();
      /** The D1 statements of the cron run that publishes `accountId`'s due post, and its id. */
      const publish = async (accountId: string, text: string) => {
        const stored = await insertScheduledStatus(env.DB, {
          accountId,
          scheduledAt: new Date(Date.now() - 60_000).toISOString(),
          params: {
            text,
            visibility: "public",
            spoiler_text: "",
            sensitive: false,
            language: null,
            media_ids: [],
            media_attributes: [],
            poll: null,
            in_reply_to_id: null,
          },
        });
        expect(stored.isOk()).toBe(true);
        await settle();
        resetMeter();
        expect(
          await meterWork(() => processOutboxJob(env, { kind: "PublishScheduledStatuses" })),
        ).toBe("ok");
        await settle();
        const statements = meter.tally.statements;
        const [row] = parseRows(
          z.object({ id: z.string() }),
          (
            await env.DB.prepare(
              "SELECT id FROM statuses WHERE account_id = ? ORDER BY id DESC LIMIT 1",
            )
              .bind(accountId)
              .all()
          ).results,
        );
        return { statements, id: row?.id ?? "" };
      };

      const one = await publish(few.id, "scheduled for one");
      const fifty = await publish(many.id, "scheduled for many");
      expect(
        fifty.statements,
        `publishing for ${manyFollowers.length} notifying followers made ${fifty.statements} statements, for one ${one.statements}`,
      ).toBe(one.statements);

      const mostPerInvocation = await drainHeld(queued, [PAGE_JOB]);
      expect(
        mostPerInvocation,
        `one queue invocation of ${QUEUE_BATCH} jobs made ${mostPerInvocation} statements`,
      ).toBeLessThan(QUEUE_INVOCATION_BUDGET);
      expect(await statusNotifications(fewFollowers, one.id)).toEqual([1]);
      expect(await statusNotifications(manyFollowers, fifty.id)).toEqual(
        manyFollowers.map(() => 1),
      );
    },
  );
});
