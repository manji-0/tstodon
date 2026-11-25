import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { OutboxJob } from "@tstodon/domain";
import { accessTokenFor, signedInAccount } from "../test/auth-fixture";
import { meter, meterWork, patchD1, resetMeter, settle } from "../test/meter";
import { holdQueue, QUEUE_BATCH, QUEUE_INVOCATION_BUDGET } from "../test/queue-hold";
import { openStream } from "../test/stream-fixture";
import { HOME_FAN_OUT_PAGE_SIZE } from "./home-fan-out";
import { handleQueue } from "./queue-handler";

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
      const streams = await Promise.all(
        Array.from({ length: HOME_FAN_OUT_PAGE_SIZE }, (_, n) =>
          openStream({ email: `fan-budget-${n}@example.com`, query: "?stream=user" }),
        ),
      );
      for (const stream of streams) {
        if (!stream.account) throw new Error("stream account");
        const response = await SELF.fetch(
          `https://example.com/api/v1/accounts/${author.id}/follow`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${await accessTokenFor(stream.account.id)}` },
          },
        );
        expect(response.status).toBe(200);
      }
      const held = holdQueue();
      try {
        const posted = await SELF.fetch("https://example.com/api/v1/statuses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await accessTokenFor(author.id)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "to every open home stream" }),
        });
        expect(posted.status).toBe(200);
        const entryId = z.object({ id: z.string() }).parse(await posted.json()).id;
        await settle();
        const page = OutboxJob.parse({
          kind: "FanOutHome",
          event: "update",
          entryId,
          author: { kind: "LocalAccount", accountId: author.id },
          afterAccountId: "",
        })._unsafeUnwrap();
        patchD1();
        resetMeter();
        await meterWork(() =>
          handleQueue(
            {
              messages: Array.from({ length: QUEUE_BATCH }, () => ({
                body: page,
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
        await settle();
        expect(
          meter.tally.statements,
          `${QUEUE_BATCH} pages of ${HOME_FAN_OUT_PAGE_SIZE} followers made ${meter.tally.statements} statements`,
        ).toBeLessThan(QUEUE_INVOCATION_BUDGET);
      } finally {
        held.release();
        for (const stream of streams) stream.close();
      }
    },
  );
});
