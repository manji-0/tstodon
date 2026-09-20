import { app } from "./app";
import { handleQueue } from "./queue-handler";
import { OutboxDeliveryWorkflow } from "./outbox-delivery-workflow";
import { handleScheduled } from "./scheduled-handler";
import { StreamHub } from "./stream-hub";

export { OutboxDeliveryWorkflow, StreamHub };

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  queue: handleQueue,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;
