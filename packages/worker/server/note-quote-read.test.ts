import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { failingQuoteReads } from "../test/d1-fault";
import { listOutboundActivities } from "./outbox-store";
import { processDistributePollUpdateJob } from "./poll-update";

/**
 * A note's `quote` read back for its document: a transient D1 error is a
 * failed answer, never a cached document without the quote, and never a
 * `Create` or `Update` without it.
 */

const ORIGIN = "https://example.com";
const AP_ACCEPT = "application/activity+json";

const send = async (email: string, method: string, path: string, body: unknown) => {
  const response = await SELF.fetch(new URL(path, ORIGIN), {
    method,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status, `${method} ${path}`).toBe(200);
  return expectContract(ApiStatus, await response.json());
};

const post = (email: string, body: unknown) => send(email, "POST", "/api/v1/statuses", body);

const fetchAs = (path: string) =>
  SELF.fetch(new URL(path, ORIGIN), { headers: { Accept: AP_ACCEPT } });

const ActivitySchema = z.object({
  type: z.string(),
  object: z.object({ id: z.string() }),
});

/** How many `type` activities of `objectId` the account queued. */
const queued = async (accountId: string, type: string, objectId: string): Promise<number> => {
  const rows = await listOutboundActivities(env.DB, accountId, 100);
  return (rows.isOk() ? rows.value : []).filter((row) => {
    const parsed = ActivitySchema.safeParse(JSON.parse(row.payload_json));
    return parsed.success && parsed.data.type === type && parsed.data.object.id === objectId;
  }).length;
};

/** The JSON lines logged with `console.error` while `run` runs. */
const loggedDuring = async (run: () => Promise<unknown>): Promise<unknown[]> => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  let calls: unknown[][] = [];
  try {
    await run();
  } finally {
    calls = [...logged.mock.calls];
    logged.mockRestore();
  }
  return calls.flatMap(([line]) => {
    try {
      return [JSON.parse(String(line))];
    } catch {
      return [];
    }
  });
};

describe("a local note's quote, when it cannot be read", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails the note and the outbox page, uncached", async () => {
    await signedInAccount("note-quote-read-quoted@example.com");
    const quoter = await signedInAccount("note-quote-read-quoter@example.com");
    const quoted = await post("note-quote-read-quoted@example.com", { status: "quote me" });
    const quoting = await post("note-quote-read-quoter@example.com", {
      status: "quoting",
      quoted_status_id: quoted.id,
    });
    const notePath = `/users/${quoter.username}/statuses/${quoting.id}`;
    const pagePath = `/users/${quoter.username}/outbox?page=true`;
    const QuoteOf = z.object({ quote: z.string() });
    const note = await fetchAs(notePath);
    expect(note.status).toBe(200);
    expect(QuoteOf.parse(await note.json()).quote).toBe(quoted.uri);

    const [failedNote, failedPage] = await failingQuoteReads(quoting.id, async () => [
      await fetchAs(notePath),
      await fetchAs(pagePath),
    ]);
    for (const response of [failedNote, failedPage]) {
      expect(response.status, response.url).toBe(500);
      expect(response.headers.get("Cache-Control"), response.url).toBeNull();
    }
  });

  it("sends no Create or Update without it, and logs the quote as the cause", async () => {
    const author = "note-quote-federate@example.com";
    const account = await signedInAccount(author);
    const quoted = await post(author, { status: "quoted by the next ones" });

    // As a control, a quote post is queued as its `Create` and its edit as an `Update`.
    const control = await post(author, { status: "quoting", quoted_status_id: quoted.id });
    expect(await queued(account.id, "Create", control.uri)).toBe(1);

    let published: z.infer<typeof ApiStatus> | undefined;
    const onPublish = await loggedDuring(() =>
      failingQuoteReads(undefined, async () => {
        published = await post(author, { status: "quoting again", quoted_status_id: quoted.id });
      }),
    );
    const posted = published;
    if (!posted) {
      throw new Error("the post was not answered");
    }
    expect(await queued(account.id, "Create", posted.uri)).toBe(0);
    expect(onPublish).toContainEqual({
      kind: "StatusNotFederated",
      statusId: posted.id,
      cause: "quote",
    });

    // The edits are of the control: the post above still owes its `Create`,
    // which an edit leaves to send the post's current version.
    await send(author, "PUT", `/api/v1/statuses/${control.id}`, { status: "edited once" });
    expect(await queued(account.id, "Update", control.uri)).toBe(1);
    const onEdit = await loggedDuring(() =>
      failingQuoteReads(control.id, () =>
        send(author, "PUT", `/api/v1/statuses/${control.id}`, { status: "edited twice" }),
      ),
    );
    expect(await queued(account.id, "Update", control.uri)).toBe(1);
    expect(onEdit).toContainEqual({
      kind: "StatusUpdateNotFederated",
      statusId: control.id,
      cause: "quote",
    });

    // A poll's `Update` of its counts is an implicit update for Mastodon, which keeps the
    // quote it has: it goes out without the quote it could not read.
    const poll = await post(author, {
      status: "a poll",
      poll: { options: ["yes", "no"], expires_in: 3600 },
    });
    const pollId = poll.poll?.id ?? "";
    const job = { kind: "DistributePollUpdate", pollId } as const;
    await processDistributePollUpdateJob(env, job);
    expect(await queued(account.id, "Update", poll.uri)).toBe(1);
    const onPollUpdate = await loggedDuring(() =>
      failingQuoteReads(undefined, () => processDistributePollUpdateJob(env, job)),
    );
    expect(await queued(account.id, "Update", poll.uri)).toBe(2);
    expect(onPollUpdate).toEqual([]);
  });
});
