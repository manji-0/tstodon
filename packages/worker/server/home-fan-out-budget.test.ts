import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { OutboxJob } from "@tstodon/domain";
import { accessTokenFor, signedInAccount } from "../test/auth-fixture";
import { meter, meterWork, patchD1, resetMeter, settle } from "../test/meter";
import {
  holdQueue,
  kindOf,
  QUEUE_BATCH,
  QUEUE_INVOCATION_BUDGET,
  type HeldQueue,
} from "../test/queue-hold";
import { openStream } from "../test/stream-fixture";
import { HOME_FAN_OUT_PAGE_SIZE } from "./home-fan-out";
import { handleQueue } from "./queue-handler";

/** Followers of the author with their home stream open, as `count` sockets. */
const streamingFollowers = async (prefix: string, authorId: string, count: number) => {
  const streams = await Promise.all(
    Array.from({ length: count }, (_, n) =>
      openStream({ email: `${prefix}-${n}@example.com`, query: "?stream=user" }),
    ),
  );
  for (const stream of streams) {
    if (!stream.account) throw new Error("stream account");
    const response = await SELF.fetch(`https://example.com/api/v1/accounts/${authorId}/follow`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await accessTokenFor(stream.account.id)}` },
    });
    expect(response.status).toBe(200);
  }
  return streams;
};

/** Post as the author with the queue held; the post's id. */
const post = async (authorId: string, status: string): Promise<string> => {
  const posted = await SELF.fetch("https://example.com/api/v1/statuses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await accessTokenFor(authorId)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status }),
  });
  expect(posted.status).toBe(200);
  const id = z.object({ id: z.string() }).parse(await posted.json()).id;
  await settle();
  return id;
};

/** The first job of a fan-out of `entryId`, the one a post starts. */
const firstStep = (authorId: string, entryId: string): OutboxJob =>
  OutboxJob.parse({
    kind: "FanOutHome",
    event: "update",
    entryId,
    author: { kind: "LocalAccount", accountId: authorId },
    step: { kind: "List", afterAccountId: "" },
  })._unsafeUnwrap();

/** Run `bodies` through the queue handler as one invocation. */
const invoke = (bodies: ReadonlyArray<unknown>) =>
  meterWork(() =>
    handleQueue(
      {
        messages: bodies.map((body) => ({
          body,
          attempts: 1,
          ack: () => undefined,
          retry: () => {
            throw new Error("page retried");
          },
        })),
      },
      env,
    ),
  );

/**
 * A fan-out run to its end from `first`, `QUEUE_BATCH` jobs per invocation:
 * its rows read in all, its jobs, and the most statements one invocation made.
 */
const wholeFanOut = async (held: HeldQueue, first: OutboxJob) => {
  held.bodies.splice(0);
  let rowsRead = 0;
  let jobs = 0;
  let most = 0;
  let pending: unknown[] = [first];
  while (pending.length > 0) {
    for (let start = 0; start < pending.length; start += QUEUE_BATCH) {
      const batch = pending.slice(start, start + QUEUE_BATCH);
      jobs += batch.length;
      resetMeter();
      await invoke(batch);
      await settle();
      rowsRead += meter.tally.rowsRead;
      most = Math.max(most, meter.tally.statements);
    }
    pending = held.bodies.splice(0).filter((body) => kindOf(body) === "FanOutHome");
  }
  return { rowsRead, jobs, most };
};

/**
 * A `FanOutHome` page renders the entry for each follower with a home stream
 * open, about 28 statements each (`pnpm bench`). One queue invocation takes
 * `QUEUE_BATCH` pages and may make at most 1,000 D1 statements, so a full
 * batch of full pages must stay within the queue's budget.
 */
describe("home fan-out budget", () => {
  it(
    "keeps a batch of full pages within one invocation's budget",
    { timeout: 60_000 },
    async () => {
      const author = await signedInAccount("fan-budget-author@example.com");
      const streams = await streamingFollowers("fan-budget", author.id, HOME_FAN_OUT_PAGE_SIZE + 1);
      const held = holdQueue();
      try {
        const entryId = await post(author.id, "to every open home stream");
        const accountIds = streams.map((stream) => stream.account.id);
        const pages = [
          firstStep(author.id, entryId),
          OutboxJob.parse({
            kind: "FanOutHome",
            event: "update",
            entryId,
            author: { kind: "LocalAccount", accountId: author.id },
            step: { kind: "Accounts", accountIds: accountIds.slice(0, HOME_FAN_OUT_PAGE_SIZE) },
          })._unsafeUnwrap(),
        ];
        patchD1();
        for (const page of pages) {
          resetMeter();
          await invoke(Array.from({ length: QUEUE_BATCH }, () => page));
          await settle();
          expect(
            meter.tally.statements,
            `${QUEUE_BATCH} ${JSON.stringify(page.kind === "FanOutHome" && page.step.kind)} pages of ${HOME_FAN_OUT_PAGE_SIZE} followers made ${meter.tally.statements} statements`,
          ).toBeLessThan(QUEUE_INVOCATION_BUDGET);
        }
      } finally {
        held.release();
        for (const stream of streams) stream.close();
      }
    },
  );

  // Listing the followers reads every follower of the author, whatever the
  // page: here up to 4 rows for each one without a stream open. A fan-out
  // that listed them again for each page read 7 per follower over these 4
  // pages (the celebrity's post on `pnpm bench`: 134 pages, about 2,200 rows
  // each).
  it(
    "lists the author's followers once per post, not once per page",
    { timeout: 60_000 },
    async () => {
      const quiet = 300;
      const author = await signedInAccount("fan-once-author@example.com");
      const pages = 4;
      const streams = await streamingFollowers(
        "fan-once",
        author.id,
        (pages - 1) * HOME_FAN_OUT_PAGE_SIZE + 1,
      );
      const series = `WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < ${quiet})`;
      await env.DB.batch([
        env.DB.prepare(
          `${series} INSERT INTO accounts (id, username, access_email, display_name, public_key_pem, private_key_jwk, current_sign_in_at)
         SELECT printf('fanquiet%04d', n), 'fanquiet' || n, 'fanquiet' || n || '@example.com', 'Quiet', '-', '{}',
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         FROM s`,
        ),
        env.DB.prepare(
          `${series} INSERT INTO follows (id, follower_account_id, target_account_id, kind)
         SELECT printf('fanquietfollow%04d', n), printf('fanquiet%04d', n), ?, 'Accepted' FROM s`,
        ).bind(author.id),
      ]);
      const held = holdQueue();
      try {
        patchD1();
        const crowded = await wholeFanOut(held, firstStep(author.id, await post(author.id, "one")));
        await env.DB.prepare("DELETE FROM follows WHERE id LIKE 'fanquietfollow%'").run();
        const alone = await wholeFanOut(held, firstStep(author.id, await post(author.id, "two")));

        expect(crowded.jobs).toBe(pages);
        expect(alone.jobs).toBe(pages);
        expect(crowded.most).toBeLessThan(QUEUE_INVOCATION_BUDGET);
        const perQuietFollower = (crowded.rowsRead - alone.rowsRead) / quiet;
        expect(
          perQuietFollower,
          `${crowded.jobs} jobs read ${crowded.rowsRead - alone.rowsRead} rows more for ${quiet} followers without a stream`,
        ).toBeLessThan(5);
      } finally {
        held.release();
        for (const stream of streams) stream.close();
      }
    },
  );
});
