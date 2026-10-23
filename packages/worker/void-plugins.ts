// Vite plugins that fill gaps in Void's Cloudflare build (see `vite.config.ts`).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite-plus";
import { z } from "zod";

const root = import.meta.dirname;
const entryClassesFile = path.join(root, "src/entry-classes.ts");
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

/** `max_concurrency` per queue name, from `export const maxConcurrency = N` in `app/queues/<name>.ts`. */
const declaredConcurrency = (): ReadonlyMap<string, number> =>
  new Map(
    readdirSync(queuesDir)
      .filter((file) => /\.(m?ts|m?js)$/.test(file) && !file.startsWith("_"))
      .flatMap((file) => {
        const match = readFileSync(path.join(queuesDir, file), "utf8").match(MAX_CONCURRENCY);
        return match?.[1] ? [[file.replace(/\.[^.]+$/, ""), Number(match[1])] as const] : [];
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
 * `max_concurrency` option. Read `export const maxConcurrency = N` from the
 * same file and set it on the consumer in the emitted `wrangler.json`, so
 * `wrangler deploy` applies it. A declared value without a consumer fails the build.
 */
export const queueConsumerConcurrency = (): Plugin => ({
  name: "tstodon:queue-consumer-concurrency",
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
    for (const [queue, maxConcurrency] of declaredConcurrency()) {
      const consumer = consumers.find((entry) => entry.queue === queue);
      if (!consumer) {
        this.error(`queues/${queue} declares maxConcurrency but wrangler.json has no consumer`);
      }
      consumer.max_concurrency = maxConcurrency;
    }
    asset.source = JSON.stringify(config);
  },
});
