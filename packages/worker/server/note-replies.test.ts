import { schemaResult } from "@tstodon/core";
import { createExecutionContext, env, SELF } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  ApActivityDocument,
  ApRepliesDocument,
  ApRepliesPageDocument,
  ApStatusDocument,
} from "@tstodon/api/activitypub";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";
import { envWith } from "../test/env-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { listOtherNoteReplies, listSelfNoteRepliesJson } from "./generated/prisma/sql";
import { RemoteAccountId } from "./remote-account-id";
import { getUsersByUsernameStatusesByIdReplies } from "./routes/activitypub";
import { d1PrepareTyped } from "./typed-sql";

/**
 * INT-4, the `replies` collection of a local note in Mastodon's shape: the
 * note embeds a first page with its author's own replies, and `next` leads
 * to the rest of them, then to the replies of every other account, local or
 * cached from another server. Only public and unlisted replies are listed.
 */

const ORIGIN = "https://example.com";
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const activityJson = { headers: { accept: "application/activity+json" } };

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const Posted = z.object({ id: z.string(), uri: z.string() });

const post = async (email: string, body: Record<string, unknown>) => {
  const response = await SELF.fetch(`${ORIGIN}/api/v1/statuses`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return read(Posted, await response.json());
};

const noteDocument = async (uri: string) => {
  const response = await SELF.fetch(uri, activityJson);
  expect(response.status).toBe(200);
  return expectContract(ApStatusDocument, await response.json());
};

/** A note as its URI serves it, without the JSON-LD context a page item leaves out. */
const noteDocumentBody = async (uri: string) => {
  const { "@context": _context, ...note } = await noteDocument(uri);
  return note;
};

const itemIds = (items: ReadonlyArray<string | { id: string }>): string[] =>
  items.map((item) => (typeof item === "string" ? item : item.id));

const repliesPage = async (uri: string) => {
  const response = await SELF.fetch(uri, activityJson);
  expect(response.status, uri).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/activity+json");
  return expectContract(ApRepliesPageDocument, await response.json());
};

describe("a local note's replies collection", () => {
  it("lists the author's replies first, then every other account's in one id order", async () => {
    const author = "replies-author@example.com";
    const other = "replies-other@example.com";
    const root = await post(author, { status: "a root with replies" });
    const own = await post(author, { status: "my own reply", in_reply_to_id: root.id });
    const ownUnlisted = await post(author, {
      status: "my unlisted reply",
      in_reply_to_id: root.id,
      visibility: "unlisted",
    });
    await post(author, {
      status: "my followers-only reply",
      in_reply_to_id: root.id,
      visibility: "private",
    });
    const remote = await remoteActor("replier", "replies.example");
    const remoteReply = async (name: string) => {
      const uri = `https://replies.example/notes/${name}`;
      expect(
        await remote.send({
          id: `${uri}/activity`,
          type: "Create",
          to: [PUBLIC],
          object: {
            id: uri,
            type: "Note",
            attributedTo: remote.actorUri,
            content: `<p>${name}</p>`,
            published: "2024-05-01T00:00:00.000Z",
            to: [PUBLIC],
            cc: [],
            inReplyTo: root.uri,
          },
        }),
      ).toBe(202);
      return uri;
    };
    const earlyRemote = await remoteReply("early-remote-reply");
    const theirs = await post(other, {
      status: "another account's reply",
      in_reply_to_id: root.id,
    });
    await post(other, {
      status: "@replies-author a direct reply",
      in_reply_to_id: root.id,
      visibility: "direct",
    });
    await post(other, { status: "a reply to the reply", in_reply_to_id: own.id });
    const ownChild = await post(author, { status: "my reply to my reply", in_reply_to_id: own.id });
    const lateRemote = await remoteReply("late-remote-reply");

    const collectionUri = `${root.uri}/replies`;
    const { replies } = await noteDocument(root.uri);
    // As Mastodon's `NoteSerializer#replies`: `next` goes on from the last
    // of the author's replies it embeds.
    expect(replies).toEqual({
      id: collectionUri,
      type: "Collection",
      first: {
        type: "CollectionPage",
        next: `${collectionUri}?min_id=${ownUnlisted.id}&page=true`,
        partOf: collectionUri,
        items: [own.uri, ownUnlisted.uri],
      },
    });
    const afterOwn = await repliesPage(replies.first.next ?? "");
    expect(afterOwn).toMatchObject({
      id: `${collectionUri}?min_id=${ownUnlisted.id}&page=true`,
      items: [],
      next: `${collectionUri}?only_other_accounts=true&page=true`,
    });

    // As Mastodon's `RepliesController`, the served pages embed a local
    // reply as its note and list a remote one by its URI; the collection
    // embeds its first page, `?page=true`.
    const collection = expectContract(
      ApRepliesDocument,
      await (await SELF.fetch(collectionUri, activityJson)).json(),
    );
    expect(collection).toMatchObject({
      id: collectionUri,
      type: "Collection",
      first: {
        id: `${collectionUri}?page=true`,
        type: "CollectionPage",
        next: `${collectionUri}?only_other_accounts=true&page=true`,
        partOf: collectionUri,
      },
    });
    expect(collection.first.items).toEqual([
      await noteDocumentBody(own.uri),
      await noteDocumentBody(ownUnlisted.uri),
    ]);
    // An embedded reply carries the first page of its own replies, as the
    // note it is.
    expect(collection.first.items[0]).toMatchObject({
      replies: {
        id: `${own.uri}/replies`,
        first: {
          items: [ownChild.uri],
          next: `${own.uri}/replies?min_id=${ownChild.id}&page=true`,
        },
      },
    });

    // Every other account's replies, local or cached from another server, in
    // one id order, as Mastodon keeps them in one table.
    const others = await repliesPage(afterOwn.next ?? "");
    expect(others).toMatchObject({
      id: `${collectionUri}?only_other_accounts=true&page=true`,
      type: "CollectionPage",
      partOf: collectionUri,
    });
    expect(others).not.toHaveProperty("next");
    expect(itemIds(others.items)).toEqual([earlyRemote, theirs.uri, lateRemote]);
    expect(others.items[1]).toEqual(await noteDocumentBody(theirs.uri));

    const afterTheirs = await repliesPage(
      `${collectionUri}?min_id=${theirs.id}&only_other_accounts=true&page=true`,
    );
    expect(afterTheirs.items).toEqual([lateRemote]);

    // `page` is read as Rails casts a boolean.
    const afterFirst = await repliesPage(`${collectionUri}?min_id=${own.id}&page=yes`);
    expect(itemIds(afterFirst.items)).toEqual([ownUnlisted.uri]);

    // A page's `id` echoes what it was asked with, as `params_slice`; a blank
    // `min_id` is ignored, as `paginate_by_min_id`.
    const othersAsked = await repliesPage(`${collectionUri}?only_other_accounts=1&page=true`);
    expect(othersAsked.id).toBe(`${collectionUri}?only_other_accounts=1&page=true`);
    expect(itemIds(othersAsked.items)).toEqual([earlyRemote, theirs.uri, lateRemote]);
    const blankMinId = await repliesPage(`${collectionUri}?min_id=&page=true`);
    expect(blankMinId.id).toBe(`${collectionUri}?min_id=&page=true`);
    expect(itemIds(blankMinId.items)).toEqual([own.uri, ownUnlisted.uri]);
  });

  it("leaves out the replies of a suspended account", async () => {
    const author = "replies-moderated-author@example.com";
    const suspended = "replies-suspended@example.com";
    const root = await post(author, { status: "a root a suspended account answers" });
    const reply = await post(suspended, { status: "soon suspended", in_reply_to_id: root.id });
    const othersUri = `${root.uri}/replies?only_other_accounts=true&page=true`;
    expect(itemIds((await repliesPage(othersUri)).items)).toEqual([reply.uri]);

    const account = await SELF.fetch(`${ORIGIN}/api/v1/accounts/verify_credentials`, {
      headers: await authHeaders(suspended),
    });
    const { id } = read(z.object({ id: z.string() }), await account.json());
    const action = await SELF.fetch(`${ORIGIN}/api/v1/admin/accounts/${id}/action`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await authHeaders("replies-admin@example.com", { admin: true })),
      },
      body: JSON.stringify({ type: "suspend" }),
    });
    expect(action.status).toBe(200);

    expect((await repliesPage(othersUri)).items).toEqual([]);
  });

  it("starts empty in a new note's Create", async () => {
    const email = "replies-create@example.com";
    const note = await post(email, { status: "a new note" });
    const row = await env.DB.prepare(
      "SELECT payload_json FROM outbound_activities WHERE kind = 'Create' AND instr(payload_json, ?) > 0",
    )
      .bind(note.uri)
      .first();
    const create = expectContract(
      ApActivityDocument,
      JSON.parse(read(z.object({ payload_json: z.string() }), row).payload_json),
    );
    expect(create).toMatchObject({
      type: "Create",
      object: {
        replies: {
          id: `${note.uri}/replies`,
          first: { items: [], next: `${note.uri}/replies?only_other_accounts=true&page=true` },
        },
      },
    });
  });

  it("is carried as it is now in an edit's Update", async () => {
    const email = "replies-update@example.com";
    const note = await post(email, { status: "a note to edit" });
    const reply = await post(email, { status: "my reply", in_reply_to_id: note.id });
    const edited = await SELF.fetch(`${ORIGIN}/api/v1/statuses/${note.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await authHeaders(email)) },
      body: JSON.stringify({ status: "an edited note" }),
    });
    expect(edited.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT payload_json FROM outbound_activities WHERE kind = 'Update' AND instr(payload_json, ?) > 0",
    )
      .bind(note.uri)
      .first();
    const update = expectContract(
      ApActivityDocument,
      JSON.parse(read(z.object({ payload_json: z.string() }), row).payload_json),
    );
    // As Mastodon's `UpdateNoteSerializer`.
    expect(update).toMatchObject({
      type: "Update",
      object: {
        replies: {
          id: `${note.uri}/replies`,
          first: { items: [reply.uri], next: `${note.uri}/replies?min_id=${reply.id}&page=true` },
        },
      },
    });
  });

  it("is served for a followers-only note to the signers that may read it", async () => {
    const email = "replies-private@example.com";
    const root = await post(email, { status: "followers only", visibility: "private" });
    const publicReply = await post(email, {
      status: "a public reply to it",
      in_reply_to_id: root.id,
    });
    await post(email, {
      status: "a followers-only reply to it",
      in_reply_to_id: root.id,
      visibility: "private",
    });
    const path = `${new URL(root.uri).pathname}/replies`;

    // As Mastodon's `StatusPolicy#show?`: not for an unsigned fetch or a
    // signer who does not follow the author.
    for (const uri of [`${root.uri}/replies`, `${root.uri}/replies?page=true`]) {
      expect((await SELF.fetch(uri, activityJson)).status, uri).toBe(404);
    }
    const stranger = await remoteActor("replies-stranger", "replies-stranger.example");
    expect((await SELF.fetch(await stranger.signedGet(`${path}?page=true`))).status).toBe(404);

    // A follower reads the public and unlisted replies, as `distributable_visibility`.
    const follower = await remoteActor("replies-follower", "replies-follower.example");
    const account = await SELF.fetch(`${ORIGIN}/api/v1/accounts/verify_credentials`, {
      headers: await authHeaders(email),
    });
    const { id: accountId } = read(z.object({ id: z.string() }), await account.json());
    await env.DB.prepare(
      `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind)
       VALUES ('replies-private-follow', ?, ?, 'Fulfilled', 'Accepted')`,
    )
      .bind(follower.actorUri, accountId)
      .run();
    const page = await SELF.fetch(await follower.signedGet(`${path}?page=true`));
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("private");
    const served = expectContract(ApRepliesPageDocument, await page.json());
    expect(itemIds(served.items)).toEqual([publicReply.uri]);

    const note = await SELF.fetch(await follower.signedGet(new URL(root.uri).pathname));
    expect(note.status).toBe(200);
    expect(expectContract(ApStatusDocument, await note.json()).replies.first.items).toEqual([
      publicReply.uri,
    ]);
  });

  it("is not served for a note that does not exist", async () => {
    const email = "replies-missing@example.com";
    const root = await post(email, { status: "a public root" });
    for (const uri of [
      `${new URL(root.uri).origin}/users/replies-nobody/statuses/${root.id}/replies`,
      `${root.uri.slice(0, root.uri.lastIndexOf("/"))}/0/replies`,
    ]) {
      const response = await SELF.fetch(uri, activityJson);
      expect(response.status, uri).toBe(404);
    }
  });
});

describe("the replies collection in secure mode", () => {
  const secure = (request: Request | string) => {
    const routes = new Hono<{ Bindings: Env }>();
    routes.get("/users/:username/statuses/:id/replies", getUsersByUsernameStatusesByIdReplies);
    return routes.request(
      typeof request === "string" ? new Request(new URL(request, ORIGIN)) : request,
      undefined,
      envWith({ AUTHORIZED_FETCH: "true" }),
      createExecutionContext(),
    );
  };

  it("needs a signature, and is not found for a signer the author blocks", async () => {
    const email = "replies-secure@example.com";
    const root = await post(email, { status: "a root in secure mode" });
    const reply = await post(email, { status: "its reply", in_reply_to_id: root.id });
    const path = `${new URL(root.uri).pathname}/replies`;

    for (const unsignedPath of [path, `${path}?page=true`]) {
      const unsigned = await secure(unsignedPath);
      expect(unsigned.status, unsignedPath).toBe(401);
      expect(unsigned.headers.get("cache-control")).toBe("private");
    }

    const reader = await remoteActor("replies-reader", "replies-reader.example");
    const signed = await secure(await reader.signedGet(`${path}?page=true`));
    expect(signed.status).toBe(200);
    expect(itemIds(expectContract(ApRepliesPageDocument, await signed.json()).items)).toEqual([
      reply.uri,
    ]);

    const blocked = await remoteActor("replies-blocked", "replies-blocked.example");
    const block = await SELF.fetch(
      `${ORIGIN}/api/v1/accounts/${RemoteAccountId.encode(blocked.actorUri)}/block`,
      { method: "POST", headers: await authHeaders(email) },
    );
    expect(block.status).toBe(200);
    expect((await secure(await blocked.signedGet(`${path}?page=true`))).status).toBe(404);
  });
});

describe("the replies queries", () => {
  const plan = async (typed: { sql: string; values: unknown[] }): Promise<string[]> => {
    const { results } = await d1PrepareTyped(env.DB, {
      sql: `EXPLAIN QUERY PLAN ${typed.sql}`,
      values: typed.values,
    }).all();
    return z
      .array(z.object({ detail: z.string() }))
      .parse(results)
      .map((row) => row.detail);
  };
  const scans = (details: ReadonlyArray<string>) =>
    details.filter((detail) => /^SCAN (p|s|r|a|statuses|remote_statuses|accounts)\b/.test(detail));

  it("seeks each note's own replies by parent and id, however many notes", async () => {
    const details = await plan(listSelfNoteRepliesJson('["1","2"]', "", 5));
    expect(scans(details)).toEqual([]);
    expect(details).toContain(
      "SEARCH r USING INDEX idx_statuses_in_reply_to (in_reply_to_id=? AND id>?)",
    );
  });

  it("seeks the other accounts' replies in id order after the last one served", async () => {
    const details = await plan(listOtherNoteReplies("1", "2", "https://example.com/n/1", "3", 60));
    expect(scans(details)).toEqual([]);
    expect(details).toContain(
      "SEARCH s USING INDEX idx_statuses_in_reply_to (in_reply_to_id=? AND id>?)",
    );
    expect(details).toContain(
      "SEARCH r USING INDEX idx_remote_statuses_in_reply_to_uri_id (in_reply_to_uri=? AND id>?)",
    );
  });
});
