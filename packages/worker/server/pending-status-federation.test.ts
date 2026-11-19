import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { beforeBatch, failingQuoteReads, failingReads, failingStatements } from "../test/d1-fault";
import { PNG_40X30 } from "../test/image-fixtures";
import { LocalAccountModeration } from "@tstodon/domain";
import { saveLocalAccountModeration } from "./account-moderation-store";
import { processDistributePollUpdateJob } from "./poll-update";
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
  signature: z.object({ creator: z.string() }).optional(),
  object: z.union([
    z.string(),
    z.object({
      "@context": z.unknown().optional(),
      id: z.string(),
      content: z.string().optional(),
      quote: z.string().optional(),
      attachment: z.array(z.unknown()).optional(),
    }),
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
    // Built and Linked-Data-signed as the post path does it (FED-13).
    expect(creates[0]?.object).not.toHaveProperty("@context");
    expect(creates[0]?.signature?.creator).toBe(`${ORIGIN}/users/${account.username}#main-key`);
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
    expect(requests[0]?.signature?.creator).toBe(`${ORIGIN}/users/${account.username}#main-key`);
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
      failingQuoteReads(posted.id, async () => {
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
    expect(updates[0]?.object).not.toHaveProperty("@context");
    expect(updates[0]?.signature?.creator).toBe(`${ORIGIN}/users/${account.username}#main-key`);
    expect(await queued(account.id, "Create", posted.uri)).toHaveLength(1);
  });
});

/** The batch that stores an owed activity. */
const storesOwed = (sql: string): boolean =>
  sql.includes("INSERT INTO outbound_activities") && sql.includes("pending_status_federations");

describe("a retry whose post changes between its read and its store", () => {
  it("stores nothing for the version it read, and sends the edited one", async () => {
    const { email, account, posted } = await unfederatedQuote("raced-edit");

    await beforeBatch(
      storesOwed,
      () => send(email, "PUT", `/api/v1/statuses/${posted.id}`, { status: "raced: edited" }),
      () => retry(posted.id),
    );
    await retry(posted.id);

    const creates = await queued(account.id, "Create", posted.uri);
    expect(creates).toHaveLength(1);
    expect(creates[0]?.object).toMatchObject({ content: expect.stringContaining("raced: edited") });
  });

  it("stores nothing once the post is deleted", async () => {
    const { email, account, posted } = await unfederatedQuote("raced-delete");

    await beforeBatch(
      storesOwed,
      async () => {
        const deleted = await request(email, "DELETE", `/api/v1/statuses/${posted.id}`);
        expect(deleted.status).toBe(200);
      },
      () => retry(posted.id),
    );
    await retry(posted.id);

    expect(await queued(account.id, "Create", posted.uri)).toHaveLength(0);
  });
});

const NotFederatedLine = z.object({
  kind: z.literal("StatusNotFederated"),
  statusId: z.string(),
  cause: z.string(),
});

describe("a post whose media does not read back when it is stored", () => {
  it("sends its Create, with the media, once the media reads", async () => {
    const email = "pending-media@example.com";
    const account = await signedInAccount(email);
    const upload = new FormData();
    upload.set("file", new File([PNG_40X30], "a.png", { type: "image/png" }));
    const uploaded = await SELF.fetch(`${ORIGIN}/api/v2/media`, {
      method: "POST",
      headers: await authHeaders(email),
      body: upload,
    });
    expect(uploaded.status).toBe(200);
    const media = z.object({ id: z.string() }).parse(await uploaded.json());

    // Only the read that builds the note's attachments, once the note is
    // stored: the first one after its `notify` followers are listed.
    let stored = false;
    let failed = false;
    const logged = await loggedDuring(() =>
      failingReads(
        (sql, params) => {
          stored ||= sql.includes("notify != 0");
          const fails =
            stored &&
            !failed &&
            sql.includes("FROM media_attachments") &&
            params.some((param) => typeof param === "string" && param.includes(media.id));
          failed ||= fails;
          return fails;
        },
        () => send(email, "POST", "/api/v1/statuses", { status: "media", media_ids: [media.id] }),
      ),
    );
    const notFederated = logged.flatMap((line) => {
      const parsed = NotFederatedLine.safeParse(line);
      return parsed.success ? [parsed.data] : [];
    });
    expect(notFederated.map((line) => line.cause)).toEqual(["media"]);
    const statusId = notFederated[0]?.statusId ?? "";
    const uri = `https://example.com/users/${account.username}/statuses/${statusId}`;
    expect(await queued(account.id, "Create", uri)).toHaveLength(0);

    await retry(statusId);

    const creates = await queued(account.id, "Create", uri);
    expect(creates).toHaveLength(1);
    expect(creates[0]?.object).toMatchObject({ attachment: [expect.anything()] });
  });
});

describe("a post whose author is barred before the retry", () => {
  it("is never sent, even once the author is let back in", async () => {
    const { account, posted } = await unfederatedQuote("barred");
    const disabled = LocalAccountModeration.apply(LocalAccountModeration.inGoodStanding, "disable");
    expect((await saveLocalAccountModeration(env.DB, account.id, disabled)).isOk()).toBe(true);

    await retry(posted.id);
    const enabled = LocalAccountModeration.inGoodStanding;
    expect((await saveLocalAccountModeration(env.DB, account.id, enabled)).isOk()).toBe(true);
    await retry(posted.id);

    expect(await queued(account.id, "Create", posted.uri)).toHaveLength(0);
  });
});

describe("an edit that cannot tell whether its post still owes a Create", () => {
  it("sends no Update then, and sends it later", async () => {
    const email = "pending-unknown-owed@example.com";
    const account = await signedInAccount(email);
    const posted = await post(email, { status: "posted" });
    expect(await queued(account.id, "Create", posted.uri)).toHaveLength(1);

    const logged = await loggedDuring(() =>
      failingStatements(
        (sql, params) =>
          /^\s*UPDATE pending_status_federations\b/.test(sql) && params.includes(posted.id),
        () => send(email, "PUT", `/api/v1/statuses/${posted.id}`, { status: "edited: unknown" }),
      ),
    );
    expect(logged).toContainEqual({
      kind: "StatusUpdateNotFederated",
      statusId: posted.id,
      cause: "pending",
    });
    expect(await queued(account.id, "Update", posted.uri)).toHaveLength(0);
    await retry(posted.id);

    const updates = await queued(account.id, "Update", posted.uri);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.object).toMatchObject({
      content: expect.stringContaining("edited: unknown"),
    });
    expect(await queued(account.id, "Create", posted.uri)).toHaveLength(1);
  });
});

describe("a poll whose Create is still owed", () => {
  it("sends its counts with the Create, not in an Update before it", async () => {
    const email = "pending-poll@example.com";
    const account = await signedInAccount(email);
    const poll = await failingQuoteReads(undefined, () =>
      post(email, { status: "a poll", poll: { options: ["yes", "no"], expires_in: 3600 } }),
    );
    expect(await queued(account.id, "Create", poll.uri)).toHaveLength(0);

    const pollId = poll.poll?.id ?? "";
    await processDistributePollUpdateJob(env, { kind: "DistributePollUpdate", pollId });
    await retry(poll.id);

    expect(await queued(account.id, "Update", poll.uri)).toHaveLength(0);
    expect(await queued(account.id, "Create", poll.uri)).toHaveLength(1);
  });
});
