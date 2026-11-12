import { schemaResult, warmSchemas } from "@tstodon/core";
import { ActivityId, Hostname } from "@tstodon/domain";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { z } from "zod";
import { prepareInboxDelivery } from "./delivery";
import {
  cachedDeliveryDomainHealth,
  recordInboxReachability,
} from "./delivery-domain-health-store";
import { withMetricsBudget, writeMetric } from "./metrics";
import { type DeliveryRunDeps, type DeliverySteps, runOutboxDelivery } from "./outbox-delivery-run";
import {
  findNextOutboxTargetDue,
  listDueOutboxTargets,
  persistOutboxTargets,
} from "./outbox-store";

const OutboxWorkflowParamsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("DeliverActivity"), activityId: ActivityId.schema }),
  /** An instance started for one inbox, before deliveries were grouped by activity. */
  z.object({
    kind: z.literal("DeliverTarget"),
    activityId: ActivityId.schema,
    inboxUrl: z.string().min(1),
  }),
]);

export type OutboxWorkflowParams = z.input<typeof OutboxWorkflowParamsSchema>;

/**
 * A step's D1 work is idempotent and it posts only to targets still due, so
 * a failed step is run again a few times; a POST failure is not a step
 * failure (the target is rescheduled on its own backoff instead).
 */
const chunkStep = {
  retries: { limit: 3, delay: "10 seconds" as const, backoff: "exponential" as const },
  timeout: "10 minutes" as const,
};

const workflowSteps = (step: WorkflowStep): DeliverySteps => ({
  run: (name, work) => step.do(name, chunkStep, work),
  sleepUntil: (name, atMs) => step.sleepUntil(name, atMs),
});

export const outboxDeliveryRunDeps = (env: Env): DeliveryRunDeps => ({
  dueTargets: (scope, afterInboxUrl, dueBy, limit) =>
    listDueOutboxTargets(env.DB, scope.activityId, scope.inboxUrl, afterInboxUrl, dueBy, limit),
  nextDue: (scope) => findNextOutboxTargetDue(env.DB, scope.activityId, scope.inboxUrl),
  domainUnavailable: async (inboxUrl) => {
    const host = Hostname.ofUri(inboxUrl);
    return (
      host !== undefined && (await cachedDeliveryDomainHealth(env.DB, host))?.kind === "Unavailable"
    );
  },
  prepare: (activityId) => prepareInboxDelivery(env, activityId),
  persist: (activityId, settled) => persistOutboxTargets(env.DB, activityId, settled),
  recordReachability: (inboxUrl, reachability) =>
    recordInboxReachability(env, inboxUrl, reachability),
  metric: (index, doubles, blobs) => writeMetric(env, index, doubles, blobs),
  now: () => Date.now(),
  random: () => Math.random(),
});

/**
 * Delivers one activity to each of its `Queued` targets (`runOutboxDelivery`):
 * one instance per activity, ten inboxes to a step. Cloudflare Workflows
 * limits relied on: 10,000 steps per instance on Paid (1,024 on Free; the run
 * stops at 1,000 and the stuck-delivery sweep restarts it; sleeps do not
 * count), sleeps of at most about 14 hours, or a 12-hour `Retry-After` (the
 * cap is 365 days), no limit on an instance's wall-clock time, and a
 * sleeping instance does not count toward the concurrent-instance limit.
 */
export class OutboxDeliveryWorkflow extends WorkflowEntrypoint<Env, OutboxWorkflowParams> {
  override async run(event: WorkflowEvent<OutboxWorkflowParams>, step: WorkflowStep) {
    const parsed = schemaResult(OutboxWorkflowParamsSchema)(event.payload);
    if (parsed.isErr()) {
      return { kind: "InvalidJob" as const };
    }
    const params = parsed.value;
    const scope = {
      activityId: params.activityId,
      inboxUrl: params.kind === "DeliverTarget" ? params.inboxUrl : null,
    };
    return withMetricsBudget(this.env, "workflow", () =>
      runOutboxDelivery(workflowSteps(step), outboxDeliveryRunDeps(this.env), scope),
    );
  }
}

warmSchemas([OutboxWorkflowParamsSchema]);
