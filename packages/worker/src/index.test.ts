import { schemaResult } from "@tstodon/core";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { findAccountByUsername } from "./account-store";
import { requireAdmin } from "./auth";
import { generateAccountKeys } from "./keys";
import { IsoInstant, OutboxJob, RemoteActor } from "@tstodon/domain";
import {
  listAcceptedRemoteFollowerUris,
  upsertRemoteActor,
} from "./remote-actor-store";
import { findRemoteStatusByObjectUri } from "./remote-status-store";
import { attemptInboxDelivery, processOutboxJob } from "./delivery";
import {
  findOutboxFanout,
  findOutboxTarget,
  listOutboundActivities,
} from "./outbox-store";
import {
  signInboxRequest,
  verifyInboxRequest,
} from "./http-signature";
import {
  ActorPreviewSchema,
  MastodonAccountPreviewSchema,
  MastodonAppPreviewSchema,
  MastodonFilterPreviewSchema,
  MastodonMediaPreviewSchema,
  MastodonNotificationListPreviewSchema,
  MastodonRelationshipListPreviewSchema,
  MastodonRelationshipPreviewSchema,
  MastodonReportPreviewSchema,
  MastodonSearchPreviewSchema,
  MastodonStatusListPreviewSchema,
  MastodonStatusPreviewSchema,
  NotePreviewSchema,
  WebfingerPreviewSchema,
} from "./schemas";

const auth = (email: string): HeadersInit => ({
  Authorization: `Bearer dev-secret:${email}`,
});

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

describe("worker http", () => {
  it("serves healthz", async () => {
    const response = await SELF.fetch("https://example.com/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: "Ok",
      service: "tstodon",
    });
  });

  it("maps WorkOS fedi/role onto admin checks", async () => {
    const member = await json("/api/v1/accounts/verify_credentials", {
      headers: auth("role-user@example.com"),
    });
    expect(member.status).toBe(200);
    expect(read(MastodonAccountPreviewSchema, member.body).role).toMatchObject({
      id: "user",
      highlighted: false,
    });

    const admin = await json("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: "Bearer dev-secret:role-admin@example.com:admin" },
    });
    expect(admin.status).toBe(200);
    expect(read(MastodonAccountPreviewSchema, admin.body).role).toMatchObject({
      id: "admin",
      highlighted: true,
    });

    const malformed = await json("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: "Bearer dev-secret:role-user@example.com:god" },
    });
    expect(malformed.status).toBe(401);

    const forbidden = await requireAdmin(
      new Request("https://example.com/api/v1/accounts/verify_credentials", {
        headers: auth("role-user@example.com"),
      }),
      env,
    );
    expect(forbidden.isErr()).toBe(true);
    if (forbidden.isErr()) {
      expect(forbidden.error.kind).toBe("Forbidden");
    }

    const allowed = await requireAdmin(
      new Request("https://example.com/api/v1/accounts/verify_credentials", {
        headers: { Authorization: "Bearer dev-secret:role-admin@example.com:admin" },
      }),
      env,
    );
    expect(allowed.isOk()).toBe(true);
  });

  it("redirects login to WorkOS AuthKit when a client id is configured", async () => {
    const response = await SELF.fetch("https://example.com/login", { redirect: "manual" });
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("https://api.workos.com/user_management/authorize");
    expect(location).toContain("client_01M2ZN56GJ4CM8XZBYJ6VKK0CZ");
  });

  it("serves Mastodon instance metadata", async () => {
    const response = await SELF.fetch("https://example.com/api/v1/instance");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      kind: "MastodonInstance",
      uri: "example.com",
      title: "tstodon",
    });
  });

  it("registers a local app", async () => {
    const { status, body } = await json("/api/v1/apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "tstodon-test" }),
    });
    expect(status).toBe(200);
    expect(read(MastodonAppPreviewSchema, body)).toMatchObject({
      name: "tstodon-test",
      client_id: "tstodon-local",
    });
  });

  it("provisions credentials, posts, and reads timelines", async () => {
    const created = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth("alice@example.com") },
      body: JSON.stringify({ status: "hello from alice #intro" }),
    });
    expect(created.status).toBe(200);
    const status = read(MastodonStatusPreviewSchema, created.body);
    expect(status.content).toContain("hello from alice");
    expect(status.account.username).toBe("alice");

    const me = await json("/api/v1/accounts/verify_credentials", {
      headers: auth("alice@example.com"),
    });
    expect(me.status).toBe(200);
    expect(read(MastodonAccountPreviewSchema, me.body)).toMatchObject({
      username: "alice",
      acct: "alice",
    });

    const publicTl = await json("/api/v1/timelines/public");
    expect(publicTl.status).toBe(200);
    expect(read(MastodonStatusListPreviewSchema, publicTl.body)).not.toHaveLength(0);

    const home = await json("/api/v1/timelines/home", {
      headers: auth("alice@example.com"),
    });
    expect(home.status).toBe(200);
    expect(read(MastodonStatusListPreviewSchema, home.body)).not.toHaveLength(0);

    const webfinger = await json(
      "/.well-known/webfinger?resource=acct:alice@example.com",
    );
    expect(webfinger.status).toBe(200);
    expect(read(WebfingerPreviewSchema, webfinger.body)).toMatchObject({
      subject: "acct:alice@example.com",
    });

    const actor = await json("/users/alice");
    expect(actor.status).toBe(200);
    expect(read(ActorPreviewSchema, actor.body)).toMatchObject({
      type: "Person",
      preferredUsername: "alice",
    });

    const note = await json(`/users/alice/statuses/${status.id}`);
    expect(note.status).toBe(200);
    expect(read(NotePreviewSchema, note.body)).toMatchObject({ type: "Note" });
  });

  it("follows, favourites, notifies, and searches across local accounts", async () => {
    await json("/api/v1/accounts/verify_credentials", {
      headers: auth("alice@example.com"),
    });
    const bobStatus = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth("bob@example.com") },
      body: JSON.stringify({ status: "bob says hi @alice" }),
    });
    expect(bobStatus.status).toBe(200);
    const posted = read(MastodonStatusPreviewSchema, bobStatus.body);

    const alice = await json("/api/v1/accounts/verify_credentials", {
      headers: auth("alice@example.com"),
    });
    expect(read(MastodonAccountPreviewSchema, alice.body).username).toBe("alice");

    const follow = await json(`/api/v1/accounts/${posted.account.id}/follow`, {
      method: "POST",
      headers: auth("alice@example.com"),
    });
    expect(follow.status).toBe(200);
    expect(read(MastodonRelationshipPreviewSchema, follow.body)).toMatchObject({
      following: true,
    });

    const home = await json("/api/v1/timelines/home", {
      headers: auth("alice@example.com"),
    });
    expect(
      read(MastodonStatusListPreviewSchema, home.body).some((item) => item.id === posted.id),
    ).toBe(true);

    const fav = await json(`/api/v1/statuses/${posted.id}/favourite`, {
      method: "POST",
      headers: auth("alice@example.com"),
    });
    expect(fav.status).toBe(200);
    expect(read(MastodonStatusPreviewSchema, fav.body)).toMatchObject({ favourited: true });

    const bobNotes = await json("/api/v1/notifications", {
      headers: auth("bob@example.com"),
    });
    expect(bobNotes.status).toBe(200);
    const bobTypes = read(MastodonNotificationListPreviewSchema, bobNotes.body).map(
      (item) => item.type,
    );
    expect(bobTypes).toEqual(expect.arrayContaining(["follow", "favourite"]));

    const aliceNotes = await json("/api/v1/notifications", {
      headers: auth("alice@example.com"),
    });
    expect(aliceNotes.status).toBe(200);
    const aliceTypes = read(MastodonNotificationListPreviewSchema, aliceNotes.body).map(
      (item) => item.type,
    );
    expect(aliceTypes).toEqual(expect.arrayContaining(["mention"]));

    const search = await json(`/api/v2/search?q=bob&type=accounts`, {
      headers: auth("alice@example.com"),
    });
    expect(search.status).toBe(200);
    expect(read(MastodonSearchPreviewSchema, search.body).accounts[0]?.username).toBe("bob");

    const relationships = await json(
      `/api/v1/accounts/relationships?id[]=${posted.account.id}`,
      { headers: auth("alice@example.com") },
    );
    expect(read(MastodonRelationshipListPreviewSchema, relationships.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: posted.account.id, following: true }),
      ]),
    );
  });

  it("uploads media, creates polls, filters, and reports", async () => {
    const form = new FormData();
    form.set("file", new File(["hello"], "hello.txt", { type: "text/plain" }));
    const mediaResponse = await SELF.fetch("https://example.com/api/v1/media", {
      method: "POST",
      headers: auth("alice@example.com"),
      body: form,
    });
    expect(mediaResponse.status).toBe(200);
    const media = read(MastodonMediaPreviewSchema, await mediaResponse.json());
    expect(media.id).toBeTruthy();

    const poll = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth("alice@example.com") },
      body: JSON.stringify({
        status: "lunch?",
        poll: { options: ["ramen", "curry"], expires_in: 3600, multiple: false },
      }),
    });
    expect(poll.status).toBe(200);
    const pollStatus = read(MastodonStatusPreviewSchema, poll.body);
    expect(pollStatus.poll?.id).toBeTruthy();

    const vote = await json(`/api/v1/polls/${pollStatus.poll?.id}/votes`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth("bob@example.com") },
      body: JSON.stringify({ choices: [0] }),
    });
    expect(vote.status).toBe(200);

    const filter = await json("/api/v1/filters", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth("alice@example.com") },
      body: JSON.stringify({ phrase: "spam", context: ["home"] }),
    });
    expect(filter.status).toBe(200);
    expect(read(MastodonFilterPreviewSchema, filter.body)).toMatchObject({ phrase: "spam" });

    const bob = await json("/api/v1/accounts/verify_credentials", {
      headers: auth("bob@example.com"),
    });
    const report = await json("/api/v1/reports", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth("alice@example.com") },
      body: JSON.stringify({
        account_id: read(MastodonAccountPreviewSchema, bob.body).id,
        comment: "test",
      }),
    });
    expect(report.status).toBe(200);
    expect(read(MastodonReportPreviewSchema, report.body)).toMatchObject({
      action_taken: false,
    });
  });

  it("rejects an unsigned inbox Follow", async () => {
    await json("/api/v1/accounts/verify_credentials", {
      headers: auth("alice@example.com"),
    });
    const inbox = await json("/inbox", {
      method: "POST",
      headers: { "content-type": "application/activity+json" },
      body: JSON.stringify({
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://example.com/activities/unsigned-follow",
        type: "Follow",
        actor: "https://example.com/users/carol",
        object: "https://example.com/users/alice",
      }),
    });
    expect(inbox.status).toBe(401);
    expect(inbox.body).toMatchObject({ kind: "InvalidSignature" });
  });

  it("accepts a local ActivityPub Follow into the inbox", async () => {
    const alice = await json("/api/v1/accounts/verify_credentials", {
      headers: auth("alice@example.com"),
    });
    const carol = await json("/api/v1/accounts/verify_credentials", {
      headers: auth("carol@example.com"),
    });
    expect(alice.status).toBe(200);
    expect(carol.status).toBe(200);
    const actor = await findAccountByUsername(env.DB, "carol");
    expect(actor.isOk() && actor.value).toBeTruthy();
    if (actor.isErr() || !actor.value) {
      throw new Error("carol account missing");
    }
    const body = JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://example.com/activities/follow-carol-alice",
      type: "Follow",
      actor: "https://example.com/users/carol",
      object: "https://example.com/users/alice",
    });
    const url = new URL("https://example.com/inbox");
    const headers = await signInboxRequest(
      url,
      actor.value.privateKeyJwk.unwrap(),
      "https://example.com/users/carol#main-key",
      body,
    );
    expect(headers.isOk()).toBe(true);
    if (headers.isErr()) {
      throw new Error(headers.error.message);
    }
    const inbox = await json("/inbox", {
      method: "POST",
      headers: headers.value,
      body,
    });
    expect(inbox.status).toBe(202);
    const relationships = await json(
      `/api/v1/accounts/relationships?id=${read(MastodonAccountPreviewSchema, alice.body).id}`,
      { headers: auth("carol@example.com") },
    );
    expect(read(MastodonRelationshipListPreviewSchema, relationships.body)).toEqual(
      expect.arrayContaining([expect.objectContaining({ following: true })]),
    );
  });

  it("accepts a remote Follow signed with a cached actor key", async () => {
    const alice = await json("/api/v1/accounts/verify_credentials", {
      headers: auth("alice@example.com"),
    });
    expect(alice.status).toBe(200);
    const local = await findAccountByUsername(env.DB, "alice");
    expect(local.isOk() && local.value).toBeTruthy();
    if (local.isErr() || !local.value) {
      throw new Error("alice account missing");
    }
    const keys = await generateAccountKeys();
    const fetchedAt = IsoInstant.parse("2026-09-20T15:00:00.000Z");
    expect(fetchedAt.isOk()).toBe(true);
    if (fetchedAt.isErr()) {
      throw new Error("invalid fixture instant");
    }
    const remote = RemoteActor.fromFetched({
      actorUri: "https://remote.example/users/bob",
      username: "bob",
      domain: "remote.example",
      inboxUri: "https://remote.example/users/bob/inbox",
      publicKeyId: "https://remote.example/users/bob#main-key",
      publicKeyPem: keys.publicKeyPem,
      displayName: "Bob",
      fetchedAt: fetchedAt.value,
    });
    expect(remote.isOk()).toBe(true);
    if (remote.isErr()) {
      throw new Error("remote actor fixture rejected");
    }
    const stored = await upsertRemoteActor(env.DB, remote.value);
    expect(stored.isOk()).toBe(true);
    const body = JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/follow-bob-alice",
      type: "Follow",
      actor: "https://remote.example/users/bob",
      object: "https://example.com/users/alice",
    });
    const url = new URL("https://example.com/inbox");
    const headers = await signInboxRequest(
      url,
      keys.privateKeyJwk,
      "https://remote.example/users/bob#main-key",
      body,
    );
    expect(headers.isOk()).toBe(true);
    if (headers.isErr()) {
      throw new Error(headers.error.message);
    }
    const inbox = await json("/inbox", {
      method: "POST",
      headers: headers.value,
      body,
    });
    expect(inbox.status).toBe(202);
    const followers = await listAcceptedRemoteFollowerUris(env.DB, local.value.id, 20);
    expect(followers.isOk()).toBe(true);
    if (followers.isOk()) {
      expect(followers.value).toContain("https://remote.example/users/bob");
    }
  });

  it("persists a remote Create Note onto the public timeline", async () => {
    await json("/api/v1/accounts/verify_credentials", {
      headers: auth("alice@example.com"),
    });
    const keys = await generateAccountKeys();
    const fetchedAt = IsoInstant.parse("2026-09-20T15:00:00.000Z");
    expect(fetchedAt.isOk()).toBe(true);
    if (fetchedAt.isErr()) {
      throw new Error("invalid fixture instant");
    }
    const remote = RemoteActor.fromFetched({
      actorUri: "https://remote.example/users/dana",
      username: "dana",
      domain: "remote.example",
      inboxUri: "https://remote.example/users/dana/inbox",
      publicKeyId: "https://remote.example/users/dana#main-key",
      publicKeyPem: keys.publicKeyPem,
      displayName: "Dana",
      fetchedAt: fetchedAt.value,
    });
    expect(remote.isOk()).toBe(true);
    if (remote.isErr()) {
      throw new Error("remote actor fixture rejected");
    }
    const stored = await upsertRemoteActor(env.DB, remote.value);
    expect(stored.isOk()).toBe(true);
    const objectUri = "https://remote.example/users/dana/statuses/1";
    const body = JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/create-dana-1",
      type: "Create",
      actor: "https://remote.example/users/dana",
      object: {
        id: objectUri,
        type: "Note",
        attributedTo: "https://remote.example/users/dana",
        content: "<p>hello from dana</p>",
        published: "2026-09-20T15:01:00.000Z",
        to: ["https://www.w3.org/ns/activitystreams#Public"],
      },
    });
    const url = new URL("https://example.com/inbox");
    const headers = await signInboxRequest(
      url,
      keys.privateKeyJwk,
      "https://remote.example/users/dana#main-key",
      body,
    );
    expect(headers.isOk()).toBe(true);
    if (headers.isErr()) {
      throw new Error(headers.error.message);
    }
    const inbox = await json("/inbox", {
      method: "POST",
      headers: headers.value,
      body,
    });
    expect(inbox.status).toBe(202);
    const persisted = await findRemoteStatusByObjectUri(env.DB, objectUri);
    expect(persisted.isOk() && persisted.value).toBeTruthy();
    if (persisted.isErr() || !persisted.value) {
      throw new Error("remote status missing");
    }
    const publicTl = await json("/api/v1/timelines/public");
    expect(publicTl.status).toBe(200);
    expect(read(MastodonStatusListPreviewSchema, publicTl.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: "<p>hello from dana</p>",
          account: expect.objectContaining({ acct: "dana@remote.example" }),
        }),
      ]),
    );
    const fetched = await json(`/api/v1/statuses/${persisted.value.id}`);
    expect(fetched.status).toBe(200);
    expect(read(MastodonStatusPreviewSchema, fetched.body)).toMatchObject({
      content: "<p>hello from dana</p>",
    });
  });

  it("counts remote Like and Announce against a local status", async () => {
    const created = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth("alice@example.com") },
      body: JSON.stringify({ status: "please boost me" }),
    });
    expect(created.status).toBe(200);
    const status = read(MastodonStatusPreviewSchema, created.body);
    const keys = await generateAccountKeys();
    const fetchedAt = IsoInstant.parse("2026-09-20T15:00:00.000Z");
    expect(fetchedAt.isOk()).toBe(true);
    if (fetchedAt.isErr()) {
      throw new Error("invalid fixture instant");
    }
    const remote = RemoteActor.fromFetched({
      actorUri: "https://remote.example/users/erin",
      username: "erin",
      domain: "remote.example",
      inboxUri: "https://remote.example/users/erin/inbox",
      publicKeyId: "https://remote.example/users/erin#main-key",
      publicKeyPem: keys.publicKeyPem,
      displayName: "Erin",
      fetchedAt: fetchedAt.value,
    });
    expect(remote.isOk()).toBe(true);
    if (remote.isErr()) {
      throw new Error("remote actor fixture rejected");
    }
    expect((await upsertRemoteActor(env.DB, remote.value)).isOk()).toBe(true);
    const object = `https://example.com/users/alice/statuses/${status.id}`;
    const likeBody = JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/like-erin-alice",
      type: "Like",
      actor: "https://remote.example/users/erin",
      object,
    });
    const announceBody = JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/announce-erin-alice",
      type: "Announce",
      actor: "https://remote.example/users/erin",
      object,
    });
    const inboxUrl = new URL("https://example.com/inbox");
    const likeHeaders = await signInboxRequest(
      inboxUrl,
      keys.privateKeyJwk,
      "https://remote.example/users/erin#main-key",
      likeBody,
    );
    const announceHeaders = await signInboxRequest(
      inboxUrl,
      keys.privateKeyJwk,
      "https://remote.example/users/erin#main-key",
      announceBody,
    );
    expect(likeHeaders.isOk() && announceHeaders.isOk()).toBe(true);
    if (likeHeaders.isErr() || announceHeaders.isErr()) {
      throw new Error("failed to sign remote interactions");
    }
    expect(
      (
        await json("/inbox", {
          method: "POST",
          headers: likeHeaders.value,
          body: likeBody,
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await json("/inbox", {
          method: "POST",
          headers: announceHeaders.value,
          body: announceBody,
        })
      ).status,
    ).toBe(202);
    const counted = await json(`/api/v1/statuses/${status.id}`);
    expect(counted.status).toBe(200);
    expect(read(MastodonStatusPreviewSchema, counted.body)).toMatchObject({
      favourites_count: 1,
      reblogs_count: 1,
    });
    const undoBody = JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/undo-like-erin-alice",
      type: "Undo",
      actor: "https://remote.example/users/erin",
      object: {
        id: "https://remote.example/activities/like-erin-alice",
        type: "Like",
        object,
      },
    });
    const undoHeaders = await signInboxRequest(
      inboxUrl,
      keys.privateKeyJwk,
      "https://remote.example/users/erin#main-key",
      undoBody,
    );
    expect(undoHeaders.isOk()).toBe(true);
    if (undoHeaders.isErr()) {
      throw new Error("failed to sign undo");
    }
    expect(
      (
        await json("/inbox", {
          method: "POST",
          headers: undoHeaders.value,
          body: undoBody,
        })
      ).status,
    ).toBe(202);
    const afterUndo = await json(`/api/v1/statuses/${status.id}`);
    expect(read(MastodonStatusPreviewSchema, afterUndo.body)).toMatchObject({
      favourites_count: 0,
      reblogs_count: 1,
    });
  });

  it("fans out remote follower inboxes as per-target outbox rows", async () => {
    const alice = await json("/api/v1/accounts/verify_credentials", {
      headers: auth("queue-alice@example.com"),
    });
    expect(alice.status).toBe(200);
    const preview = read(MastodonAccountPreviewSchema, alice.body);
    const local = await findAccountByUsername(env.DB, preview.username);
    expect(local.isOk() && local.value).toBeTruthy();
    if (local.isErr() || !local.value) {
      throw new Error("queue_alice account missing");
    }
    const keys = await generateAccountKeys();
    const fetchedAt = IsoInstant.parse("2026-09-20T15:00:00.000Z");
    expect(fetchedAt.isOk()).toBe(true);
    if (fetchedAt.isErr()) {
      throw new Error("invalid fixture instant");
    }
    const remote = RemoteActor.fromFetched({
      actorUri: "https://remote.example/users/queue-bob",
      username: "queue-bob",
      domain: "remote.example",
      inboxUri: "https://remote.example/users/queue-bob/inbox",
      publicKeyId: "https://remote.example/users/queue-bob#main-key",
      publicKeyPem: keys.publicKeyPem,
      displayName: "Queue Bob",
      fetchedAt: fetchedAt.value,
    });
    expect(remote.isOk()).toBe(true);
    if (remote.isErr()) {
      throw new Error("remote actor fixture rejected");
    }
    expect((await upsertRemoteActor(env.DB, remote.value)).isOk()).toBe(true);
    const followBody = JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/follow-queue-bob",
      type: "Follow",
      actor: "https://remote.example/users/queue-bob",
      object: `https://example.com/users/${preview.username}`,
    });
    const followUrl = new URL("https://example.com/inbox");
    const followHeaders = await signInboxRequest(
      followUrl,
      keys.privateKeyJwk,
      "https://remote.example/users/queue-bob#main-key",
      followBody,
    );
    expect(followHeaders.isOk()).toBe(true);
    if (followHeaders.isErr()) {
      throw new Error(followHeaders.error.message);
    }
    expect(
      (
        await json("/inbox", {
          method: "POST",
          headers: followHeaders.value,
          body: followBody,
        })
      ).status,
    ).toBe(202);
    const created = await json("/api/v1/statuses", {
      method: "POST",
      headers: {
        ...auth("queue-alice@example.com"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "hello remote followers" }),
    });
    expect(created.status).toBe(200);
    const activities = await listOutboundActivities(env.DB, local.value.id, 20);
    expect(activities.isOk() && activities.value[0]).toBeTruthy();
    if (activities.isErr() || !activities.value[0]) {
      throw new Error("outbound activity missing");
    }
    const job = OutboxJob.parse({
      kind: "ExpandFollowers",
      activityId: activities.value[0].id,
    });
    expect(job.isOk()).toBe(true);
    if (job.isErr()) {
      throw new Error("expand job rejected");
    }
    await processOutboxJob(env, job.value);
    const target = await findOutboxTarget(
      env.DB,
      activities.value[0].id,
      "https://remote.example/users/queue-bob/inbox",
    );
    expect(target.isOk() && target.value).toBeTruthy();
    if (target.isErr() || !target.value) {
      throw new Error("outbox target missing");
    }
    expect(target.value.kind).not.toBe("Expanded");
    expect(["Queued", "Delivered", "Failed"]).toContain(target.value.kind);
    const fanout = await findOutboxFanout(env.DB, activities.value[0].id);
    expect(fanout.isOk() && fanout.value).toBeTruthy();
    if (fanout.isOk() && fanout.value) {
      expect(fanout.value.kind).toBe("Expanded");
    }
  });

  it("maps a missing activity onto a permanent delivery failure", async () => {
    const job = OutboxJob.parse({
      kind: "DeliverTarget",
      activityId: "missing-activity",
      inboxUrl: "https://remote.example/users/nobody/inbox",
    });
    expect(job.isOk()).toBe(true);
    if (job.isErr() || job.value.kind !== "DeliverTarget") {
      throw new Error("deliver job rejected");
    }
    const outcome = await attemptInboxDelivery(env, job.value);
    expect(outcome).toEqual({
      kind: "PermanentFailure",
      httpStatus: 404,
    } as const satisfies typeof outcome);
  });
});

describe("http signatures", () => {
  it("signs and verifies a draft-cavage inbox request", async () => {
    const keys = await generateAccountKeys();
    const body = JSON.stringify({ type: "Follow", actor: "https://example.com/users/alice" });
    const url = new URL("https://remote.example/inbox");
    const headers = await signInboxRequest(
      url,
      keys.privateKeyJwk,
      "https://example.com/users/alice#main-key",
      body,
    );
    expect(headers.isOk()).toBe(true);
    if (headers.isErr()) {
      throw new Error(headers.error.message);
    }
    const request = new Request(url, { method: "POST", headers: headers.value, body });
    await expect(verifyInboxRequest(request, keys.publicKeyPem, body)).resolves.toBe(true);
  });
});
