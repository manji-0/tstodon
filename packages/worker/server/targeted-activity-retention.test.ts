import { schemaResult } from "@tstodon/core";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { signedInAccount } from "../test/auth-fixture";
import { pruneOutboundActivities } from "./activity-vacuum";
import { enqueueTargetedActivity } from "./delivery";
import { persistOutboxTarget } from "./outbox-store";

/**
 * An activity sent to named inboxes (an `Accept`, a `Follow`, a deleted
 * account's `Delete`) is pruned like any other once its targets settle. Its
 * fan-out row used to stay `Queued` for good, which kept the activity.
 */

const read = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schemaResult(schema)(value);
  if (parsed.isErr()) {
    throw new Error(`schema rejected: ${JSON.stringify(value)}`);
  }
  return parsed.value;
};

const Rows = z.array(z.object({ activity_id: z.string(), kind: z.string() }));

const fanoutRows = async (activityUri: string) => {
  const { results } = await env.DB.prepare(
    `SELECT d.activity_id, d.kind FROM outbox_deliveries d
     JOIN outbound_activities o ON o.id = d.activity_id
     WHERE d.inbox_url IS NULL AND instr(o.payload_json, ?) > 0`,
  )
    .bind(activityUri)
    .all();
  return read(Rows, results);
};

const stored = async (activityId: string): Promise<boolean> =>
  (await env.DB.prepare("SELECT id FROM outbound_activities WHERE id = ?")
    .bind(activityId)
    .first()) !== null;

const FAR_FUTURE = "2999-01-01T00:00:00.000Z";

describe("an activity sent to named inboxes", () => {
  it("is pruned once its target settled", async () => {
    const account = await signedInAccount("targeted-retention@example.com");
    const actor = `https://example.com/users/${account.username}`;
    const activityUri = `${actor}#accepts/follows/retention`;
    const inbox = "https://targeted-retention.example/inbox";
    const enqueued = await enqueueTargetedActivity(
      env,
      account,
      "Accept",
      {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: activityUri,
        type: "Accept",
        actor,
        object: {
          id: "https://targeted-retention.example/follows/1",
          type: "Follow",
          actor: "https://targeted-retention.example/users/fan",
          object: actor,
        },
      },
      inbox,
    );
    expect(enqueued.isOk()).toBe(true);

    const [fanout] = await fanoutRows(activityUri);
    expect(fanout?.kind).toBe("Expanded");
    const activityId = fanout?.activity_id ?? "";

    // The target is still to be attempted: the activity stays.
    expect((await pruneOutboundActivities(env.DB, FAR_FUTURE, 500)).isOk()).toBe(true);
    expect(await stored(activityId)).toBe(true);

    expect(
      (await persistOutboxTarget(env.DB, activityId, inbox, { kind: "Delivered" })).isOk(),
    ).toBe(true);
    expect((await pruneOutboundActivities(env.DB, FAR_FUTURE, 500)).isOk()).toBe(true);
    expect(await stored(activityId)).toBe(false);
  });
});
