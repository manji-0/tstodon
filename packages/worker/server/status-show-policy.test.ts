import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const body: unknown = contentType.includes("json") && text.length > 0 ? JSON.parse(text) : text;
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

const Ids = z.array(z.object({ id: z.string() }));

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

const statusOf = async (path: string, email?: string) =>
  (await json(path, email ? { headers: await authHeaders(email) } : undefined)).status;

const idsAt = async (path: string, email: string): Promise<string[]> => {
  const response = await json(path, { headers: await authHeaders(email) });
  expect(response.status, path).toBe(200);
  return read(Ids, response.body).map((entry) => entry.id);
};

/** Mastodon's `StatusPolicy#show?`: a public or unlisted status is hidden from viewers its author blocks. */
describe("a status whose author blocks the viewer", () => {
  it("is not served to the blocked viewer by id, in context, embeds or engagement lists", async () => {
    const author = "abv-author@example.com";
    const viewer = "abv-viewer@example.com";
    const viewerId = (await signedInAccount(viewer)).id;
    const publicId = await posted(author, { status: "public", visibility: "public" });
    const unlistedId = await posted(author, { status: "unlisted", visibility: "unlisted" });
    const replyId = await posted(viewer, { status: "a reply", in_reply_to_id: publicId });
    expect(await statusOf(`/api/v1/statuses/${publicId}`, viewer)).toBe(200);

    await post(author, `/api/v1/accounts/${viewerId}/block`);

    for (const id of [publicId, unlistedId]) {
      expect(await statusOf(`/api/v1/statuses/${id}`, viewer)).toBe(404);
      expect(await statusOf(`/api/v1/statuses/${id}/context`, viewer)).toBe(404);
      expect(await statusOf(`/api/v1/statuses/${id}/favourited_by`, viewer)).toBe(404);
      expect(await statusOf(`/api/v1/statuses/${id}/reblogged_by`, viewer)).toBe(404);
      // Anonymous viewers and the author still see it.
      expect(await statusOf(`/api/v1/statuses/${id}`)).toBe(200);
      expect(await statusOf(`/api/v1/statuses/${id}`, author)).toBe(200);
    }
    expect(await statusOf(`/api/web/embeds/${publicId}`, viewer)).toBe(404);
    expect(await statusOf(`/api/web/embeds/${publicId}`)).toBe(200);
    expect(await idsAt(`/api/v1/statuses?id[]=${publicId}&id[]=${replyId}`, viewer)).toEqual([
      replyId,
    ]);
    const context = read(
      z.object({ ancestors: Ids }),
      (await json(`/api/v1/statuses/${replyId}/context`, { headers: await authHeaders(viewer) }))
        .body,
    );
    expect(context.ancestors).toEqual([]);
  });

  it("stays visible to a viewer who blocks the author", async () => {
    const author = "abv-blocked-author@example.com";
    const viewer = "abv-blocking-viewer@example.com";
    const authorId = (await signedInAccount(author)).id;
    const statusId = await posted(author, { status: "still shown", visibility: "public" });

    await post(viewer, `/api/v1/accounts/${authorId}/block`);

    expect(await statusOf(`/api/v1/statuses/${statusId}`, viewer)).toBe(200);
  });

  it("hides a cached remote status from the local account its author blocks", async () => {
    const viewer = "abv-remote-viewer@example.com";
    const username = (await signedInAccount(viewer)).username;
    const remote = await remoteActor("abv-remote-blocker");
    const uri = `${remote.actorUri}/statuses/abv-1`;
    expect(
      await remote.send({
        id: `${uri}/activity`,
        type: "Create",
        object: {
          id: uri,
          type: "Note",
          attributedTo: remote.actorUri,
          content: "<p>remote note</p>",
          published: new Date().toISOString(),
          to: [PUBLIC],
          cc: [`${remote.actorUri}/followers`],
        },
      }),
    ).toBe(202);
    const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
      .bind(uri)
      .first<{ id: string }>();
    const statusId = row?.id ?? "";
    expect(await statusOf(`/api/v1/statuses/${statusId}`, viewer)).toBe(200);

    expect(
      await remote.send({
        id: `${remote.actorUri}#blocks/abv`,
        type: "Block",
        object: `https://example.com/users/${username}`,
      }),
    ).toBe(202);

    expect(await statusOf(`/api/v1/statuses/${statusId}`, viewer)).toBe(404);
    expect(await statusOf(`/api/v1/statuses/${statusId}`)).toBe(200);
  });
});

describe("a followers-only status", () => {
  it("is shown to the accounts it mentions as well as followers", async () => {
    const author = "ssp-private-author@example.com";
    const mentioned = "ssp-private-mentioned@example.com";
    const stranger = "ssp-private-stranger@example.com";
    const name = (await signedInAccount(mentioned)).username;
    await signedInAccount(stranger);
    const statusId = await posted(author, { status: `hi @${name}`, visibility: "private" });

    expect(await statusOf(`/api/v1/statuses/${statusId}`, mentioned)).toBe(200);
    expect(await statusOf(`/api/v1/statuses/${statusId}`, stranger)).toBe(404);
    expect(await statusOf(`/api/v1/statuses/${statusId}`)).toBe(404);
  });
});

/** A direct note is also shown to whoever may see the direct note it replies to, through direct notes only. */
describe("a direct reply chain", () => {
  it("shows each reply to an account mentioned only at its root, and stops at a non-direct note", async () => {
    const alice = "drc-alice@example.com";
    const bob = "drc-bob@example.com";
    const carol = "drc-carol@example.com";
    const viewer = "drc-viewer@example.com";
    const stranger = "drc-stranger@example.com";
    const names = new Map<string, string>();
    for (const email of [alice, bob, carol, viewer, stranger]) {
      names.set(email, (await signedInAccount(email)).username);
    }
    const at = (email: string) => `@${names.get(email) ?? ""}`;
    const root = await posted(alice, {
      status: `${at(bob)} ${at(carol)} ${at(viewer)} root`,
      visibility: "direct",
    });
    const reply = await posted(bob, {
      status: `${at(alice)} reply`,
      visibility: "direct",
      in_reply_to_id: root,
    });
    const deeper = await posted(carol, {
      status: `${at(bob)} deeper`,
      visibility: "direct",
      in_reply_to_id: reply,
    });
    const privateRoot = await posted(alice, {
      status: `${at(bob)} ${at(viewer)} followers only`,
      visibility: "private",
    });
    const offPrivate = await posted(bob, {
      status: `${at(alice)} off a private note`,
      visibility: "direct",
      in_reply_to_id: privateRoot,
    });

    for (const id of [root, reply, deeper]) {
      expect(await statusOf(`/api/v1/statuses/${id}`, viewer), id).toBe(200);
      expect(await statusOf(`/api/v1/statuses/${id}`, stranger), id).toBe(404);
    }
    expect(await statusOf(`/api/v1/statuses/${privateRoot}`, viewer)).toBe(200);
    expect(await statusOf(`/api/v1/statuses/${offPrivate}`, viewer)).toBe(404);
    const context = await json(`/api/v1/statuses/${root}/context`, {
      headers: await authHeaders(viewer),
    });
    expect(read(z.object({ descendants: Ids }), context.body).descendants.map((s) => s.id)).toEqual(
      [reply, deeper],
    );
  });
});
