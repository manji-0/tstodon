import { SELF, env } from "cloudflare:test";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { ApiPoll, ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { accessTokenFor, authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { parseSignatureHeader, verifySignedFetch } from "./http-signature";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const options = (counts: ReadonlyArray<number | null>) =>
  counts.map((totalItems, index) => ({
    type: "Note",
    name: `option ${index}`,
    replies: { type: "Collection", totalItems },
  }));

const question = (
  author: Remote,
  slug: string,
  counts: ReadonlyArray<number | null>,
  endTime = "2099-01-01T00:00:00Z",
) => ({
  "@context": "https://www.w3.org/ns/activitystreams",
  id: `https://${new URL(author.actorUri).host}/questions/${slug}`,
  type: "Question",
  attributedTo: author.actorUri,
  content: "<p>Which one?</p>",
  published: "2026-10-20T00:00:00.000Z",
  endTime,
  to: [PUBLIC],
  oneOf: options(counts),
});

const create = async (author: Remote, object: Readonly<{ id: string }>): Promise<string> => {
  expect(await author.send({ id: `${object.id}/create`, type: "Create", object })).toBe(202);
  const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
    .bind(object.id)
    .first();
  const id = row?.["id"];
  if (typeof id !== "string") {
    throw new Error("remote question was not stored");
  }
  return id;
};

/** Serve `document` at its id while the test runs; the count of fetches of it. */
const serve = (
  document: Readonly<{ id: string }>,
): {
  fetches: () => number;
  requests: () => ReadonlyArray<Request>;
  failWith: (status: number | undefined) => void;
} => {
  let fetches = 0;
  const requests: Request[] = [];
  let failing: number | undefined;
  const original = globalThis.fetch;
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (href !== document.id) {
        return original(input, init);
      }
      fetches += 1;
      requests.push(new Request(input, init));
      if (failing !== undefined) {
        return new Response("unavailable", { status: failing });
      }
      return new Response(JSON.stringify(document), {
        headers: { "content-type": "application/activity+json" },
      });
    });
  onTestFinished(() => spy.mockRestore());
  return {
    fetches: () => fetches,
    requests: () => requests,
    failWith: (status) => {
      failing = status;
    },
  };
};

const readPoll = async (id: string, headers: Record<string, string>) => {
  const response = await SELF.fetch(`https://example.com/api/v1/polls/remote-${id}`, { headers });
  expect(response.status).toBe(200);
  return expectContract(ApiPoll, await response.json());
};

const tallies = (poll: Readonly<{ options: ReadonlyArray<{ votes_count: number | null }> }>) =>
  poll.options.map((option) => option.votes_count);

/** When the poll was last fetched: `poll_fetched_at`, moved as a minute passing would. */
const setFetchedAt = async (id: string, at: string | null) => {
  await env.DB.prepare("UPDATE remote_statuses SET poll_fetched_at = ? WHERE id = ?")
    .bind(at, id)
    .run();
};

describe("refreshing a remote poll a client reads", () => {
  it("fetches the poll from its server for a signed-in reader, as Mastodon's PollsController", async () => {
    const author = await remoteActor("poll-refresh", "poll-refresh.example");
    const id = await create(author, question(author, "fresh", [1, 0]));
    const origin = serve(question(author, "fresh", [4, 2]));
    const reader = await authHeaders("poll-refresh-reader@example.com");

    expect(tallies(await readPoll(id, {}))).toEqual([1, 0]);
    expect(origin.fetches()).toBe(0);

    expect(tallies(await readPoll(id, reader))).toEqual([4, 2]);
    expect(origin.fetches()).toBe(1);

    // Fetched within the last minute: not fetched again.
    expect(tallies(await readPoll(id, reader))).toEqual([4, 2]);
    expect(origin.fetches()).toBe(1);

    await setFetchedAt(id, new Date(Date.now() - 61_000).toISOString());
    await readPoll(id, reader);
    expect(origin.fetches()).toBe(2);
  });

  it("signs the fetch as the reader, as FetchRemotePollService passes current_account", async () => {
    const author = await remoteActor("poll-refresh-signer", "poll-refresh-signer.example");
    const id = await create(author, question(author, "signer", [1, 0]));
    const origin = serve(question(author, "signer", [2, 0]));
    const account = await signedInAccount("poll-refresh-signer@example.com");
    const reader = { Authorization: `Bearer ${await accessTokenFor(account.id)}` };

    await readPoll(id, reader);

    const [request] = origin.requests();
    const parsed = parseSignatureHeader(request?.headers.get("Signature") ?? "");
    expect(parsed?.keyId).toBe(`https://example.com/users/${account.username}#main-key`);
    expect(
      request !== undefined &&
        parsed !== undefined &&
        (await verifySignedFetch(request, parsed, {
          kind: "Rsa",
          publicKeyPem: account.publicKeyPem,
        })),
    ).toBe(true);
  });

  it("does not refresh a poll through the status it belongs to", async () => {
    const author = await remoteActor("poll-refresh-status", "poll-refresh-status.example");
    const id = await create(author, question(author, "status", [1, 0]));
    const origin = serve(question(author, "status", [4, 2]));
    const shown = await SELF.fetch(`https://example.com/api/v1/statuses/${id}`, {
      headers: await authHeaders("poll-refresh-status@example.com"),
    });
    expect(expectContract(ApiStatus, await shown.json()).poll?.options[0]?.votes_count).toBe(1);
    expect(origin.fetches()).toBe(0);
  });

  it("fetches an ended poll once more only when it was last fetched before it ended", async () => {
    const author = await remoteActor("poll-refresh-ended", "poll-refresh-ended.example");
    const ended = "2026-11-01T00:00:00.000Z";
    const id = await create(author, question(author, "ended", [1, 0], ended));
    const origin = serve(question(author, "ended", [3, 1], ended));
    const reader = await authHeaders("poll-refresh-ended@example.com");

    await setFetchedAt(id, "2026-10-31T00:00:00.000Z");
    expect(tallies(await readPoll(id, reader))).toEqual([3, 1]);
    expect(origin.fetches()).toBe(1);

    await setFetchedAt(id, "2026-11-02T00:00:00.000Z");
    await readPoll(id, reader);
    expect(origin.fetches()).toBe(1);
  });

  it("keeps an ended poll stale when its fetch fails, as Mastodon records only a fetch that updated it", async () => {
    const author = await remoteActor("poll-refresh-failed", "poll-refresh-failed.example");
    const ended = "2026-11-01T00:00:00.000Z";
    const id = await create(author, question(author, "failed", [1, 0], ended));
    const origin = serve(question(author, "failed", [3, 1], ended));
    const reader = await authHeaders("poll-refresh-failed@example.com");
    await setFetchedAt(id, "2026-10-31T00:00:00.000Z");

    origin.failWith(503);
    expect(tallies(await readPoll(id, reader))).toEqual([1, 0]);
    expect(origin.fetches()).toBe(1);

    // The failed fetch left the poll as it was, so the next read fetches it.
    const stored = await env.DB.prepare("SELECT poll_fetched_at FROM remote_statuses WHERE id = ?")
      .bind(id)
      .first();
    expect(stored?.["poll_fetched_at"]).toBe("2026-10-31T00:00:00.000Z");
    origin.failWith(undefined);
    expect(tallies(await readPoll(id, reader))).toEqual([3, 1]);
    expect(origin.fetches()).toBe(2);
  });

  it("records an inbox Update of the poll as a fetch", async () => {
    const author = await remoteActor("poll-refresh-update", "poll-refresh-update.example");
    const id = await create(author, question(author, "update", [1, 0]));
    expect(
      await author.send({
        id: `${author.actorUri}/updates/1`,
        type: "Update",
        object: question(author, "update", [2, 0]),
      }),
    ).toBe(202);
    const origin = serve(question(author, "update", [5, 0]));
    expect(
      tallies(await readPoll(id, await authHeaders("poll-refresh-update@example.com"))),
    ).toEqual([2, 0]);
    expect(origin.fetches()).toBe(0);
  });

  it("reads an option whose count is null, as Mastodon sends for a poll that hides its totals", async () => {
    const author = await remoteActor("poll-hidden-totals", "poll-hidden-totals.example");
    const id = await create(author, question(author, "hidden", [null, null]));
    expect(tallies(await readPoll(id, {}))).toEqual([0, 0]);
  });
});
