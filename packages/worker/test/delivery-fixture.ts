import { env } from "cloudflare:test";
import { OutboxJob } from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { expect } from "vite-plus/test";
import { z } from "zod";
import { processOutboxJob } from "../src/delivery";
import { listOutboundActivities } from "../src/outbox-store";

export const CreateActivitySchema = z.object({
  type: z.string(),
  object: z.object({
    id: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    inReplyTo: z.string().nullable().optional(),
    tag: z.array(z.object({ type: z.string(), href: z.string(), name: z.string() })),
  }),
});

/**
 * The queued `Create` of a note, expanded as the queue would, with the
 * inboxes it is delivered to; `undefined` when the note was never queued.
 */
export const deliveredCreate = async (accountId: string, noteUri: string) => {
  const activities = await listOutboundActivities(env.DB, accountId, 50);
  const row = (activities.isOk() ? activities.value : []).find((candidate) => {
    const parsed = schemaResult(CreateActivitySchema)(JSON.parse(candidate.payload_json));
    return parsed.isOk() && parsed.value.type === "Create" && parsed.value.object.id === noteUri;
  });
  if (!row) {
    return undefined;
  }
  const job = OutboxJob.parse({ kind: "ExpandFollowers", activityId: row.id });
  if (job.isErr()) {
    throw new Error("expand job rejected");
  }
  await processOutboxJob(env, job.value);
  const { results } = await env.DB.prepare(
    "SELECT inbox_url FROM outbox_deliveries WHERE activity_id = ? AND inbox_url IS NOT NULL ORDER BY inbox_url",
  )
    .bind(row.id)
    .all<{ inbox_url: string }>();
  const activity = schemaResult(CreateActivitySchema)(JSON.parse(row.payload_json));
  expect(activity.isOk()).toBe(true);
  if (activity.isErr()) {
    throw new Error("queued Create rejected");
  }
  return {
    activity: activity.value,
    inboxes: (results ?? []).map((target) => target.inbox_url),
  };
};
