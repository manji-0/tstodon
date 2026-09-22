import {
  DELIVERY_MAX_ATTEMPTS,
  DeliveryAttemptOutcome,
  OutboxDelivery,
  OutboxJob,
} from "@tstodon/domain";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { attemptInboxDelivery } from "./delivery";
import { ensureOutboxTarget, persistOutboxTarget } from "./outbox-store";
import { parseJsonText } from "./schemas";

export type OutboxWorkflowParams = Readonly<{
  kind: "DeliverTarget";
  activityId: string;
  inboxUrl: string;
}>;

const noStepRetry = {
  retries: { limit: 0, delay: "1 second" as const },
};

export class OutboxDeliveryWorkflow extends WorkflowEntrypoint<
  Env,
  OutboxWorkflowParams
> {
  override async run(event: WorkflowEvent<OutboxWorkflowParams>, step: WorkflowStep) {
    const parsed = OutboxJob.parse(event.payload);
    if (parsed.isErr() || parsed.value.kind !== "DeliverTarget") {
      return { kind: "InvalidJob" as const };
    }
    const job = parsed.value;

    for (let attempt = 0; attempt < DELIVERY_MAX_ATTEMPTS; attempt += 1) {
      const slotRaw = await step.do(
        `load-${attempt}`,
        noStepRetry,
        async () => {
          const loaded = await ensureOutboxTarget(
            this.env.DB,
            job.activityId,
            job.inboxUrl,
          );
          const delivery = loaded.isErr() ? OutboxDelivery.queued() : loaded.value;
          return JSON.stringify(delivery);
        },
      );
      const slotJson = parseJsonText(slotRaw);
      const slot = slotJson.isErr()
        ? undefined
        : OutboxDelivery.parse(slotJson.value);
      if (!slot || slot.isErr() || slot.value.kind !== "Queued") {
        return slot && slot.isOk() ? slot.value : { kind: "InvalidJob" as const };
      }
      const outcomeRaw = await step.do(
        `post-${attempt}`,
        noStepRetry,
        async () => JSON.stringify(await attemptInboxDelivery(this.env, job)),
      );
      const outcomeJson = parseJsonText(outcomeRaw);
      const outcome = outcomeJson.isErr()
        ? undefined
        : DeliveryAttemptOutcome.parse(outcomeJson.value);
      if (!outcome || outcome.isErr()) {
        return { kind: "InvalidJob" as const };
      }
      const next = OutboxDelivery.afterAttempt(slot.value, outcome.value);
      await step.do(
        `save-${attempt}`,
        noStepRetry,
        async () => {
          await persistOutboxTarget(this.env.DB, job.activityId, job.inboxUrl, next);
          return next.kind;
        },
      );
      if (next.kind !== "Queued") {
        return next;
      }
      await step.sleep(`backoff-${attempt}`, OutboxDelivery.workflowSleep(next.attemptCount));
    }
    return {
      kind: "Failed" as const,
      reasonKind: "RetryExhausted" as const,
      attemptCount: DELIVERY_MAX_ATTEMPTS,
    };
  }
}
