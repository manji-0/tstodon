// Vite plugins that fill gaps in Void's Cloudflare build (see `vite.config.ts`).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite-plus";
import { z } from "zod";

const root = import.meta.dirname;
const entryClassesFile = path.join(root, "server/entry-classes.ts");
const queuesDir = path.join(root, "app/queues");

/**
 * Void generates the Worker entry (`.void/entry.ts`) and only exports its own
 * Durable Object classes from it. The Workflow and Durable Object classes that
 * `wrangler.jsonc` binds have to be exported from the same module, so append
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

// Same shape Void reads `maxBatchSize` / `maxRetries` with from a queue file.
const MAX_CONCURRENCY = /export\s+const\s+maxConcurrency\s*=\s*(\d+)/;
const DEAD_LETTER_QUEUE = /export\s+const\s+deadLetterQueue\s*=\s*"([A-Za-z0-9-]+)"/;

/** What a queue file declares that Void does not write itself. */
type DeclaredConsumerOptions = Readonly<{
  maxConcurrency: number | undefined;
  deadLetterQueue: string | undefined;
}>;

/**
 * Per queue name, from `export const maxConcurrency = N` and
 * `export const deadLetterQueue = "name"` in `app/queues/<name>.ts`.
 */
const declaredConsumerOptions = (): ReadonlyMap<string, DeclaredConsumerOptions> =>
  new Map(
    readdirSync(queuesDir)
      .filter((file) => /\.(m?ts|m?js)$/.test(file) && !file.startsWith("_"))
      .map((file) => {
        const source = readFileSync(path.join(queuesDir, file), "utf8");
        const concurrency = source.match(MAX_CONCURRENCY)?.[1];
        return [
          file.replace(/\.[^.]+$/, ""),
          {
            maxConcurrency: concurrency ? Number(concurrency) : undefined,
            deadLetterQueue: source.match(DEAD_LETTER_QUEUE)?.[1],
          },
        ] as const;
      }),
  );

const WranglerOutput = z.looseObject({
  queues: z
    .looseObject({
      consumers: z.array(z.looseObject({ queue: z.string() })).optional(),
    })
    .optional(),
});

/**
 * Void writes each queue consumer from `app/queues/<name>.ts` but has no
 * `max_concurrency` or `dead_letter_queue` option. Read
 * `export const maxConcurrency = N` and `export const deadLetterQueue = "name"`
 * from the same file and set them on the consumer in the emitted
 * `wrangler.json`, so `wrangler deploy` applies them. A declared value
 * without a consumer fails the build, and so does a dead-letter queue that
 * has no consumer file of its own (its messages would sit unread).
 */
export const queueConsumerOptions = (): Plugin => ({
  name: "tstodon:queue-consumer-options",
  enforce: "post",
  generateBundle(_options, bundle) {
    const asset = bundle["wrangler.json"];
    if (asset?.type !== "asset" || typeof asset.source !== "string") {
      return;
    }
    const parsed = WranglerOutput.safeParse(JSON.parse(asset.source));
    if (!parsed.success) {
      this.error(`unexpected wrangler.json shape: ${parsed.error.message}`);
    }
    const config = parsed.data;
    const consumers = config.queues?.consumers ?? [];
    const declared = declaredConsumerOptions();
    for (const [queue, options] of declared) {
      if (options.maxConcurrency === undefined && options.deadLetterQueue === undefined) {
        continue;
      }
      const consumer = consumers.find((entry) => entry.queue === queue);
      if (!consumer) {
        this.error(`queues/${queue} declares consumer options but wrangler.json has no consumer`);
      }
      if (options.maxConcurrency !== undefined) {
        consumer.max_concurrency = options.maxConcurrency;
      }
      if (options.deadLetterQueue !== undefined) {
        if (!declared.has(options.deadLetterQueue) || options.deadLetterQueue === queue) {
          this.error(
            `queues/${queue} dead-letters to ${options.deadLetterQueue}, which has no queues/${options.deadLetterQueue}.ts consumer`,
          );
        }
        consumer.dead_letter_queue = options.deadLetterQueue;
      }
    }
    asset.source = JSON.stringify(config);
  },
});
