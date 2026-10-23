import { env } from "cloudflare:workers";
import { defineQueue } from "void";
import { handleQueue } from "../../src/queue-handler";

export const maxBatchSize = 10;
export const maxBatchTimeout = 0;
export const maxRetries = 3;

// Void types its `env` argument loosely; the module `env` carries the generated `Env`.
export default defineQueue((batch) => handleQueue(batch, env));
