import { AsyncLocalStorage } from "node:async_hooks";
import { waitUntil } from "cloudflare:workers";

type Work = Readonly<{ kind: string; work: () => Promise<unknown> }>;

/** The work this request put off until its response is ready. */
const queues = new AsyncLocalStorage<Work[]>();

const start = ({ kind, work }: Work): Promise<void> =>
  work().then(
    () => undefined,
    (cause: unknown) => {
      console.error(
        JSON.stringify({ kind, error: cause instanceof Error ? cause.message : String(cause) }),
      );
    },
  );

/**
 * Run `work` once the response is ready instead of on its critical path, for
 * side effects nothing in the response depends on (stream events, Web Push).
 * Inside {@link withAfterResponse} it starts when the handler has returned;
 * elsewhere (a queue batch, a cron run) it starts now. Either way the
 * invocation stays alive until it settles. A failure is logged as `{ kind }`.
 */
export const afterResponse = (kind: string, work: () => Promise<unknown>): void => {
  const queue = queues.getStore();
  if (queue) {
    queue.push({ kind, work });
    return;
  }
  waitUntil(start({ kind, work }));
};

/**
 * Run a request handler, then start the work it handed to
 * {@link afterResponse}, outside this scope so work it queues starts at once.
 */
export const withAfterResponse = async <T>(run: () => Promise<T>): Promise<T> => {
  const queue: Work[] = [];
  try {
    return await queues.run(queue, run);
  } finally {
    if (queue.length > 0) {
      waitUntil(queues.exit(() => Promise.all(queue.map(start))));
    }
  }
};
