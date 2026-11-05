import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const EmbeddedAccount = z.object({
  id: z.string(),
  display_name: z.string(),
  suspended: z.boolean().optional(),
});
const Status = z.object({
  id: z.string(),
  account: EmbeddedAccount,
  reblog: z.object({ id: z.string(), account: EmbeddedAccount }).nullable(),
  quote: z
    .object({ state: z.string(), quoted_status: z.object({ id: z.string() }).nullable() })
    .nullable()
    .optional(),
});
const Statuses = z.array(Status);
const Ids = z.array(z.object({ id: z.string() }));

const admin = () => authHeaders("status-author-admin@example.com", { admin: true });

const post = async (email: string, path: string, body: unknown = {}) => {
  const response = await json(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status, path).toBe(200);
  return response.body;
};

const posted = async (email: string, body: Record<string, unknown>) =>
  read(z.object({ id: z.string() }), await post(email, "/api/v1/statuses", body)).id;

const suspend = async (accountId: string) => {
  const response = await json(`/api/v1/admin/accounts/${accountId}/suspend`, {
    method: "POST",
    headers: await admin(),
  });
  expect(response.status).toBe(200);
};

const getAs = async (path: string, email?: string) =>
  json(path, email ? { headers: await authHeaders(email) } : undefined);

const statusAt = async (path: string, email?: string) => {
  const response = await getAs(path, email);
  expect(response.status, path).toBe(200);
  return read(Status, response.body);
};

const idsAt = async (path: string, email?: string): Promise<string[]> => {
  const response = await getAs(path, email);
  expect(response.status, path).toBe(200);
  return read(Ids, response.body).map((entry) => entry.id);
};

const acceptedFollow = async (email: string, remote: Remote, slug: string) => {
  await post(email, `/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/follow`);
  const viewer = await signedInAccount(email);
  const row = await env.DB.prepare(
    "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
  )
    .bind(viewer.id, remote.actorUri)
    .first<{ follow_activity_id: string }>();
  expect(
    await remote.send({
      id: `${remote.actorUri}/accepts/${slug}`,
      type: "Accept",
      object: row?.follow_activity_id,
    }),
  ).toBe(202);
};

const remoteNote = async (remote: Remote, uri: string, published: string) => {
  expect(
    await remote.send({
      id: `${uri}/activity`,
      type: "Create",
      object: {
        id: uri,
        type: "Note",
        attributedTo: remote.actorUri,
        content: "<p>remote note</p>",
        published,
        to: [PUBLIC],
        cc: [`${remote.actorUri}/followers`],
      },
    }),
  ).toBe(202);
  const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
    .bind(uri)
    .first<{ id: string }>();
  expect(row?.id).toBeDefined();
  return row?.id ?? "";
};

describe("a status whose local author is suspended", () => {
  it("is not served by id, in a batch, or in a thread's context", async () => {
    const author = "sa-local-author@example.com";
    const viewer = "sa-local-viewer@example.com";
    const authorId = (await signedInAccount(author)).id;
    const statusId = await posted(author, { status: "before the suspension" });
    const replyId = await posted(viewer, { status: "a reply", in_reply_to_id: statusId });
    expect((await statusAt(`/api/v1/statuses/${statusId}`, viewer)).account.display_name).not.toBe(
      "",
    );

    await suspend(authorId);

    expect((await getAs(`/api/v1/statuses/${statusId}`, viewer)).status).toBe(404);
    expect((await getAs(`/api/v1/statuses/${statusId}`)).status).toBe(404);
    expect(await idsAt(`/api/v1/statuses?id[]=${statusId}&id[]=${replyId}`, viewer)).toEqual([
      replyId,
    ]);
    const context = read(
      z.object({ ancestors: Ids }),
      (await getAs(`/api/v1/statuses/${replyId}/context`, viewer)).body,
    );
    expect(context.ancestors).toEqual([]);
  });

  it("stays in another account's boost with the author stripped", async () => {
    const author = "sa-boosted-author@example.com";
    const booster = "sa-booster@example.com";
    const authorId = (await signedInAccount(author)).id;
    const statusId = await posted(author, { status: "boost me" });
    const boost = read(Status, await post(booster, `/api/v1/statuses/${statusId}/reblog`));

    await suspend(authorId);

    const served = await statusAt(`/api/v1/statuses/${boost.id}`, booster);
    expect(served.reblog?.id).toBe(statusId);
    expect(served.reblog?.account).toMatchObject({
      id: authorId,
      display_name: "",
      suspended: true,
    });
    expect(served.account.suspended).toBeUndefined();
  });

  it("leaves a suspended booster's boost unserved", async () => {
    const author = "sa-boost-kept-author@example.com";
    const booster = "sa-suspended-booster@example.com";
    const boosterId = (await signedInAccount(booster)).id;
    const statusId = await posted(author, { status: "boost me too" });
    const boost = read(Status, await post(booster, `/api/v1/statuses/${statusId}/reblog`));

    await suspend(boosterId);

    expect((await getAs(`/api/v1/statuses/${boost.id}`, author)).status).toBe(404);
  });

  it("renders a quote of it as unauthorized", async () => {
    const author = "sa-quoted-author@example.com";
    const quoter = "sa-quoter@example.com";
    const authorId = (await signedInAccount(author)).id;
    const statusId = await posted(author, { status: "quote me" });
    const quoteId = await posted(quoter, { status: "quoting", quoted_status_id: statusId });
    expect((await statusAt(`/api/v1/statuses/${quoteId}`, quoter)).quote?.state).toBe("accepted");

    await suspend(authorId);

    expect((await statusAt(`/api/v1/statuses/${quoteId}`, quoter)).quote).toEqual({
      state: "unauthorized",
      quoted_status: null,
    });
  });

  it("leaves the follower's home timeline without cutting the page short", async () => {
    const author = "sa-home-author@example.com";
    const viewer = "sa-home-viewer@example.com";
    const authorId = (await signedInAccount(author)).id;
    await post(viewer, `/api/v1/accounts/${authorId}/follow`);
    const ownId = await posted(viewer, { status: "mine" });
    await posted(author, { status: "followed one" });
    await posted(author, { status: "followed two" });

    await suspend(authorId);

    expect(await idsAt("/api/v1/timelines/home?limit=1", viewer)).toEqual([ownId]);
  });

  it("is served to a moderator in its report, author stripped", async () => {
    const author = "sa-reported-author@example.com";
    const authorId = (await signedInAccount(author)).id;
    const statusId = await posted(author, { status: "reported" });
    const report = read(
      z.object({ id: z.string() }),
      await post("sa-reporter@example.com", "/api/v1/reports", {
        account_id: authorId,
        status_ids: [statusId],
        category: "spam",
      }),
    );

    await suspend(authorId);

    const response = await json(`/api/v1/admin/reports/${report.id}`, { headers: await admin() });
    expect(response.status).toBe(200);
    const statuses = read(z.object({ statuses: Statuses }), response.body).statuses;
    expect(statuses.map((status) => status.id)).toEqual([statusId]);
    expect(statuses[0]?.account).toMatchObject({ display_name: "", suspended: true });
  });
});

describe("a status whose remote author is suspended", () => {
  it("is not served by id, and a boost of it carries the author stripped", async () => {
    const viewer = "sa-remote-viewer@example.com";
    const author = await remoteActor("sa-author", "sa-author.example");
    const booster = await remoteActor("sa-booster", "sa-booster.example");
    const authorId = RemoteAccountId.encode(author.actorUri);
    await acceptedFollow(viewer, booster, "sa-booster");
    const noteUri = "https://sa-author.example/notes/one";
    const statusId = await remoteNote(author, noteUri, "2026-10-20T00:00:00.000Z");
    const announceId = "https://sa-booster.example/announces/one";
    expect(
      await booster.send({
        id: announceId,
        type: "Announce",
        object: noteUri,
        published: "2026-10-21T00:00:00.000Z",
        to: [PUBLIC],
        cc: [`${booster.actorUri}/followers`],
      }),
    ).toBe(202);
    const boostId = (
      await idsAt(`/api/v1/accounts/${RemoteAccountId.encode(booster.actorUri)}/statuses`, viewer)
    )[0];
    expect(boostId).toBeDefined();
    expect((await statusAt(`/api/v1/statuses/${statusId}`, viewer)).account.id).toBe(authorId);

    await suspend(authorId);

    expect((await getAs(`/api/v1/statuses/${statusId}`, viewer)).status).toBe(404);
    const boost = await statusAt(`/api/v1/statuses/${boostId}`, viewer);
    expect(boost.reblog?.id).toBe(statusId);
    expect(boost.reblog?.account).toMatchObject({
      id: authorId,
      display_name: "",
      suspended: true,
    });
  });
});
