import { AsyncLocalStorage } from "node:async_hooks";
import { waitUntil } from "cloudflare:workers";

type Work = Readonly<{ kind: string; work: () => Promise<unknown> }>;

/** Keeps the invocation alive until `promise` settles (`ExecutionContext.waitUntil`). */
export type KeepAlive = (promise: Promise<unknown>) => void;

/**
 * Where a request is: its handler still running, holding the work it put off
 * until the response is ready, or its response ready, its put-off work
 * running and kept alive by the request's own `keepAlive`.
 */
type RequestScope =
  | Readonly<{ kind: "Handling"; queue: Work[]; keepAlive: KeepAlive }>
  | Readonly<{ kind: "Responded"; keepAlive: KeepAlive }>;

const scopes = new AsyncLocalStorage<RequestScope>();

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
 * elsewhere (a queue batch, a cron run, or work already after the response)
 * it starts now. Either way the invocation stays alive until it settles. A
 * failure is logged as `{ kind }`.
 */
export const afterResponse = (kind: string, work: () => Promise<unknown>): void => {
  const scope = scopes.getStore();
  switch (scope?.kind) {
    case "Handling":
      scope.queue.push({ kind, work });
      return;
    case "Responded":
      scope.keepAlive(start({ kind, work }));
      return;
    case undefined:
      waitUntil(start({ kind, work }));
  }
};

/**
 * Run a request handler, then start the work it handed to
 * {@link afterResponse}, kept alive through the request's `keepAlive`.
 */
export const withAfterResponse = async <T>(
  keepAlive: KeepAlive,
  run: () => Promise<T>,
): Promise<T> => {
  const queue: Work[] = [];
  try {
    return await scopes.run({ kind: "Handling", queue, keepAlive }, run);
  } finally {
    if (queue.length > 0) {
      keepAlive(scopes.run({ kind: "Responded", keepAlive }, () => Promise.all(queue.map(start))));
    }
  }
};
