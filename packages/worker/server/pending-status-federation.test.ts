import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { failingQuoteReads } from "../test/d1-fault";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { processOutboxJob } from "./outbox-job";

/**
 * A local post whose `Create`, or an edit whose `Update`, could not be built
 * when it was stored (its quote or media did not read back) is federated
 * later by the retries of `FederatePendingStatuses` (FED-14).
 */

const ORIGIN = "https://example.com";
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const request = async (email: string, method: string, path: string, body?: unknown) =>
  SELF.fetch(new URL(path, ORIGIN), {
    method,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const send = async (email: string, method: string, path: string, body: unknown) => {
  const response = await request(email, method, path, body);
  expect(response.status, `${method} ${path}`).toBe(200);
  return expectContract(ApiStatus, await response.json());
};

const post = (email: string, body: unknown) => send(email, "POST", "/api/v1/statuses", body);

const ActivitySchema = z.object({
  id: z.string(),
  type: z.string(),
  object: z.union([
    z.string(),
    z.object({ id: z.string(), content: z.string().optional(), quote: z.string().optional() }),
  ]),
  instrument: z.object({ id: z.string() }).optional(),
});

type Activity = z.infer<typeof ActivitySchema>;

const objectId = (activity: Activity): string =>
  typeof activity.object === "string" ? activity.object : activity.object.id;

/** The `type` activities the account queued about `uri`, oldest first. */
const queued = async (accountId: string, type: string, uri: string): Promise<Activity[]> => {
  const { results } = await env.DB.prepare(
    "SELECT payload_json FROM outbound_activities WHERE account_id = ? ORDER BY rowid",
  )
    .bind(accountId)
    .all();
  return z
    .array(z.object({ payload_json: z.string() }))
    .parse(results)
    .map((row) => ActivitySchema.parse(JSON.parse(row.payload_json)))
    .filter(
      (activity) =>
        activity.type === type && (objectId(activity) === uri || activity.instrument?.id === uri),
    );
};

/** Make the post's retry due now, as the time that passes before it would. */
const elapse = async (statusId: string): Promise<void> => {
  await env.DB.prepare(
    "UPDATE pending_status_federations SET next_attempt_at = '1970-01-01T00:00:00.000Z' WHERE status_id = ?",
  )
    .bind(statusId)
    .run();
};

/** One run of the retry job once the post's retry is due. */
const retry = async (statusId: string): Promise<void> => {
  await elapse(statusId);
  expect(await processOutboxJob(env, { kind: "FederatePendingStatuses" })).toBe("ok");
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

/** A quote post whose quote does not read back while it is stored. */
const unfederatedQuote = async (slug: string) => {
  const email = `pending-${slug}@example.com`;
  const account = await signedInAccount(email);
  const quoted = await post(email, { status: `${slug}: quoted` });
  const posted = await failingQuoteReads(undefined, () =>
    post(email, { status: `${slug}: quoting`, quoted_status_id: quoted.id }),
  );
  expect(await queued(account.id, "Create", posted.uri)).toHaveLength(0);
  return { email, account, quoted, posted };
};

const remoteNote = async (author: Remote, slug: string): Promise<string> => {
  const uri = `https://remote.example/notes/${slug}`;
  const object = {
    id: uri,
    type: "Note",
    attributedTo: author.actorUri,
    content: `<p>${slug}</p>`,
    published: "2026-11-01T00:00:00.000Z",
    to: [PUBLIC],
    cc: [`${author.actorUri}/followers`],
    interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } },
  };
  expect(await author.send({ id: `${uri}/activity`, type: "Create", object })).toBe(202);
  const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
    .bind(uri)
    .first();
  return z.object({ id: z.string() }).parse(row).id;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a post whose Create could not be built when it was stored", () => {
  it("is sent once its quote reads again, and only once", async () => {
    const { account, quoted, posted } = await unfederatedQuote("once");

    await retry(posted.id);
    await retry(posted.id);

    const creates = await queued(account.id, "Create", posted.uri);
    expect(creates).toHaveLength(1);
    expect(creates[0]?.object).toMatchObject({ id: posted.uri, quote: quoted.uri });
  });

  it("asks the remote quoted author with its QuoteRequest when it is sent", async () => {
    const email = "pending-remote-quote@example.com";
    const account = await signedInAccount(email);
    const bob = await remoteActor("pending-remote-quote-bob");
    const quotedId = await remoteNote(bob, "pending-remote-quote");
    const posted = await failingQuoteReads(undefined, () =>
      post(email, { status: "quoting bob", quoted_status_id: quotedId }),
    );
    expect(await queued(account.id, "Create", posted.uri)).toHaveLength(0);
    expect(await queued(account.id, "QuoteRequest", posted.uri)).toHaveLength(0);

    await retry(posted.id);
    await retry(posted.id);

    expect(await queued(account.id, "Create", posted.uri)).toHaveLength(1);
    const requests = await queued(account.id, "QuoteRequest", posted.uri);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.id).toContain(`/users/${account.username}/quote_requests/`);
    const shown = await request(email, "GET", `/api/v1/statuses/${posted.id}`);
    expect(expectContract(ApiStatus, await shown.json()).quote?.state).toBe("pending");
  });

  it("is never sent once it is deleted", async () => {
    const { email, account, posted } = await unfederatedQuote("deleted");

    const deleted = await request(email, "DELETE", `/api/v1/statuses/${posted.id}`);
    expect(deleted.status).toBe(200);
    await retry(posted.id);

    expect(await queued(account.id, "Create", posted.uri)).toHaveLength(0);
  });

  it("is sent as the Create of its current version when it was edited meanwhile", async () => {
    const { email, account, posted } = await unfederatedQuote("edited");

    await send(email, "PUT", `/api/v1/statuses/${posted.id}`, { status: "edited: now" });
    await retry(posted.id);

    const creates = await queued(account.id, "Create", posted.uri);
    expect(creates).toHaveLength(1);
    expect(creates[0]?.object).toMatchObject({ content: expect.stringContaining("edited: now") });
    expect(await queued(account.id, "Update", posted.uri)).toHaveLength(0);
  });

  it("is given up after its retries, and the give-up is logged", async () => {
    const { account, posted } = await unfederatedQuote("given-up");

    const logged = await loggedDuring(() =>
      failingQuoteReads(undefined, async () => {
        for (let run = 0; run < 20; run += 1) {
          await retry(posted.id);
        }
      }),
    );
    await retry(posted.id);

    expect(logged).toContainEqual(
      expect.objectContaining({ kind: "StatusFederationAbandoned", statusId: posted.id }),
    );
    expect(await queued(account.id, "Create", posted.uri)).toHaveLength(0);
  });
});

describe("an edit whose Update could not be built", () => {
  it("is sent later as an Update of the post's current version", async () => {
    const email = "pending-update@example.com";
    const account = await signedInAccount(email);
    const quoted = await post(email, { status: "quoted" });
    const posted = await post(email, { status: "quoting", quoted_status_id: quoted.id });
    expect(await queued(account.id, "Create", posted.uri)).toHaveLength(1);

    await failingQuoteReads(posted.id, () =>
      send(email, "PUT", `/api/v1/statuses/${posted.id}`, { status: "edited: first" }),
    );
    expect(await queued(account.id, "Update", posted.uri)).toHaveLength(0);
    await retry(posted.id);

    const updates = await queued(account.id, "Update", posted.uri);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.object).toMatchObject({
      quote: quoted.uri,
      content: expect.stringContaining("edited: first"),
    });
    expect(await queued(account.id, "Create", posted.uri)).toHaveLength(1);
  });
});
