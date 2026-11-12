import { onTestFinished, vi } from "vite-plus/test";

/**
 * Answer the link-preview fetches for `urls` with a 404 while a test runs,
 * and wait for them; other fetches fall through to the real one.
 *
 * Storing a status unfurls its first link in the test file's isolate after
 * the request has answered. A link on an unresolvable `*.example` host fails
 * its DNS lookup, which the unfurl treats as transient, so it is queued as a
 * `ProcessLinkCard` job, retried, exhausted and dead-lettered, logging
 * `OutboxJobExhausted` and `OutboxJobDeadLettered` seconds later. When such
 * a log lands as the test file ends, Vitest closes the file's RPC with the
 * log in flight and fails the whole run with `Closing rpc while
 * "onUserConsoleLog" was pending`.
 *
 * A 404 settles the unfurl on its first attempt (a non-HTML or missing page is
 * never retried) and stores no card, as the unresolvable host did; `settled`
 * waits until every expected fetch was answered, so no unfurl of the test
 * is left to reach DNS or log after it.
 *
 * `urls` lists one entry per unfurl: two statuses whose first link is the
 * same URL unfurl it twice and fetch it twice. Call it inside a test: the
 * stub is removed when that test finishes.
 */
export const answerLinkPreviews = (
  urls: ReadonlyArray<string>,
): { settled: () => Promise<void> } => {
  const expected = new Map<string, number>();
  for (const url of urls) {
    expected.set(url, (expected.get(url) ?? 0) + 1);
  }
  const answered = new Map<string, number>();
  const original = globalThis.fetch;
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!expected.has(href)) {
        return original(input, init);
      }
      answered.set(href, (answered.get(href) ?? 0) + 1);
      return new Response("not found", { status: 404 });
    });
  onTestFinished(() => spy.mockRestore());
  return {
    settled: () =>
      vi.waitFor(
        () => {
          for (const [url, count] of expected) {
            if ((answered.get(url) ?? 0) < count) {
              throw new Error(`link preview of ${url} not fetched yet`);
            }
          }
        },
        { timeout: 10_000, interval: 20 },
      ),
  };
};
