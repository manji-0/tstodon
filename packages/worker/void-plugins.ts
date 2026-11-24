// Vite plugins that fill gaps in Void's Cloudflare build (see `vite.config.ts`).
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite-plus";
import { z } from "zod";

const root = import.meta.dirname;
const entryClassesFile = path.join(root, "server/entry-classes.ts");
const queuesDir = path.join(root, "app/queues");

/**
 * Void generates the Worker entry (`.void/entry.ts`) and only exports its own
 * Durable Object classes from it. The Workflow and Durable Object classes that
 * the Worker config (`cloudflare` in `void.config.ts`) binds have to be
 * exported from the same module, so append
 * them to the generated entry. A Worker build that never saw that entry fails,
 * so a Void upgrade that moves it cannot ship a Worker without the classes.
 */
export const exportEntryClasses = (): Plugin => {
  let injected = false;
  return {
    name: "tstodon:export-entry-classes",
    enforce: "post",
    transform(code, id) {
      if (!id.split("?")[0]?.endsWith("/.void/entry.ts")) {
        return null;
      }
      injected = true;
      return { code: `${code}\nexport * from ${JSON.stringify(entryClassesFile)};\n`, map: null };
    },
    buildEnd(error) {
      const workerBuild =
        this.environment.mode === "build" && this.environment.config.consumer === "server";
      if (!error && workerBuild && !injected) {
        this.error(
          "Void's generated .void/entry.ts was not built; Workflow and DO classes are missing",
        );
      }
    },
  };
};

// Same shape Void reads `maxBatchSize` / `maxConcurrency` with from a queue file.
const DEAD_LETTER_QUEUE = /export\s+const\s+deadLetterQueue\s*=\s*"([A-Za-z0-9-]+)"/;

/** Per queue name, the `export const deadLetterQueue = "name"` of `app/queues/<name>.ts`. */
const declaredDeadLetterQueues = (): ReadonlyMap<string, string | undefined> =>
  new Map(
    readdirSync(queuesDir)
      .filter((file) => /\.(m?ts|m?js)$/.test(file) && !file.startsWith("_"))
      .map((file) => {
        const source = readFileSync(path.join(queuesDir, file), "utf8");
        return [file.replace(/\.[^.]+$/, ""), source.match(DEAD_LETTER_QUEUE)?.[1]] as const;
      }),
  );

const BuiltWranglerConfig = z.looseObject({
  queues: z.looseObject({
    consumers: z.array(z.looseObject({ queue: z.string() })),
  }),
});

const BuiltWorkerConfig = z.looseObject({
  triggers: z.array(z.looseObject({ type: z.string(), name: z.string().optional() })),
});

const failure = (message: string) => new Error(`tstodon:queue-dead-letter-queues: ${message}`);

const readJson = <T>(file: string, schema: z.ZodType<T>): T => {
  if (!existsSync(file)) {
    throw failure(`${path.relative(root, file)} was not written; Void's build output moved`);
  }
  const parsed = schema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw failure(`unexpected ${path.relative(root, file)} shape: ${parsed.error.message}`);
  }
  return parsed.data;
};

/**
 * Void writes each queue consumer from `app/queues/<name>.ts` but has no
 * `dead_letter_queue` option. Read `export const deadLetterQueue = "name"`
 * from the same file and set it on the consumer in both build outputs: the
 * Cloudflare Build Output `void deploy` uploads
 * (`.cloudflare/output/v1/workers/default/worker.config.json`) and the
 * `dist/ssr/wrangler.json` the Worker tests and `wrangler deploy --dry-run`
 * read. A declaration without a consumer fails the build, and so does a
 * dead-letter queue that has no consumer file of its own (its messages would
 * sit unread).
 */
export const queueDeadLetterQueues = (): Plugin => ({
  name: "tstodon:queue-dead-letter-queues",
  // With `order: "post"`, after Void's `void:cloudflare-build-output` (also
  // `enforce: "post"`, earlier in the plugin list), which writes both files.
  enforce: "post",
  buildApp: {
    order: "post",
    async handler() {
      const declared = declaredDeadLetterQueues();
      const deadLetters = [...declared].flatMap(([queue, deadLetterQueue]) =>
        deadLetterQueue === undefined ? [] : [{ queue, deadLetterQueue }],
      );
      for (const { queue, deadLetterQueue } of deadLetters) {
        if (!declared.has(deadLetterQueue) || deadLetterQueue === queue) {
          throw failure(
            `queues/${queue} dead-letters to ${deadLetterQueue}, which has no queues/${deadLetterQueue}.ts consumer`,
          );
        }
      }

      const workerConfigFile = path.join(
        root,
        ".cloudflare/output/v1/workers/default/worker.config.json",
      );
      const worker = readJson(workerConfigFile, BuiltWorkerConfig);
      const wranglerFile = path.join(root, "dist/ssr/wrangler.json");
      const wrangler = readJson(wranglerFile, BuiltWranglerConfig);

      for (const { queue, deadLetterQueue } of deadLetters) {
        const trigger = worker.triggers.find(
          (entry) => entry.type === "queue" && entry.name === queue,
        );
        const consumer = wrangler.queues.consumers.find((entry) => entry.queue === queue);
        if (!trigger || !consumer) {
          throw failure(
            `queues/${queue} declares a dead-letter queue but the build has no consumer for it`,
          );
        }
        trigger.deadLetterQueue = deadLetterQueue;
        consumer.dead_letter_queue = deadLetterQueue;
      }
      writeFileSync(workerConfigFile, JSON.stringify(worker));
      writeFileSync(wranglerFile, `${JSON.stringify(wrangler, null, 2)}\n`);
    },
  },
});
