import { env } from "cloudflare:test";
import { OutboxJob } from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { expect, vi } from "vite-plus/test";
import { z } from "zod";
import { attemptInboxDelivery } from "../src/delivery";
import { processOutboxJob } from "../src/outbox-job";
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

type SentRequest = Readonly<{
  url: string;
  method: string;
  headers: [string, string][];
  body: string;
}>;

/**
 * Delivers a queued activity to `inboxUrl` and returns the signed request
 * that went out.
 *
 * The `fetch` spy is isolate-wide, so the `OutboxDeliveryWorkflow` started
 * for the same activity can post through it too, from its own Durable
 * Object. A request body is an I/O object bound to the context that made
 * it, so the spy reads each body there and the caller gets a copy it owns.
 */
export const deliverTarget = async (activityId: string, inboxUrl: string): Promise<Request> => {
  const job = OutboxJob.parse({ kind: "DeliverTarget", activityId, inboxUrl });
  if (job.isErr() || job.value.kind !== "DeliverTarget") {
    throw new Error("deliver job rejected");
  }
  const sent: SentRequest[] = [];
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    sent.push({
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      body: await request.text(),
    });
    return new Response(null, { status: 202 });
  });
  try {
    expect((await attemptInboxDelivery(env, job.value)).kind).toBe("Success");
  } finally {
    fetchSpy.mockRestore();
  }
  // Other deliveries in the isolate hit the spy too: pick the one for this
  // activity and inbox.
  const queued = await env.DB.prepare("SELECT payload_json FROM outbound_activities WHERE id = ?")
    .bind(activityId)
    .first();
  const payload = schemaResult(PayloadIdSchema)(
    JSON.parse(
      schemaResult(PayloadRowSchema)(queued)
        .map((row) => row.payload_json)
        .unwrapOr("{}"),
    ),
  );
  if (payload.isErr()) {
    throw new Error("queued activity not found");
  }
  const delivered = sent.find(
    (request) =>
      request.url === inboxUrl &&
      schemaResult(PayloadIdSchema)(JSON.parse(request.body))
        .map((body) => body.id)
        .unwrapOr("") === payload.value.id,
  );
  if (!delivered) {
    throw new Error("the activity was not delivered to the inbox");
  }
  return new Request(delivered.url, {
    method: delivered.method,
    headers: delivered.headers,
    body: delivered.body,
  });
};

const PayloadRowSchema = z.object({ payload_json: z.string() });
const PayloadIdSchema = z.object({ id: z.string().min(1) });
