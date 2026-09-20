import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

export type OutboxWorkflowParams = Readonly<{
  activityId: string;
}>;

export class OutboxDeliveryWorkflow extends WorkflowEntrypoint<
  Env,
  OutboxWorkflowParams
> {
  override async run(event: WorkflowEvent<OutboxWorkflowParams>, step: WorkflowStep) {
    return step.do("ack-queued", async () => ({
      kind: "ExpandFollowers" as const,
      activityId: event.payload.activityId,
    }));
  }
}
