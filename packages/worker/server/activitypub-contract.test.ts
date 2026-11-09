import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiInstance, ApiStatus } from "@tstodon/api";
import {
  ApActivityDocument,
  ApActorCollection,
  ApActorDocument,
  ApInstanceActorDocument,
  ApOutbox,
  ApQuoteAuthorizationDocument,
  ApStatusDocument,
  NodeInfo20,
  NodeInfoDiscovery,
  PUBLIC_COLLECTION,
  WebFingerJrd,
} from "@tstodon/api/activitypub";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { PNG_40X30 } from "../test/image-fixtures";
import { remoteActor } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

/**
 * The ActivityPub documents tstodon serves and sends, checked against their
 * `@tstodon/api/activitypub` schemas: the documents fetched at their URIs,
 * the discovery documents, and every activity a run of actions queues for
 * delivery. Behaviour is asserted by each feature's own tests.
 */

const ORIGIN = "https://example.com";
const activityJson = { headers: { accept: "application/activity+json" } };

const fetchJson = async (path: string, init?: RequestInit) => {
  const response = await SELF.fetch(new URL(path, ORIGIN), init);
  expect(response.status, path).toBe(200);
  return response.json();
};

const api = async (
  email: string,
  method: string,
  path: string,
  body?: Record<string, unknown> | FormData,
) => {
  const headers = await authHeaders(email);
  const response = await SELF.fetch(new URL(path, ORIGIN), {
    method,
    headers:
      body === undefined || body instanceof FormData
        ? headers
        : { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  expect(response.status, `${method} ${path}`).toBe(200);
  return response.json();
};

const PayloadRows = z.array(z.object({ kind: z.string(), payload_json: z.string() }));

/** Every activity queued for delivery so far, oldest first. */
const queuedActivities = async () => {
  const { results } = await env.DB.prepare(
    "SELECT kind, payload_json FROM outbound_activities ORDER BY rowid",
  ).all();
  return expectContract(PayloadRows, results).map((row) => ({
    kind: row.kind,
    payload: JSON.parse(row.payload_json),
  }));
};

describe("ActivityPub documents (@tstodon/api/activitypub)", () => {
  it("serves actors, statuses, collections and discovery documents", async () => {
    const email = "ap-contract-author@example.com";
    const account = await signedInAccount(email);
    const actorUri = `${ORIGIN}/users/${account.username}`;
    const form = new FormData();
    form.set("note", "Writes *contracts*");
    form.set("fields_attributes[0][name]", "Site");
    form.set("fields_attributes[0][value]", "https://example.org");
    form.set("avatar", new File([PNG_40X30], "avatar.png", { type: "image/png" }));
    await api(email, "PATCH", "/api/v1/accounts/update_credentials", form);

    const actor = expectContract(ApActorDocument, await fetchJson(`/users/${account.username}`));
    expect(actor).toMatchObject({
      id: actorUri,
      type: "Person",
      icon: { type: "Image", mediaType: "image/png" },
      attachment: [{ type: "PropertyValue", name: "Site" }],
    });
    expectContract(ApInstanceActorDocument, await fetchJson("/actor"));

    const media = expectContract(
      z.object({ id: z.string() }),
      await api(
        email,
        "POST",
        "/api/v2/media",
        (() => {
          const upload = new FormData();
          upload.set("file", new File([PNG_40X30], "a.png", { type: "image/png" }));
          upload.set("description", "a gradient");
          return upload;
        })(),
      ),
    );
    const note = expectContract(
      ApiStatus,
      await api(email, "POST", "/api/v1/statuses", {
        status: "A note with a picture",
        media_ids: [media.id],
      }),
    );
    const poll = expectContract(
      ApiStatus,
      await api(email, "POST", "/api/v1/statuses", {
        status: "Pick one",
        poll: { options: ["yes", "no"], expires_in: 3600 },
      }),
    );
    const reply = expectContract(
      ApiStatus,
      await api(email, "POST", "/api/v1/statuses", {
        status: "A reply",
        in_reply_to_id: note.id,
        visibility: "unlisted",
      }),
    );

    const noteDocument = expectContract(
      ApStatusDocument,
      await fetchJson(`/users/${account.username}/statuses/${note.id}`, activityJson),
    );
    expect(noteDocument).toMatchObject({
      type: "Note",
      to: [PUBLIC_COLLECTION],
      attachment: [{ type: "Document", name: "a gradient" }],
    });
    expect(noteDocument).not.toHaveProperty("updated");
    expect(
      expectContract(
        ApStatusDocument,
        await fetchJson(`/users/${account.username}/statuses/${poll.id}`, activityJson),
      ),
    ).toMatchObject({ type: "Question", oneOf: [{ name: "yes" }, { name: "no" }] });
    expect(
      expectContract(
        ApStatusDocument,
        await fetchJson(`/users/${account.username}/statuses/${reply.id}`, activityJson),
      ).inReplyTo,
    ).toBe(noteDocument.id);

    const outbox = expectContract(ApOutbox, await fetchJson(`/users/${account.username}/outbox`));
    expect(outbox.orderedItems.map((item) => item.type)).toContain("Create");
    expectContract(ApActorCollection, await fetchJson(`/users/${account.username}/followers`));
    expectContract(ApActorCollection, await fetchJson(`/users/${account.username}/following`));

    const webfinger = expectContract(
      WebFingerJrd,
      await fetchJson(`/.well-known/webfinger?resource=acct:${account.username}@example.com`),
    );
    expect(webfinger.links).toContainEqual({
      rel: "self",
      type: "application/activity+json",
      href: actorUri,
    });
    expectContract(
      WebFingerJrd,
      await fetchJson("/.well-known/webfinger?resource=acct:example.com@example.com"),
    );
    const discovery = expectContract(NodeInfoDiscovery, await fetchJson("/.well-known/nodeinfo"));
    const nodeinfo = expectContract(
      NodeInfo20,
      await fetchJson(new URL(discovery.links[0]?.href ?? "").pathname),
    );
    // NodeInfo agrees with the REST instance on whether anyone may sign up.
    const instance = expectContract(ApiInstance, await fetchJson("/api/v2/instance"));
    expect(nodeinfo.openRegistrations).toBe(instance.registrations.enabled);
  });

  it("serves the stamp of an accepted quote", async () => {
    const authorEmail = "ap-contract-quoted@example.com";
    const author = await signedInAccount(authorEmail);
    const quoted = expectContract(
      ApiStatus,
      await api(authorEmail, "POST", "/api/v1/statuses", { status: "Quote me" }),
    );
    const quoting = expectContract(
      ApiStatus,
      await api("ap-contract-quoter@example.com", "POST", "/api/v1/statuses", {
        status: "Quoting",
        quoted_status_id: quoted.id,
      }),
    );
    expect(quoting.quote?.state).toBe("accepted");
    const row = expectContract(
      z.object({ id: z.string() }),
      await env.DB.prepare("SELECT id FROM status_quotes WHERE status_id = ?")
        .bind(quoting.id)
        .first(),
    );
    const stamp = expectContract(
      ApQuoteAuthorizationDocument,
      await fetchJson(`/users/${author.username}/quote_authorizations/${row.id}`, activityJson),
    );
    expect(stamp.interactionTarget).toBe(
      `${ORIGIN}/users/${author.username}/statuses/${quoted.id}`,
    );
  });

  it("delivers the activities as tstodon's schemas describe them", async () => {
    const email = "ap-contract-sender@example.com";
    const account = await signedInAccount(email);
    const actorUri = `${ORIGIN}/users/${account.username}`;
    const remote = await remoteActor("ap-contract-remote", "ap-contract.example");
    const remoteId = RemoteAccountId.encode(remote.actorUri);

    // A remote follower (answered with an `Accept`), and a follow of it.
    expect(
      await remote.send({
        id: `${remote.actorUri}#follows/1`,
        type: "Follow",
        object: actorUri,
      }),
    ).toBe(202);
    await api(email, "POST", `/api/v1/accounts/${remoteId}/follow`);

    // A remote note, liked, unliked and quoted (a `QuoteRequest`).
    const remoteNoteUri = "https://ap-contract.example/notes/1";
    expect(
      await remote.send({
        id: `${remoteNoteUri}/activity`,
        type: "Create",
        object: {
          id: remoteNoteUri,
          type: "Note",
          attributedTo: remote.actorUri,
          content: "<p>remote</p>",
          published: "2026-11-01T00:00:00.000Z",
          to: [PUBLIC_COLLECTION],
          cc: [actorUri],
          interactionPolicy: { canQuote: { automaticApproval: [PUBLIC_COLLECTION] } },
        },
      }),
    ).toBe(202);
    const remoteNote = expectContract(
      z.object({ id: z.string() }),
      await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
        .bind(remoteNoteUri)
        .first(),
    );
    await api(email, "POST", `/api/v1/statuses/${remoteNote.id}/favourite`);
    await api(email, "POST", `/api/v1/statuses/${remoteNote.id}/unfavourite`);
    await api(email, "POST", "/api/v1/statuses", {
      status: "Quoting the remote note",
      quoted_status_id: remoteNote.id,
    });

    // A status: created, edited, boosted, unboosted, deleted; a poll.
    const status = expectContract(
      ApiStatus,
      await api(email, "POST", "/api/v1/statuses", { status: "First version" }),
    );
    await api(email, "PUT", `/api/v1/statuses/${status.id}`, { status: "Second version" });
    await api(email, "POST", `/api/v1/statuses/${status.id}/reblog`);
    await api(email, "POST", `/api/v1/statuses/${status.id}/unreblog`);
    await api(email, "POST", "/api/v1/statuses", {
      status: "Pick one",
      poll: { options: ["yes", "no"], expires_in: 3600, multiple: true },
    });
    await api(email, "DELETE", `/api/v1/statuses/${status.id}`);

    // The profile changes (an actor `Update`), a forwarded report (a `Flag`),
    // a block and its undoing.
    await api(email, "PATCH", "/api/v1/accounts/update_credentials", { display_name: "Sender" });
    await api(email, "POST", "/api/v1/reports", {
      account_id: remoteId,
      comment: "contract",
      forward: true,
    });
    await api(email, "POST", `/api/v1/accounts/${remoteId}/block`);
    await api(email, "POST", `/api/v1/accounts/${remoteId}/unblock`);

    const queued = await queuedActivities();
    for (const { kind, payload } of queued) {
      expect(expectContract(ApActivityDocument, payload).type).toBe(kind);
    }
    expect(new Set(queued.map(({ kind }) => kind))).toEqual(
      new Set([
        "Accept",
        "Follow",
        "Like",
        "Undo",
        "QuoteRequest",
        "Create",
        "Update",
        "Announce",
        "Delete",
        "Flag",
        "Block",
        "Reject",
      ]),
    );

    // An edit says when it was made: Mastodon applies an `Update` of a note
    // only when its `updated` is newer than the version it has.
    const edit = queued
      .map(({ payload }) => expectContract(ApActivityDocument, payload))
      .find((activity) => activity.type === "Update" && activity.object.type === "Note");
    expect(edit?.type === "Update" && edit.object.type === "Note" && edit.object.updated).toEqual(
      expect.any(String),
    );
  });
});
