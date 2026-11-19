import { env } from "cloudflare:test";
import { vi } from "vite-plus/test";
import { z } from "zod";
import { handleQueue } from "../server/queue-handler";
import { meter, meterWork, resetMeter } from "./meter";

/** D1's queries per Worker invocation (Workers Paid). */
export const QUERIES_PER_INVOCATION = 1000;
/** The Worker's built `wrangler.json`, where Void writes `app/queues/*.ts`'s consumer options. */
const builtConfig = "../dist/ssr/wrangler.json";
const BuiltQueues = z.object({
  queues: z.object({
    consumers: z.array(z.object({ queue: z.string(), max_batch_size: z.number() })),
  }),
});
const consumers = BuiltQueues.parse(await import(/* @vite-ignore */ builtConfig)).queues.consumers;

/** Messages one outbox queue invocation takes (`maxBatchSize`), as built. */
export const QUEUE_BATCH =
  consumers.find((consumer) => consumer.queue === "tstodon-outbox-process")?.max_batch_size ?? 0;

export type HeldQueue = Readonly<{ bodies: unknown[] }>;

/** Queue messages the Worker sends from now on, held here instead of sent. */
export const holdQueue = (): HeldQueue => {
  const bodies: unknown[] = [];
  const proto = Object.getPrototypeOf(env.OUTBOX_PROCESS_QUEUE);
  vi.spyOn(proto, "send").mockImplementation((body: unknown) => {
    bodies.push(body);
  });
  vi.spyOn(proto, "sendBatch").mockImplementation((messages: unknown) => {
    for (const message of Array.isArray(messages) ? messages : []) {
      bodies.push(
        typeof message === "object" && message !== null ? Reflect.get(message, "body") : undefined,
      );
    }
  });
  return { bodies };
};

export const kindOf = (body: unknown): unknown =>
  typeof body === "object" && body !== null ? Reflect.get(body, "kind") : undefined;

/**
 * Run the held jobs of `kinds` through the queue handler, `QUEUE_BATCH` per
 * invocation, until none is left, the jobs they queue included; jobs of
 * other kinds are dropped. The most D1 statements one invocation made.
 */
export const drainHeld = async (held: HeldQueue, kinds: ReadonlyArray<string>): Promise<number> => {
  let most = 0;
  for (;;) {
    const taken = held.bodies.splice(0).filter((body) => kinds.includes(String(kindOf(body))));
    if (taken.length === 0) {
      return most;
    }
    for (let start = 0; start < taken.length; start += QUEUE_BATCH) {
      resetMeter();
      await meterWork(() =>
        handleQueue(
          {
            messages: taken.slice(start, start + QUEUE_BATCH).map((body) => ({
              body,
              attempts: 1,
              ack: () => undefined,
              retry: () => {
                throw new Error(`job retried: ${JSON.stringify(body)}`);
              },
            })),
          },
          env,
        ),
      );
      most = Math.max(most, meter.tally.statements);
    }
  }
};
