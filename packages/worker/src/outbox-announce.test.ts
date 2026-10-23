import { schemaResult } from "@tstodon/core";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { MastodonAccountPreviewSchema } from "../test/mastodon-preview-schemas";
import { listOutboundActivities } from "./outbox-store";

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
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const headers = async (email: string) => ({
  "content-type": "application/json",
  ...(await accessAuthHeaders(email)),
});

const account = async (email: string) =>
  read(
    MastodonAccountPreviewSchema,
    (await json("/api/v1/accounts/verify_credentials", { headers: await headers(email) })).body,
  );

const post = async (email: string, status: string, visibility: string): Promise<string> => {
  const created = await json("/api/v1/statuses", {
    method: "POST",
    headers: await headers(email),
    body: JSON.stringify({ status, visibility }),
  });
  expect(created.status).toBe(200);
  return read(z.object({ id: z.string() }), created.body).id;
};

const boost = async (email: string, statusId: string, path = "reblog") =>
  json(`/api/v1/statuses/${statusId}/${path}`, { method: "POST", headers: await headers(email) });

const AnnounceSchema = z.object({
  "@context": z.string(),
  id: z.string(),
  type: z.literal("Announce"),
  actor: z.string(),
  published: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  object: z.string(),
});

const activitiesOf = async (accountId: string, kind: string) => {
  const rows = await listOutboundActivities(env.DB, accountId, 50);
  if (rows.isErr()) {
    throw new Error(rows.error.message);
  }
  return rows.value
    .filter((row) => row.kind === kind)
    .map((row): unknown => JSON.parse(row.payload_json));
};

describe("outbox and boosts", () => {
  it("fills an outbox page with public items only", async () => {
    const email = "outbox-paging@example.com";
    const author = await account(email);
    const first = await post(email, "first public", "public");
    const second = await post(email, "second unlisted", "unlisted");
    const hidden = await post(email, "followers only", "private");
    // A self-boost of a followers-only note is followers-only too.
    expect((await boost(email, hidden)).status).toBe(200);
    await post(email, "direct to nobody", "direct");

    const outbox = read(
      z.object({ orderedItems: z.array(z.object({ type: z.string(), object: z.unknown() })) }),
      (await json(`/users/${author.username}/outbox?limit=2`)).body,
    );
    // Before filtering moved into SQL, the newest non-public rows used up the limit.
    expect(outbox.orderedItems).toHaveLength(2);
    const ids = outbox.orderedItems.map((item) =>
      read(z.object({ id: z.string() }), item.object)
        .id.split("/")
        .pop(),
    );
    expect(ids).toEqual([second, first]);
  });

  it("announces a boost with Mastodon's addressing and the note's own URI", async () => {
    const author = await account("boost-author@example.com");
    const booster = await account("boost-booster@example.com");
    const noteId = await post("boost-author@example.com", "boost me", "public");
    expect((await boost("boost-booster@example.com", noteId)).status).toBe(200);

    const [announce] = (await activitiesOf(booster.id, "Announce")).map((raw) =>
      read(AnnounceSchema, raw),
    );
    const boosterUri = `https://example.com/users/${booster.username}`;
    const authorUri = `https://example.com/users/${author.username}`;
    expect(announce).toMatchObject({
      actor: boosterUri,
      to: [PUBLIC],
      cc: [authorUri, `${boosterUri}/followers`],
      object: `${authorUri}/statuses/${noteId}`,
    });
    expect(announce?.id).toMatch(new RegExp(`^${boosterUri}/statuses/[^/]+/activity$`));
  });

  it("undoes the same Announce when the boost is withdrawn", async () => {
    const booster = await account("unboost-booster@example.com");
    const noteId = await post("unboost-author@example.com", "boost then unboost", "unlisted");
    expect((await boost("unboost-booster@example.com", noteId)).status).toBe(200);
    expect((await boost("unboost-booster@example.com", noteId, "unreblog")).status).toBe(200);

    const announce = read(AnnounceSchema, (await activitiesOf(booster.id, "Announce"))[0]);
    const undo = read(
      z.object({
        id: z.string(),
        type: z.literal("Undo"),
        to: z.array(z.string()),
        cc: z.array(z.string()),
        object: AnnounceSchema.omit({ "@context": true }),
      }),
      (await activitiesOf(booster.id, "Undo"))[0],
    );
    expect(undo.id).toBe(`${announce.id}/undo`);
    expect(undo.object.id).toBe(announce.id);
    expect(undo.to).toEqual(announce.to);
    expect(undo.cc).toEqual(announce.cc);
    // Boosting an unlisted note takes the booster's default visibility, as in Mastodon.
    expect([...announce.to, ...announce.cc]).toContain(PUBLIC);
  });
});
