import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { PNG_40X30 } from "../test/image-fixtures";
import { z } from "zod";
import { ApiSourceStatus } from "@tstodon/api";
import { schemaResult } from "@tstodon/core";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";

const auth = (email: string): Promise<Record<string, string>> => authHeaders(email);

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

const IdSchema = z.object({ id: z.string().min(1) });

const post = async (email: string, params: Record<string, unknown>): Promise<string> => {
  const created = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(params),
  });
  expect(created.status).toBe(200);
  return read(IdSchema, created.body).id;
};

/** `DELETE /api/v1/statuses/:id`, its body read as Mastodon's source-requested status. */
const deleteStatus = async (email: string, id: string) => {
  const deleted = await json(`/api/v1/statuses/${id}`, {
    method: "DELETE",
    headers: await auth(email),
  });
  expect(deleted.status).toBe(200);
  return { raw: deleted.body, document: expectContract(ApiSourceStatus, deleted.body) };
};

const keysOf = (value: unknown): string[] =>
  typeof value === "object" && value !== null ? Object.keys(value) : [];

describe("delete returns a redraft source", () => {
  it("answers the source text in place of content, with the media, reply, and settings", async () => {
    const email = "redraft-author@example.com";

    const form = new FormData();
    form.set("file", new File([PNG_40X30], "a.png", { type: "image/png" }));
    const uploaded = await json("/api/v2/media", {
      method: "POST",
      headers: await auth(email),
      body: form,
    });
    const mediaId = read(IdSchema, uploaded.body).id;
    const parentId = await post(email, { status: "the parent" });
    const statusId = await post(email, {
      status: "redraft me #tag",
      media_ids: [mediaId],
      in_reply_to_id: parentId,
      spoiler_text: "a warning",
      sensitive: true,
      language: "de",
    });

    const { raw, document } = await deleteStatus(email, statusId);
    expect(document.id).toBe(statusId);
    // Mastodon's `source_requested` renders `text` instead of `content`.
    expect(document.text).toBe("redraft me #tag");
    expect(keysOf(raw)).not.toContain("content");
    expect(document.spoiler_text).toBe("a warning");
    expect(document.sensitive).toBe(true);
    expect(document.language).toBe("de");
    expect(document.in_reply_to_id).toBe(parentId);
    expect(document.media_attachments.map((attachment) => attachment.id)).toEqual([mediaId]);
    expect(document.poll).toBeNull();

    expect((await json(`/api/v1/statuses/${statusId}`)).status).toBe(404);
  });

  it("includes the poll and its options", async () => {
    const email = "redraft-poll@example.com";
    const statusId = await post(email, {
      status: "pick one",
      poll: { options: ["red", "blue"], expires_in: 3600, multiple: true },
    });

    const { document } = await deleteStatus(email, statusId);
    expect(document.text).toBe("pick one");
    expect(document.poll?.options.map((option) => option.title)).toEqual(["red", "blue"]);
    expect(document.poll?.multiple).toBe(true);
  });

  it("answers an empty source for a deleted reblog and the source of what it boosted", async () => {
    const email = "redraft-reblog@example.com";
    const originalId = await post(email, { status: "original *source*" });
    const reblog = await json(`/api/v1/statuses/${originalId}/reblog`, {
      method: "POST",
      headers: await auth(email),
    });
    const reblogId = read(IdSchema, reblog.body).id;

    const { raw, document } = await deleteStatus(email, reblogId);
    expect(document.text).toBe("");
    expect(document.reblog?.id).toBe(originalId);
    expect(document.reblog?.text).toBe("original *source*");
    expect(keysOf(read(z.object({ reblog: z.unknown() }), raw).reblog)).not.toContain("content");
  });

  it("shows the status of a quote not yet accepted, so the redraft keeps it", async () => {
    const email = "redraft-quote@example.com";
    await signedInAccount(email);
    const bob = await remoteActor("redraft-quote-bob");
    const uri = "https://remote.example/notes/redraft-quote";
    const sent = await bob.send({
      id: `${uri}/activity`,
      type: "Create",
      object: {
        id: uri,
        type: "Note",
        attributedTo: bob.actorUri,
        content: "<p>quote <b>me</b></p>",
        published: "2026-11-01T00:00:00.000Z",
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        cc: [`${bob.actorUri}/followers`],
        interactionPolicy: {
          canQuote: { automaticApproval: ["https://www.w3.org/ns/activitystreams#Public"] },
        },
      },
    });
    expect(sent).toBe(202);
    const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
      .bind(uri)
      .first();
    const quotedId = read(IdSchema, row).id;
    const statusId = await post(email, { status: "quoting", quoted_status_id: quotedId });

    const { raw, document } = await deleteStatus(email, statusId);
    expect(document.quote?.state).toBe("pending");
    expect(document.quote?.quoted_status?.id).toBe(quotedId);
    // A remote status's source is the HTML it came with.
    expect(document.quote?.quoted_status?.text).toBe("<p>quote <b>me</b></p>");
    const rawQuote = read(z.object({ quote: z.object({ quoted_status: z.unknown() }) }), raw);
    expect(keysOf(rawQuote.quote.quoted_status)).not.toContain("content");

    // A quote of that quote shows it with its source, naming what it quotes.
    const innerId = await post(email, { status: "inner *source*", quoted_status_id: quotedId });
    const outerId = await post(email, { status: "outer", quoted_status_id: innerId });
    const outer = (await deleteStatus(email, outerId)).document;
    expect(outer.quote?.state).toBe("accepted");
    expect(outer.quote?.quoted_status?.text).toBe("inner *source*");
    expect(outer.quote?.quoted_status?.quote).toEqual({
      state: "pending",
      quoted_status_id: quotedId,
    });
  });
});
