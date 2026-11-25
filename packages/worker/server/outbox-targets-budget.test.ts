import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { meter, meterWork, patchD1, resetMeter } from "../test/meter";
import { ensureOutboxTargets, insertOutboundActivity } from "./outbox-store";

/**
 * `ExpandFollowers` records one target per follower inbox. D1 counts each
 * statement of a batch toward an invocation's 1,000-query limit, so the
 * statements may not grow with the inboxes (`pnpm bench`: 400 follower
 * domains made 400 statements per invocation).
 */
describe("outbox targets", () => {
  it("records any number of inboxes in a fixed number of statements", async () => {
    const activity = (
      await insertOutboundActivity(env.DB, {
        signer: { kind: "InstanceActor" },
        audience: "Inboxes",
        kind: "Flag",
        payload: { type: "Flag", id: `https://example.com/flags/${crypto.randomUUID()}` },
      })
    )._unsafeUnwrap();
    const inboxes = Array.from({ length: 1_200 }, (_, n) => `https://d${n}.example/inbox`);
    patchD1();
    resetMeter();
    (
      await meterWork(() =>
        ensureOutboxTargets(env.DB, activity.id, [...inboxes, inboxes[0] ?? ""]),
      )
    )._unsafeUnwrap();

    expect(meter.tally.statements).toBeLessThanOrEqual(3);
    const rows = z
      .array(z.object({ inbox_url: z.string(), kind: z.string(), attempt_count: z.number() }))
      .parse(
        (
          await env.DB.prepare(
            "SELECT inbox_url, kind, attempt_count FROM outbox_deliveries WHERE activity_id = ? AND inbox_url IS NOT NULL",
          )
            .bind(activity.id)
            .all()
        ).results,
      );
    expect(rows.map((row) => row.inbox_url).toSorted()).toEqual(inboxes.toSorted());
    expect(new Set(rows.map((row) => `${row.kind}/${row.attempt_count}`))).toEqual(
      new Set(["Queued/0"]),
    );
  });
});
