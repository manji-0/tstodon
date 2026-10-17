import { IsoInstant, RemoteActor } from "@tstodon/domain";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { findAccountByUsername } from "./account-store";
import { generateAccountKeys } from "./keys";
import { signInboxRequest } from "./http-signature";
import { listOutboundActivities } from "./outbox-store";
import {
  listAcceptedRemoteFollowerUris,
  listPendingRemoteFollowRequesters,
  upsertRemoteActor,
} from "./remote-actor-store";
import { MastodonAccountPreviewSchema } from "./schemas";
import { RemoteAccountId } from "./remote-account-id";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";

const auth = (email: string): Promise<Record<string, string>> => accessAuthHeaders(email);

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

const accountIdFor = async (email: string): Promise<string> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  return read(MastodonAccountPreviewSchema, response.body).id;
};

const lockAccount = async (accountId: string): Promise<void> => {
  await env.DB.prepare("UPDATE accounts SET locked = 1 WHERE id = ?").bind(accountId).run();
};

const pendingRequestIds = async (email: string): Promise<string[]> => {
  const response = await json("/api/v1/follow_requests", { headers: await auth(email) });
  expect(response.status).toBe(200);
  return read(z.array(MastodonAccountPreviewSchema), response.body).map((account) => account.id);
};

const follow = async (followerEmail: string, targetId: string) =>
  json(`/api/v1/accounts/${targetId}/follow`, {
    method: "POST",
    headers: await auth(followerEmail),
  });

describe("follow requests", () => {
  it("requires authentication", async () => {
    const response = await json("/api/v1/follow_requests");
    expect(response.status).toBe(401);
  });

  it("lists, authorizes, and clears a local follow request", async () => {
    const viewerId = await accountIdFor("fr-local-viewer@example.com");
    const requesterId = await accountIdFor("fr-local-requester@example.com");
    await lockAccount(viewerId);

    const requested = await follow("fr-local-requester@example.com", viewerId);
    expect(requested.status).toBe(200);
    expect(requested.body).toMatchObject({ requested: true, following: false });

    expect(await pendingRequestIds("fr-local-viewer@example.com")).toContain(requesterId);

    const authorized = await json(`/api/v1/follow_requests/${requesterId}/authorize`, {
      method: "POST",
      headers: await auth("fr-local-viewer@example.com"),
    });
    expect(authorized.status).toBe(200);
    expect(authorized.body).toMatchObject({ followed_by: true, following: false });

    const requesterRelationship = await json(`/api/v1/accounts/relationships?id[]=${viewerId}`, {
      headers: await auth("fr-local-requester@example.com"),
    });
    expect(requesterRelationship.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: viewerId, following: true })]),
    );

    expect(await pendingRequestIds("fr-local-viewer@example.com")).not.toContain(requesterId);
  });

  it("rejects a local follow request", async () => {
    const viewerId = await accountIdFor("fr-reject-viewer@example.com");
    const requesterId = await accountIdFor("fr-reject-requester@example.com");
    await lockAccount(viewerId);

    const requested = await follow("fr-reject-requester@example.com", viewerId);
    expect(requested.status).toBe(200);

    const rejected = await json(`/api/v1/follow_requests/${requesterId}/reject`, {
      method: "POST",
      headers: await auth("fr-reject-viewer@example.com"),
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ followed_by: false, requested: false });

    expect(await pendingRequestIds("fr-reject-viewer@example.com")).not.toContain(requesterId);

    const requesterRelationship = await json(`/api/v1/accounts/relationships?id[]=${viewerId}`, {
      headers: await auth("fr-reject-requester@example.com"),
    });
    expect(requesterRelationship.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: viewerId, following: false })]),
    );
  });

  it("returns 404 for a non-pending local request", async () => {
    await accountIdFor("fr-missing-viewer@example.com");
    const strangerId = await accountIdFor("fr-missing-stranger@example.com");

    const response = await json(`/api/v1/follow_requests/${strangerId}/authorize`, {
      method: "POST",
      headers: await auth("fr-missing-viewer@example.com"),
    });
    expect(response.status).toBe(404);

    const unknown = await json(`/api/v1/follow_requests/does-not-exist/authorize`, {
      method: "POST",
      headers: await auth("fr-missing-viewer@example.com"),
    });
    expect(unknown.status).toBe(404);
  });

  it("lists, authorizes, and delivers Accept for a remote follow request", async () => {
    const username = read(
      MastodonAccountPreviewSchema,
      (
        await json("/api/v1/accounts/verify_credentials", {
          headers: await auth("fr-remote-viewer@example.com"),
        })
      ).body,
    ).username;
    const local = await findAccountByUsername(env.DB, username);
    expect(local.isOk() && local.value).toBeTruthy();
    if (local.isErr() || !local.value) {
      throw new Error("local viewer missing");
    }
    await lockAccount(local.value.id);

    const actorUri = "https://remote.example/users/fr-frank";
    const keys = await generateAccountKeys();
    const fetchedAt = IsoInstant.parse("2026-09-20T15:00:00.000Z");
    expect(fetchedAt.isOk()).toBe(true);
    if (fetchedAt.isErr()) {
      throw new Error("invalid fixture instant");
    }
    const remote = RemoteActor.fromFetched({
      actorUri,
      username: "fr-frank",
      domain: "remote.example",
      inboxUri: "https://remote.example/users/fr-frank/inbox",
      publicKeyId: "https://remote.example/users/fr-frank#main-key",
      publicKeyPem: keys.publicKeyPem,
      displayName: "Frank",
      fetchedAt: fetchedAt.value,
    });
    expect(remote.isOk()).toBe(true);
    if (remote.isErr()) {
      throw new Error("remote actor fixture rejected");
    }
    expect((await upsertRemoteActor(env.DB, remote.value)).isOk()).toBe(true);

    const followId = "https://remote.example/activities/follow-fr-frank";
    const body = JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: followId,
      type: "Follow",
      actor: actorUri,
      object: `https://example.com/users/${username}`,
    });
    const headers = await signInboxRequest(
      new URL("https://example.com/inbox"),
      keys.privateKeyJwk,
      "https://remote.example/users/fr-frank#main-key",
      body,
    );
    expect(headers.isOk()).toBe(true);
    if (headers.isErr()) {
      throw new Error(headers.error.message);
    }
    const inbox = await json("/inbox", { method: "POST", headers: headers.value, body });
    expect(inbox.status).toBe(202);

    const listed = await json("/api/v1/follow_requests", {
      headers: await auth("fr-remote-viewer@example.com"),
    });
    expect(listed.status).toBe(200);
    const remoteId = RemoteAccountId.encode(actorUri);
    expect(read(z.array(MastodonAccountPreviewSchema), listed.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: remoteId, acct: "fr-frank@remote.example" }),
      ]),
    );

    const profile = await json(`/api/v1/accounts/${remoteId}`);
    expect(profile.status).toBe(200);
    expect(profile.body).toMatchObject({ id: remoteId, acct: "fr-frank@remote.example" });

    const authorize = await json(`/api/v1/follow_requests/${remoteId}/authorize`, {
      method: "POST",
      headers: await auth("fr-remote-viewer@example.com"),
    });
    expect(authorize.status).toBe(200);
    expect(authorize.body).toMatchObject({ followed_by: true });

    const accepted = await listAcceptedRemoteFollowerUris(env.DB, local.value.id, 20);
    expect(accepted.isOk()).toBe(true);
    if (accepted.isOk()) {
      expect(accepted.value).toContain(actorUri);
    }

    const pending = await listPendingRemoteFollowRequesters(env.DB, local.value.id, 20);
    expect(pending.isOk()).toBe(true);
    if (pending.isOk()) {
      expect(pending.value.map((request) => request.remoteActorUri)).not.toContain(actorUri);
    }

    const activities = await listOutboundActivities(env.DB, local.value.id, 20);
    expect(activities.isOk()).toBe(true);
    if (activities.isOk()) {
      expect(activities.value.some((activity) => activity.kind === "Accept")).toBe(true);
    }
  });

  it("rejects a remote follow request without accepting it", async () => {
    const username = read(
      MastodonAccountPreviewSchema,
      (
        await json("/api/v1/accounts/verify_credentials", {
          headers: await auth("fr-remote-reject-viewer@example.com"),
        })
      ).body,
    ).username;
    const local = await findAccountByUsername(env.DB, username);
    expect(local.isOk() && local.value).toBeTruthy();
    if (local.isErr() || !local.value) {
      throw new Error("local viewer missing");
    }
    await lockAccount(local.value.id);

    const actorUri = "https://remote.example/users/fr-grace";
    const keys = await generateAccountKeys();
    const fetchedAt = IsoInstant.parse("2026-09-20T15:00:00.000Z");
    if (fetchedAt.isErr()) {
      throw new Error("invalid fixture instant");
    }
    const remote = RemoteActor.fromFetched({
      actorUri,
      username: "fr-grace",
      domain: "remote.example",
      inboxUri: "https://remote.example/users/fr-grace/inbox",
      publicKeyId: "https://remote.example/users/fr-grace#main-key",
      publicKeyPem: keys.publicKeyPem,
      displayName: "Grace",
      fetchedAt: fetchedAt.value,
    });
    if (remote.isErr()) {
      throw new Error("remote actor fixture rejected");
    }
    expect((await upsertRemoteActor(env.DB, remote.value)).isOk()).toBe(true);

    const body = JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/follow-fr-grace",
      type: "Follow",
      actor: actorUri,
      object: `https://example.com/users/${username}`,
    });
    const headers = await signInboxRequest(
      new URL("https://example.com/inbox"),
      keys.privateKeyJwk,
      "https://remote.example/users/fr-grace#main-key",
      body,
    );
    if (headers.isErr()) {
      throw new Error(headers.error.message);
    }
    expect((await json("/inbox", { method: "POST", headers: headers.value, body })).status).toBe(
      202,
    );

    const rejected = await json(
      `/api/v1/follow_requests/${RemoteAccountId.encode(actorUri)}/reject`,
      {
        method: "POST",
        headers: await auth("fr-remote-reject-viewer@example.com"),
      },
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ followed_by: false });

    const accepted = await listAcceptedRemoteFollowerUris(env.DB, local.value.id, 20);
    expect(accepted.isOk()).toBe(true);
    if (accepted.isOk()) {
      expect(accepted.value).not.toContain(actorUri);
    }
    const pending = await listPendingRemoteFollowRequesters(env.DB, local.value.id, 20);
    if (pending.isOk()) {
      expect(pending.value.map((request) => request.remoteActorUri)).not.toContain(actorUri);
    }
  });
});
