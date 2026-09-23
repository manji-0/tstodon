import { schemaResult } from "@tstodon/core";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { findAccountByUsername } from "./account-store";
import { requireAdmin } from "./auth";
import { generateAccountKeys } from "./keys";
import { IsoInstant, OutboxJob, RemoteActor, StreamEvent } from "@tstodon/domain";
import { listAcceptedRemoteFollowerUris, upsertRemoteActor } from "./remote-actor-store";
import { findRemoteStatusByObjectUri } from "./remote-status-store";
import { attemptInboxDelivery, processOutboxJob } from "./delivery";
import { findOutboxFanout, findOutboxTarget, listOutboundActivities } from "./outbox-store";
import { listExpiredUnnotifiedPolls } from "./poll-store";
import { publishToAccount } from "./stream-publish";
import { signInboxRequest, verifyInboxRequest } from "./http-signature";
import {
  accessAuthHeaders,
  signAccessJwt,
  LOCAL_ACCESS_TEAM_DOMAIN,
} from "../test/access-jwt-fixture";
import {
  ActorPreviewSchema,
  MastodonAccountPreviewSchema,
  MastodonAppPreviewSchema,
  MastodonContextPreviewSchema,
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

const auth = (
  email: string,
  options?: Readonly<{ admin?: boolean; via?: "bearer" | "assertion" }>,
): Promise<Record<string, string>> => accessAuthHeaders(email, options);

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

  it("maps Access groups onto admin checks", async () => {
    const member = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth("role-user@example.com"),
    });
    expect(member.status).toBe(200);
    expect(read(MastodonAccountPreviewSchema, member.body).role).toMatchObject({
      id: "user",
      highlighted: false,
    });

    const admin = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth("role-admin@example.com", { admin: true }),
    });
    expect(admin.status).toBe(200);
    expect(read(MastodonAccountPreviewSchema, admin.body).role).toMatchObject({
      id: "admin",
      highlighted: true,
    });

    const assertion = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth("assertion-user@example.com", { via: "assertion" }),
    });
    expect(assertion.status).toBe(200);

    const wrongAud = await signAccessJwt({
      email: "role-user@example.com",
      audience: "wrong-aud",
      issuer: LOCAL_ACCESS_TEAM_DOMAIN,
    });
    const malformed = await json("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${wrongAud}` },
    });
    expect(malformed.status).toBe(401);

    const forbidden = await requireAdmin(
      new Request("https://example.com/api/v1/accounts/verify_credentials", {
        headers: await auth("role-user@example.com"),
      }),
      env,
    );
    expect(forbidden.isErr()).toBe(true);
    if (forbidden.isErr()) {
      expect(forbidden.error.kind).toBe("Forbidden");
    }

    const allowed = await requireAdmin(
      new Request("https://example.com/api/v1/accounts/verify_credentials", {
        headers: await auth("role-admin@example.com", { admin: true }),
      }),
      env,
    );
    expect(allowed.isOk()).toBe(true);
  });

  it("explains that Cloudflare Access handles login", async () => {
    const response = await SELF.fetch("https://example.com/login");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Cloudflare Access");
    expect(body).toContain("WorkOS");
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
      headers: { "content-type": "application/json", ...(await auth("alice@example.com")) },
      body: JSON.stringify({ status: "hello from alice #intro" }),
    });
    expect(created.status).toBe(200);
    const status = read(MastodonStatusPreviewSchema, created.body);
    expect(status.content).toContain("hello from alice");
    expect(status.account.username).toBe("alice");

    const me = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth("alice@example.com"),
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
      headers: await auth("alice@example.com"),
    });
    expect(home.status).toBe(200);
    expect(read(MastodonStatusListPreviewSchema, home.body)).not.toHaveLength(0);

    const webfinger = await json("/.well-known/webfinger?resource=acct:alice@example.com");
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
      headers: await auth("alice@example.com"),
    });
    const bobStatus = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("bob@example.com")) },
      body: JSON.stringify({ status: "bob says hi @alice" }),
    });
    expect(bobStatus.status).toBe(200);
    const posted = read(MastodonStatusPreviewSchema, bobStatus.body);

    const alice = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth("alice@example.com"),
    });
    expect(read(MastodonAccountPreviewSchema, alice.body).username).toBe("alice");

    const follow = await json(`/api/v1/accounts/${posted.account.id}/follow`, {
      method: "POST",
      headers: await auth("alice@example.com"),
    });
    expect(follow.status).toBe(200);
    expect(read(MastodonRelationshipPreviewSchema, follow.body)).toMatchObject({
      following: true,
    });

    const home = await json("/api/v1/timelines/home", {
      headers: await auth("alice@example.com"),
    });
    expect(
      read(MastodonStatusListPreviewSchema, home.body).some((item) => item.id === posted.id),
    ).toBe(true);

    const fav = await json(`/api/v1/statuses/${posted.id}/favourite`, {
      method: "POST",
      headers: await auth("alice@example.com"),
    });
    expect(fav.status).toBe(200);
    expect(read(MastodonStatusPreviewSchema, fav.body)).toMatchObject({ favourited: true });

    const bobNotes = await json("/api/v1/notifications", {
      headers: await auth("bob@example.com"),
    });
    expect(bobNotes.status).toBe(200);
    const bobTypes = read(MastodonNotificationListPreviewSchema, bobNotes.body).map(
      (item) => item.type,
    );
    expect(bobTypes).toEqual(expect.arrayContaining(["follow", "favourite"]));

    const aliceNotes = await json("/api/v1/notifications", {
      headers: await auth("alice@example.com"),
    });
    expect(aliceNotes.status).toBe(200);
    const aliceTypes = read(MastodonNotificationListPreviewSchema, aliceNotes.body).map(
      (item) => item.type,
    );
    expect(aliceTypes).toEqual(expect.arrayContaining(["mention"]));

    const search = await json(`/api/v2/search?q=bob&type=accounts`, {
      headers: await auth("alice@example.com"),
    });
    expect(search.status).toBe(200);
    expect(read(MastodonSearchPreviewSchema, search.body).accounts[0]?.username).toBe("bob");

    const relationships = await json(`/api/v1/accounts/relationships?id[]=${posted.account.id}`, {
      headers: await auth("alice@example.com"),
    });
    expect(read(MastodonRelationshipListPreviewSchema, relationships.body)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: posted.account.id, following: true })]),
    );
  });

  it("uploads media, creates polls, filters, and reports", async () => {
    const form = new FormData();
    form.set("file", new File(["hello"], "hello.txt", { type: "text/plain" }));
    const mediaResponse = await SELF.fetch("https://example.com/api/v1/media", {
      method: "POST",
      headers: await auth("alice@example.com"),
      body: form,
    });
    expect(mediaResponse.status).toBe(200);
    const media = read(MastodonMediaPreviewSchema, await mediaResponse.json());
    expect(media.id).toBeTruthy();
    expect(media.url).toContain("/attachments/");
    expect(media.url.endsWith(`/${media.id}`)).toBe(true);
    expect(media.preview_url).toBe(media.url);

    const mediaGet = await SELF.fetch(media.url);
    expect(mediaGet.status).toBe(200);
    expect(await mediaGet.text()).toBe("hello");
    expect(mediaGet.headers.get("cache-control")).toContain("max-age=31536000");

    const byId = await SELF.fetch(`https://example.com/media/${media.id}`);
    expect(byId.status).toBe(200);
    expect(await byId.text()).toBe("hello");

    const avatarForm = new FormData();
    avatarForm.set("display_name", "Alice Avatar");
    avatarForm.set("avatar", new File(["avatar-bytes"], "avatar.png", { type: "image/png" }));
    avatarForm.set("header", new File(["header-bytes"], "header.png", { type: "image/png" }));
    const profileResponse = await SELF.fetch(
      "https://example.com/api/v1/accounts/update_credentials",
      {
        method: "PATCH",
        headers: await auth("alice@example.com"),
        body: avatarForm,
      },
    );
    expect(profileResponse.status).toBe(200);
    const profile = read(MastodonAccountPreviewSchema, await profileResponse.json());
    expect(profile.avatar).toContain("/avatars/");
    expect(profile.header).toContain("/headers/");
    const avatarGet = await SELF.fetch(profile.avatar!);
    expect(avatarGet.status).toBe(200);
    expect(await avatarGet.text()).toBe("avatar-bytes");
    const headerGet = await SELF.fetch(profile.header!);
    expect(headerGet.status).toBe(200);
    expect(await headerGet.text()).toBe("header-bytes");

    const poll = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("alice@example.com")) },
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
      headers: { "content-type": "application/json", ...(await auth("bob@example.com")) },
      body: JSON.stringify({ choices: [0] }),
    });
    expect(vote.status).toBe(200);

    const filter = await json("/api/v1/filters", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("alice@example.com")) },
      body: JSON.stringify({ phrase: "spam", context: ["home"] }),
    });
    expect(filter.status).toBe(200);
    expect(read(MastodonFilterPreviewSchema, filter.body)).toMatchObject({ phrase: "spam" });

    const bob = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth("bob@example.com"),
    });
    const report = await json("/api/v1/reports", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("alice@example.com")) },
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
      headers: await auth("alice@example.com"),
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
      headers: await auth("alice@example.com"),
    });
    const carol = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth("carol@example.com"),
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
      { headers: await auth("carol@example.com") },
    );
    expect(read(MastodonRelationshipListPreviewSchema, relationships.body)).toEqual(
      expect.arrayContaining([expect.objectContaining({ following: true })]),
    );
  });

  it("accepts a remote Follow signed with a cached actor key", async () => {
    const alice = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth("alice@example.com"),
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
      headers: await auth("alice@example.com"),
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
      headers: { "content-type": "application/json", ...(await auth("alice@example.com")) },
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
      headers: await auth("queue-alice@example.com"),
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
        ...(await auth("queue-alice@example.com")),
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

  it("notifies authors when polls expire and rejects late votes", async () => {
    const created = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("poll-expire@example.com")) },
      body: JSON.stringify({
        status: "expire me",
        poll: { options: ["yes", "no"], expires_in: 3600, multiple: false },
      }),
    });
    expect(created.status).toBe(200);
    const status = read(MastodonStatusPreviewSchema, created.body);
    expect(status.poll?.id).toBeTruthy();
    const pollId = status.poll?.id ?? "";
    await env.DB.prepare(`UPDATE polls SET expires_at = ?, expiry_notified_at = NULL WHERE id = ?`)
      .bind("2020-01-01T00:00:00.000Z", pollId)
      .run();
    const pending = await listExpiredUnnotifiedPolls(env.DB, new Date().toISOString(), 20);
    expect(pending.isOk()).toBe(true);
    if (pending.isOk()) {
      expect(pending.value.some((row) => row.id === pollId)).toBe(true);
    }
    const job = OutboxJob.parse({ kind: "ProcessExpiredPolls" });
    expect(job.isOk()).toBe(true);
    if (job.isErr()) {
      throw new Error("expired polls job rejected");
    }
    await processOutboxJob(env, job.value);
    const after = await listExpiredUnnotifiedPolls(env.DB, new Date().toISOString(), 20);
    expect(after.isOk()).toBe(true);
    if (after.isOk()) {
      expect(after.value.some((row) => row.id === pollId)).toBe(false);
    }
    const lateVote = await json(`/api/v1/polls/${pollId}/votes`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("poll-voter@example.com")) },
      body: JSON.stringify({ choices: [0] }),
    });
    expect(lateVote.status).toBe(422);
  });

  it("publishes stream events onto a connected account hub", async () => {
    const account = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth("stream-hub@example.com"),
    });
    expect(account.status).toBe(200);
    const preview = read(MastodonAccountPreviewSchema, account.body);
    const upgrade = await SELF.fetch("https://example.com/api/v1/streaming", {
      headers: {
        ...(await auth("stream-hub@example.com")),
        Upgrade: "websocket",
      },
    });
    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket;
    expect(socket).toBeTruthy();
    if (!socket) {
      throw new Error("missing websocket");
    }
    socket.accept();
    const event = StreamEvent.parse({
      kind: "notification",
      payload: { type: "follow", account_id: preview.id, status_id: null },
    });
    expect(event.isOk()).toBe(true);
    if (event.isErr()) {
      throw new Error("stream event rejected");
    }
    const received = new Promise<string>((resolve) => {
      socket.addEventListener("message", (message) => {
        resolve(typeof message.data === "string" ? message.data : String(message.data));
      });
    });
    await publishToAccount(env, preview.id, event.value);
    const payload = JSON.parse(await received);
    expect(payload).toMatchObject({ kind: "notification" });
    socket.close();
  });

  it("threads replies through status context", async () => {
    const root = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("thread-root@example.com")) },
      body: JSON.stringify({ status: "root of the thread" }),
    });
    expect(root.status).toBe(200);
    const rootStatus = read(MastodonStatusPreviewSchema, root.body);

    const reply = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("thread-reply@example.com")) },
      body: JSON.stringify({ status: "a reply", in_reply_to_id: rootStatus.id }),
    });
    expect(reply.status).toBe(200);
    const replyStatus = read(MastodonStatusPreviewSchema, reply.body);
    expect(replyStatus.in_reply_to_id).toBe(rootStatus.id);
    expect(replyStatus.in_reply_to_account_id).toBe(rootStatus.account.id);

    const fromRoot = await json(`/api/v1/statuses/${rootStatus.id}/context`);
    expect(fromRoot.status).toBe(200);
    const rootContext = read(MastodonContextPreviewSchema, fromRoot.body);
    expect(rootContext.ancestors).toHaveLength(0);
    expect(rootContext.descendants.map((status) => status.id)).toContain(replyStatus.id);

    const fromReply = await json(`/api/v1/statuses/${replyStatus.id}/context`);
    expect(fromReply.status).toBe(200);
    const replyContext = read(MastodonContextPreviewSchema, fromReply.body);
    expect(replyContext.ancestors.map((status) => status.id)).toEqual([rootStatus.id]);
  });

  it("manages lists, membership, and list timelines", async () => {
    const owner = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth("list-owner@example.com"),
    });
    expect(owner.status).toBe(200);
    const member = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth("list-member@example.com"),
    });
    expect(member.status).toBe(200);
    const memberAccount = read(MastodonAccountPreviewSchema, member.body);

    const createdList = await json("/api/v1/lists", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("list-owner@example.com")) },
      body: JSON.stringify({ title: "Friends", replies_policy: "list" }),
    });
    expect(createdList.status).toBe(200);
    const list = read(
      z.object({ id: z.string(), title: z.string(), replies_policy: z.string() }),
      createdList.body,
    );
    expect(list.title).toBe("Friends");

    const addMembers = await json(`/api/v1/lists/${list.id}/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("list-owner@example.com")) },
      body: JSON.stringify({ account_ids: [memberAccount.id] }),
    });
    expect(addMembers.status).toBe(200);

    const members = await json(`/api/v1/lists/${list.id}/accounts`, {
      headers: await auth("list-owner@example.com"),
    });
    expect(members.status).toBe(200);
    expect(
      read(z.array(MastodonAccountPreviewSchema), members.body).some(
        (a) => a.id === memberAccount.id,
      ),
    ).toBe(true);

    const posted = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("list-member@example.com")) },
      body: JSON.stringify({ status: "hello list timeline" }),
    });
    expect(posted.status).toBe(200);
    const status = read(MastodonStatusPreviewSchema, posted.body);

    const timeline = await json(`/api/v1/timelines/list/${list.id}`, {
      headers: await auth("list-owner@example.com"),
    });
    expect(timeline.status).toBe(200);
    expect(
      read(MastodonStatusListPreviewSchema, timeline.body).some((item) => item.id === status.id),
    ).toBe(true);

    const containing = await json(`/api/v1/accounts/${memberAccount.id}/lists`, {
      headers: await auth("list-owner@example.com"),
    });
    expect(containing.status).toBe(200);
    expect(
      read(z.array(z.object({ id: z.string() })), containing.body).some(
        (item) => item.id === list.id,
      ),
    ).toBe(true);

    const renamed = await json(`/api/v1/lists/${list.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth("list-owner@example.com")) },
      body: JSON.stringify({ title: "Close friends" }),
    });
    expect(renamed.status).toBe(200);
    expect(read(z.object({ title: z.string() }), renamed.body).title).toBe("Close friends");

    const removed = await json(`/api/v1/lists/${list.id}/accounts`, {
      method: "DELETE",
      headers: { "content-type": "application/json", ...(await auth("list-owner@example.com")) },
      body: JSON.stringify({ account_ids: [memberAccount.id] }),
    });
    expect(removed.status).toBe(200);

    const deleted = await json(`/api/v1/lists/${list.id}`, {
      method: "DELETE",
      headers: await auth("list-owner@example.com"),
    });
    expect(deleted.status).toBe(200);
  });

  it("supports direct messages, conversations, and markers", async () => {
    await json("/api/v1/accounts/verify_credentials", {
      headers: await auth("dm-bob@example.com"),
    });
    const bob = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth("dm-bob@example.com"),
    });
    expect(bob.status).toBe(200);
    const bobAccount = read(MastodonAccountPreviewSchema, bob.body);

    const dm = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("dm-alice@example.com")) },
      body: JSON.stringify({ status: "@dm_bob secret hello", visibility: "direct" }),
    });
    expect(dm.status).toBe(200);
    const dmStatus = read(MastodonStatusPreviewSchema, dm.body);

    const asBob = await json(`/api/v1/statuses/${dmStatus.id}`, {
      headers: await auth("dm-bob@example.com"),
    });
    expect(asBob.status).toBe(200);

    const asStranger = await json(`/api/v1/statuses/${dmStatus.id}`, {
      headers: await auth("dm-stranger@example.com"),
    });
    expect(asStranger.status).toBe(404);

    const reply = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("dm-bob@example.com")) },
      body: JSON.stringify({
        status: "@dm_alice secret reply",
        visibility: "direct",
        in_reply_to_id: dmStatus.id,
      }),
    });
    expect(reply.status).toBe(200);

    const directTl = await json("/api/v1/timelines/direct", {
      headers: await auth("dm-alice@example.com"),
    });
    expect(directTl.status).toBe(200);
    const directStatuses = read(MastodonStatusListPreviewSchema, directTl.body);
    expect(directStatuses.some((status) => status.id === dmStatus.id)).toBe(true);

    const conversations = await json("/api/v1/conversations", {
      headers: await auth("dm-alice@example.com"),
    });
    expect(conversations.status).toBe(200);
    const conversationList = read(
      z.array(
        z.object({
          id: z.string(),
          unread: z.boolean(),
          accounts: z.array(MastodonAccountPreviewSchema),
        }),
      ),
      conversations.body,
    );
    expect(conversationList.length).toBeGreaterThan(0);
    const conversation = conversationList[0];
    expect(conversation?.id).toBe(dmStatus.id);
    expect(conversation?.unread).toBe(true);
    expect(conversation?.accounts.some((account) => account.id === bobAccount.id)).toBe(true);

    const readConversation = await json(`/api/v1/conversations/${dmStatus.id}/read`, {
      method: "POST",
      headers: await auth("dm-alice@example.com"),
    });
    expect(readConversation.status).toBe(200);

    const afterRead = await json("/api/v1/conversations", {
      headers: await auth("dm-alice@example.com"),
    });
    const afterList = read(
      z.array(z.object({ id: z.string(), unread: z.boolean() })),
      afterRead.body,
    );
    expect(afterList.find((item) => item.id === dmStatus.id)?.unread).toBe(false);

    const saveMarkers = await json("/api/v1/markers", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("dm-alice@example.com")) },
      body: JSON.stringify({
        home: { last_read_id: dmStatus.id },
        notifications: { last_read_id: "1" },
      }),
    });
    expect(saveMarkers.status).toBe(200);
    expect(saveMarkers.body).toMatchObject({
      home: { last_read_id: dmStatus.id, version: 1 },
      notifications: { last_read_id: "1", version: 1 },
    });

    const loadMarkers = await json("/api/v1/markers?timeline[]=home&timeline[]=notifications", {
      headers: await auth("dm-alice@example.com"),
    });
    expect(loadMarkers.status).toBe(200);
    expect(loadMarkers.body).toMatchObject({
      home: { last_read_id: dmStatus.id },
      notifications: { last_read_id: "1" },
    });
  });

  it("serves directory, peers, activity, and trends from local data", async () => {
    await json("/api/v1/accounts/verify_credentials", {
      headers: await auth("directory-user@example.com"),
    });
    const tagged = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("trend-user@example.com")) },
      body: JSON.stringify({ status: "trending #wavea topic" }),
    });
    expect(tagged.status).toBe(200);
    const taggedStatus = read(MastodonStatusPreviewSchema, tagged.body);
    await json(`/api/v1/statuses/${taggedStatus.id}/favourite`, {
      method: "POST",
      headers: await auth("trend-fan@example.com"),
    });

    const fetchedAt = IsoInstant.parse("2026-09-22T15:00:00.000Z");
    expect(fetchedAt.isOk()).toBe(true);
    if (fetchedAt.isErr()) {
      throw new Error("instant");
    }
    const keys = await generateAccountKeys();
    const actor = RemoteActor.fromFetched({
      actorUri: "https://peer.example/users/bob",
      username: "bob",
      domain: "peer.example",
      inboxUri: "https://peer.example/users/bob/inbox",
      publicKeyId: "https://peer.example/users/bob#main-key",
      publicKeyPem: keys.publicKeyPem,
      displayName: "Bob",
      fetchedAt: fetchedAt.value,
    });
    expect(actor.isOk()).toBe(true);
    if (actor.isErr()) {
      throw new Error("actor");
    }
    await upsertRemoteActor(env.DB, actor.value);

    const directory = await json("/api/v1/directory?order=new&limit=5");
    expect(directory.status).toBe(200);
    expect(read(z.array(MastodonAccountPreviewSchema), directory.body).length).toBeGreaterThan(0);

    const peers = await json("/api/v1/instance/peers");
    expect(peers.status).toBe(200);
    expect(read(z.array(z.string()), peers.body)).toContain("peer.example");

    const activity = await json("/api/v1/instance/activity");
    expect(activity.status).toBe(200);
    expect(
      read(z.array(z.object({ week: z.string(), statuses: z.string() })), activity.body).length,
    ).toBeGreaterThan(0);

    const trends = await json("/api/v1/trends/tags");
    expect(trends.status).toBe(200);
    const tags = read(z.array(z.object({ name: z.string() })), trends.body);
    expect(tags.some((tag) => tag.name === "wavea")).toBe(true);

    const trendStatuses = await json("/api/v1/trends/statuses");
    expect(trendStatuses.status).toBe(200);
    expect(read(MastodonStatusListPreviewSchema, trendStatuses.body).length).toBeGreaterThan(0);

    const linked = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("link-trend@example.com")) },
      body: JSON.stringify({
        status: "check https://news.example/story and https://news.example/story",
      }),
    });
    expect(linked.status).toBe(200);

    const trendLinks = await json("/api/v1/trends/links");
    expect(trendLinks.status).toBe(200);
    const links = read(
      z.array(
        z.object({ url: z.string().url(), history: z.array(z.object({ uses: z.string() })) }),
      ),
      trendLinks.body,
    );
    expect(links.some((link) => link.url === "https://news.example/story")).toBe(true);

    const rules = await json("/api/v1/instance/rules");
    expect(rules.status).toBe(200);
    expect(
      read(z.array(z.object({ id: z.string(), text: z.string() })), rules.body).length,
    ).toBeGreaterThan(0);

    const emojis = await json("/api/v1/custom_emojis");
    expect(emojis.status).toBe(200);
    expect(
      read(z.array(z.object({ shortcode: z.string(), url: z.string().url() })), emojis.body).some(
        (emoji) => emoji.shortcode === "blobcat",
      ),
    ).toBe(true);

    const announcements = await json("/api/v1/announcements", {
      headers: await auth("directory-user@example.com"),
    });
    expect(announcements.status).toBe(200);
    expect(
      read(z.array(z.object({ id: z.string(), content: z.string() })), announcements.body).some(
        (row) => row.id === "welcome",
      ),
    ).toBe(true);

    const suggestions = await json("/api/v1/suggestions", {
      headers: await auth("directory-user@example.com"),
    });
    expect(suggestions.status).toBe(200);
    expect(read(z.array(MastodonAccountPreviewSchema), suggestions.body).length).toBeGreaterThan(0);
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
