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
import { RemoteAccountId } from "./remote-account-id";
import { getUsersByUsernameStatusesByIdReplies } from "./routes/activitypub";

/**
 * INT-4, the `replies` collection of a local note in Mastodon's shape: the
 * note embeds a first page with its author's own replies, and `next` leads
 * to the replies of other local accounts, then to the ones cached from other
 * servers. Only public and unlisted replies are listed.
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
  it("lists the author's replies first, then other local accounts', then remote ones", async () => {
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
    const remote = await remoteActor("replier", "replies.example");
    const remoteReply = `https://replies.example/notes/remote-reply`;
    expect(
      await remote.send({
        id: `${remoteReply}/activity`,
        type: "Create",
        to: [PUBLIC],
        object: {
          id: remoteReply,
          type: "Note",
          attributedTo: remote.actorUri,
          content: "<p>a remote reply</p>",
          published: "2024-05-01T00:00:00.000Z",
          to: [PUBLIC],
          cc: [],
          inReplyTo: root.uri,
        },
      }),
    ).toBe(202);

    const collectionUri = `${root.uri}/replies`;
    const { replies } = await noteDocument(root.uri);
    expect(replies).toEqual({
      id: collectionUri,
      type: "Collection",
      first: {
        type: "CollectionPage",
        next: `${collectionUri}?only_other_accounts=true&page=true`,
        partOf: collectionUri,
        items: [own.uri, ownUnlisted.uri],
      },
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

    const others = await repliesPage(replies.first.next ?? "");
    expect(others).toMatchObject({
      id: `${collectionUri}?only_other_accounts=true&page=true`,
      type: "CollectionPage",
      partOf: collectionUri,
      next: `${collectionUri}?only_other_accounts=true&remote=true&page=true`,
    });
    expect(itemIds(others.items)).toEqual([theirs.uri]);
    expect(others.items[0]).toMatchObject({ type: "Note", attributedTo: expect.any(String) });

    const remotes = await repliesPage(others.next ?? "");
    expect(remotes.items).toEqual([remoteReply]);
    expect(remotes).not.toHaveProperty("next");

    const afterFirst = await repliesPage(`${collectionUri}?min_id=${own.id}&page=true`);
    expect(itemIds(afterFirst.items)).toEqual([ownUnlisted.uri]);
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
