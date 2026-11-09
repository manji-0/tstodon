import { Hostname, OutboxJob } from "@tstodon/domain";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { attemptInboxDeliveryWithEvidence } from "./delivery";
import {
  cachedDeliveryDomainHealth,
  recordInboxReachability,
} from "./delivery-domain-health-store";
import { withMetricsBudget, writeMetric } from "./metrics";
import { type DeliveryRunDeps, type DeliverySteps, runOutboxDelivery } from "./outbox-delivery-run";
import { ensureOutboxTarget, persistOutboxTarget } from "./outbox-store";

export type OutboxWorkflowParams = Readonly<{
  kind: "DeliverTarget";
  activityId: string;
  inboxUrl: string;
}>;

/** D1 reads and writes: idempotent, so a failed one is tried again a few times. */
const d1Step = {
  retries: { limit: 3, delay: "10 seconds" as const, backoff: "exponential" as const },
};

/** The inbox POST: one try per attempt; the delivery's own backoff retries it. */
const postStep = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "2 minutes" as const,
};

const workflowSteps = (step: WorkflowStep): DeliverySteps => ({
  run: (name, kind, work) => step.do(name, kind === "post" ? postStep : d1Step, work),
  sleep: (name, ms) => step.sleep(name, ms),
});

export const outboxDeliveryRunDeps = (env: Env): DeliveryRunDeps => ({
  load: (job) => ensureOutboxTarget(env.DB, job.activityId, job.inboxUrl),
  domainUnavailable: async (inboxUrl) => {
    const host = Hostname.ofUri(inboxUrl);
    return (
      host !== undefined && (await cachedDeliveryDomainHealth(env.DB, host))?.kind === "Unavailable"
    );
  },
  attempt: (job) => attemptInboxDeliveryWithEvidence(env, job),
  persist: (job, delivery, nextAttemptAt, lastHttpStatus) =>
    persistOutboxTarget(
      env.DB,
      job.activityId,
      job.inboxUrl,
      delivery,
      nextAttemptAt,
      lastHttpStatus,
    ),
  recordReachability: (inboxUrl, reachability) =>
    recordInboxReachability(env, inboxUrl, reachability),
  metric: (index, doubles, blobs) => writeMetric(env, index, doubles, blobs),
  now: () => Date.now(),
  random: () => Math.random(),
});

/**
 * Delivers one activity to one inbox (`runOutboxDelivery`). Cloudflare
 * Workflows limits relied on: at most 17 × 3 steps per instance (the cap is
 * 1,024 on Free, 10,000 on Paid; sleeps do not count), sleeps of at most
 * about 14 hours, or a 12-hour `Retry-After` (the cap is 365 days), no limit
 * on an instance's wall-clock time, and a sleeping instance does not count
 * toward the concurrent-instance limit.
 */
export class OutboxDeliveryWorkflow extends WorkflowEntrypoint<Env, OutboxWorkflowParams> {
  override async run(event: WorkflowEvent<OutboxWorkflowParams>, step: WorkflowStep) {
    const parsed = OutboxJob.parse(event.payload);
    if (parsed.isErr() || parsed.value.kind !== "DeliverTarget") {
      return { kind: "InvalidJob" as const };
    }
    const job = parsed.value;
    return withMetricsBudget(this.env, "workflow", () =>
      runOutboxDelivery(workflowSteps(step), outboxDeliveryRunDeps(this.env), job),
    );
  }
}
