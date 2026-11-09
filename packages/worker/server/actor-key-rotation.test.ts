import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { IsoInstant, type InstanceIdentity, OutboxJob } from "@tstodon/domain";
import { adminBrowser, page, redirectsTo } from "../test/admin-browser";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { deliverTarget } from "../test/delivery-fixture";
import { postForm, signUp } from "../test/passkey-browser";
import { remoteActor } from "../test/remote-actor-fixture";
import { rotateActorKeysPage } from "./actor-key-rotation";
import { enqueueInstanceActorActivity, enqueueTargetedActivity } from "./delivery";
import {
  parseSignatureHeader,
  signFetchRequest,
  signInboxRequest,
  verifyInboxRequest,
  verifySignedFetch,
} from "./http-signature";
import { instanceActorFetchSigner, instanceActorKeys } from "./instance-actor";
import { generateAccountKeys } from "./keys";
import { processOutboxJob } from "./outbox-job";
import { findRemoteActorByUri } from "./remote-actor-store";
import { parseInstanceIdentity } from "./runtime-config";
import { signedFetchActor } from "./signed-fetch";

const ORIGIN = "https://example.com";

const identity = (): InstanceIdentity => parseInstanceIdentity(env)._unsafeUnwrap();

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const ActorSchema = z.object({
  id: z.string(),
  publicKey: z.object({ id: z.string(), owner: z.string(), publicKeyPem: z.string() }),
});

const actorKey = async (path: string) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    headers: { accept: "application/activity+json" },
  });
  expect(response.status).toBe(200);
  return read(ActorSchema, await response.json()).publicKey;
};

const post = async (path: string, headers: Record<string, string>) =>
  SELF.fetch(`${ORIGIN}${path}`, { method: "POST", headers });

const RotatedSchema = z.object({
  account_id: z.string(),
  rotated_at: z.string(),
  update: z.string(),
});

const IdRow = z.object({ id: z.string() });

/** The ids of the account's queued `Update`s, oldest first. */
const queuedUpdates = async (accountId: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT id FROM outbound_activities WHERE account_id = ? AND kind = 'Update' ORDER BY created_at, id",
  )
    .bind(accountId)
    .all();
  return (results ?? []).map((row) => read(IdRow, row).id);
};

const followedBy = async (accountId: string, followerUri: string): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind, created_at)
     VALUES (?, ?, ?, 'Fulfilled', 'Accepted', ?)`,
  )
    .bind(crypto.randomUUID(), followerUri, accountId, new Date().toISOString())
    .run();
};

const expandFollowers = async (activityId: string): Promise<string[]> => {
  const job = OutboxJob.parse({ kind: "ExpandFollowers", activityId });
  if (job.isErr()) {
    throw new Error("expand job rejected");
  }
  await processOutboxJob(env, job.value);
  const { results } = await env.DB.prepare(
    "SELECT inbox_url FROM outbox_deliveries WHERE activity_id = ? AND inbox_url IS NOT NULL",
  )
    .bind(activityId)
    .all();
  return (results ?? []).map((row) => read(z.object({ inbox_url: z.string() }), row).inbox_url);
};

const LogSchema = z.object({ kind: z.string() }).loose();

const logged = (calls: ReadonlyArray<ReadonlyArray<unknown>>, kind: string): number =>
  calls.filter((call) => {
    const line: unknown = call[0];
    if (typeof line !== "string" || !line.startsWith("{")) {
      return false;
    }
    const parsed = schemaResult(LogSchema)(JSON.parse(line));
    return parsed.isOk() && parsed.value.kind === kind;
  }).length;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("local account key rotation", () => {
  it("publishes a new key, signs with it from then on, and tells followers", async () => {
    const admin = await authHeaders("rotate-admin@example.com", { admin: true });
    const account = await signedInAccount("rotate-target@example.com");
    const follower = await remoteActor("rotate-follower", "followers.example");
    await followedBy(account.id, follower.actorUri);
    const inbox = `${follower.actorUri}/inbox`;
    // Queued before the rotation, delivered after it.
    expect(
      (
        await enqueueTargetedActivity(
          env,
          account.id,
          "Follow",
          {
            "@context": "https://www.w3.org/ns/activitystreams",
            id: `${ORIGIN}/users/${account.username}#follows/before-rotation`,
            type: "Follow",
            actor: `${ORIGIN}/users/${account.username}`,
            object: follower.actorUri,
          },
          inbox,
        )
      ).isOk(),
    ).toBe(true);
    const before = await actorKey(`/users/${account.username}`);
    expect(before.id).toBe(`${ORIGIN}/users/${account.username}#main-key`);

    const response = await post(`/api/v1/admin/accounts/${account.id}/rotate_key`, admin);
    expect(response.status).toBe(200);
    const rotated = read(RotatedSchema, await response.json());
    expect(rotated).toMatchObject({ account_id: account.id, update: "queued" });

    // Same key id (Mastodon's `#main-key`), new key.
    const after = await actorKey(`/users/${account.username}`);
    expect(after.id).toBe(before.id);
    expect(after.publicKeyPem).not.toBe(before.publicKeyPem);

    // The followers' servers are sent an `Update` carrying the new key.
    const updates = await queuedUpdates(account.id);
    expect(updates).toHaveLength(1);
    const updateId = updates[0] ?? "";
    expect(await expandFollowers(updateId)).toEqual([inbox]);
    const update = await deliverTarget(updateId, inbox);
    const body = read(
      z.object({
        type: z.literal("Update"),
        object: z.object({ publicKey: z.object({ publicKeyPem: z.string() }) }),
      }),
      JSON.parse(await update.clone().text()),
    );
    expect(body.object.publicKey.publicKeyPem).toBe(after.publicKeyPem);
    const updateBody = await update.clone().text();
    expect(await verifyInboxRequest(update.clone(), after.publicKeyPem, updateBody)).toBe(true);
    expect(await verifyInboxRequest(update.clone(), before.publicKeyPem, updateBody)).toBe(false);

    // An activity queued before the rotation is signed when it is sent: with the new key.
    const { results } = await env.DB.prepare(
      "SELECT id FROM outbound_activities WHERE account_id = ? AND kind = 'Follow'",
    )
      .bind(account.id)
      .all();
    const followId = read(IdRow, results?.[0]).id;
    const queued = await deliverTarget(followId, inbox);
    const queuedBody = await queued.clone().text();
    expect(await verifyInboxRequest(queued.clone(), after.publicKeyPem, queuedBody)).toBe(true);
    expect(await verifyInboxRequest(queued.clone(), before.publicKeyPem, queuedBody)).toBe(false);
  });

  it("rotates from the account's admin page, the admin's own included, after a confirmation", async () => {
    const admin = await adminBrowser("rotate_page_admin");
    const before = await actorKey("/users/rotate_page_admin");
    const path = `/admin/accounts/${admin.id}`;
    expect(await page(await admin.fetcher(path))).toContain("Rotate signing key");

    const asked = await page(await postForm(admin.fetcher, path, { do: "rotate_key" }));
    expect(asked).toContain("Rotate the signing key of @rotate_page_admin?");
    expect((await actorKey("/users/rotate_page_admin")).publicKeyPem).toBe(before.publicKeyPem);

    redirectsTo(
      await postForm(admin.fetcher, path, { do: "rotate_key", confirmed: "1" }),
      `${path}?notice=key_rotated`,
    );
    expect((await actorKey("/users/rotate_page_admin")).publicKeyPem).not.toBe(before.publicKeyPem);
  });

  it("answers 404 for an account that is not local", async () => {
    const admin = await authHeaders("rotate-404-admin@example.com", { admin: true });
    expect((await post("/api/v1/admin/accounts/no-such-account/rotate_key", admin)).status).toBe(
      404,
    );
  });
});

describe("instance actor key rotation", () => {
  it("publishes a new key and signs deliveries and fetches with it", async () => {
    const admin = await authHeaders("rotate-instance-admin@example.com", { admin: true });
    const before = await actorKey("/actor");

    const response = await post("/api/v1/admin/actor_keys/instance_actor", admin);
    expect(response.status).toBe(200);
    expect(read(z.object({ rotated_at: z.string() }), await response.json())).toBeTruthy();

    const after = await actorKey("/actor");
    expect(after.id).toBe(`${ORIGIN}/actor#main-key`);
    expect(after.publicKeyPem).not.toBe(before.publicKeyPem);
    expect((await instanceActorKeys(env.DB))._unsafeUnwrap().publicKeyPem).toBe(after.publicKeyPem);

    // A signed fetch.
    const signer = await instanceActorFetchSigner(env.DB, identity())();
    if (signer === undefined) {
      throw new Error("no instance actor key");
    }
    const url = new URL("https://remote.example/users/someone");
    const accept = "application/activity+json";
    const signed = (
      await signFetchRequest(url, signer.privateKeyJwk, signer.keyId, accept)
    )._unsafeUnwrap();
    const fetch = new Request(url, { headers: { ...signed, Accept: accept } });
    const parsed = parseSignatureHeader(signed.Signature);
    if (parsed === undefined) {
      throw new Error("signature header did not parse");
    }
    expect(await verifySignedFetch(fetch, parsed, after.publicKeyPem)).toBe(true);
    expect(await verifySignedFetch(fetch, parsed, before.publicKeyPem)).toBe(false);

    // A delivery.
    const inbox = "https://remote.example/users/rotate-flag/inbox";
    expect(
      (
        await enqueueInstanceActorActivity(
          env,
          "Flag",
          {
            "@context": "https://www.w3.org/ns/activitystreams",
            id: `${ORIGIN}/actor#rotate-flag`,
            type: "Flag",
            actor: `${ORIGIN}/actor`,
            content: "",
            object: ["https://remote.example/users/rotate-flag"],
          },
          inbox,
        )
      ).isOk(),
    ).toBe(true);
    const row = await env.DB.prepare(
      `SELECT a.id FROM outbound_activities a JOIN outbox_deliveries d ON d.activity_id = a.id
       WHERE a.account_id IS NULL AND d.inbox_url = ?`,
    )
      .bind(inbox)
      .first();
    const delivery = await deliverTarget(read(IdRow, row).id, inbox);
    const body = await delivery.clone().text();
    expect(await verifyInboxRequest(delivery.clone(), after.publicKeyPem, body)).toBe(true);
    expect(await verifyInboxRequest(delivery.clone(), before.publicKeyPem, body)).toBe(false);
  });

  it("rotates from the signing keys page after a confirmation", async () => {
    const admin = await adminBrowser("rotate_keys_page_admin");
    const before = await actorKey("/actor");
    expect(await page(await admin.fetcher("/admin/actor_keys"))).toContain("Signing keys");

    const asked = await page(
      await postForm(admin.fetcher, "/admin/actor_keys", { do: "rotate_instance" }),
    );
    expect(asked).toContain("Rotate the instance actor's key?");
    redirectsTo(
      await postForm(admin.fetcher, "/admin/actor_keys", {
        do: "rotate_instance",
        confirmed: "1",
      }),
      "/admin/actor_keys?notice=instance_key_rotated",
    );
    expect((await actorKey("/actor")).publicKeyPem).not.toBe(before.publicKeyPem);
    expect(await page(await admin.fetcher("/admin/actor_keys"))).toContain("last rotated");
  });
});

describe("bulk key rotation", () => {
  it("rotates every local key in bounded pages, each page chaining the next", async () => {
    const accounts = await Promise.all(
      ["bulk-a", "bulk-b", "bulk-c", "bulk-d", "bulk-e"].map((name) =>
        signedInAccount(`${name}@example.com`),
      ),
    );
    const keys = async () =>
      new Map(
        await Promise.all(
          accounts.map(
            async (account) =>
              [account.id, (await actorKey(`/users/${account.username}`)).publicKeyPem] as const,
          ),
        ),
      );
    const before = await keys();
    const instanceBefore = await actorKey("/actor");
    const startedAt = IsoInstant.parse(new Date().toISOString())._unsafeUnwrap();
    let job = { kind: "RotateActorKeys" as const, startedAt, afterId: "", rotated: 0 };
    const pages: number[] = [];
    for (let guard = 0; guard < 100; guard += 1) {
      const result = (await rotateActorKeysPage(env, identity(), job, 2))._unsafeUnwrap();
      pages.push(result.rotated);
      if (result.next === undefined) {
        break;
      }
      expect(result.next.afterId > job.afterId).toBe(true);
      job = result.next;
    }
    expect(pages.every((size) => size <= 2)).toBe(true);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    const after = await keys();
    for (const account of accounts) {
      expect(after.get(account.id)).not.toBe(before.get(account.id));
      expect(await queuedUpdates(account.id)).toHaveLength(1);
    }
    const instanceAfter = await actorKey("/actor");
    expect(instanceAfter.publicKeyPem).not.toBe(instanceBefore.publicKeyPem);

    // A page run again (a retry) skips what the run already rotated.
    const again = (
      await rotateActorKeysPage(env, identity(), { ...job, afterId: "", rotated: 0 }, 2)
    )._unsafeUnwrap();
    expect(again).toEqual({ rotated: 0, next: undefined });
    expect(await keys()).toEqual(after);
    expect(await actorKey("/actor")).toEqual(instanceAfter);
  });

  it("queues the next page with a pause, from the queue job", async () => {
    const send = vi
      .spyOn(env.OUTBOX_PROCESS_QUEUE, "send")
      .mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
    await Promise.all(
      Array.from({ length: 21 }, (_, n) => signedInAccount(`bulk-queue-${n}@example.com`)),
    );
    const startedAt = IsoInstant.parse(new Date().toISOString())._unsafeUnwrap();
    const job = OutboxJob.parse({ kind: "RotateActorKeys", startedAt });
    if (job.isErr()) {
      throw new Error("job rejected");
    }
    expect(await processOutboxJob(env, job.value)).toBe("ok");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "RotateActorKeys", startedAt, rotated: 20 }),
      { delaySeconds: 20 },
    );
  }, 60_000);

  it("is started by an admin from the API and the signing keys page", async () => {
    const send = vi
      .spyOn(env.OUTBOX_PROCESS_QUEUE, "send")
      .mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
    const admin = await authHeaders("bulk-api-admin@example.com", { admin: true });
    const response = await post("/api/v1/admin/actor_keys/rotate_all", admin);
    expect(response.status).toBe(202);
    const { started_at: startedAt } = read(
      z.object({ started_at: z.string() }),
      await response.json(),
    );
    expect(send).toHaveBeenCalledWith({
      kind: "RotateActorKeys",
      startedAt,
      afterId: "",
      rotated: 0,
    });

    send.mockClear();
    const browser = await adminBrowser("bulk_page_admin");
    redirectsTo(
      await postForm(browser.fetcher, "/admin/actor_keys", { do: "rotate_all", confirmed: "1" }),
      "/admin/actor_keys?notice=key_rotation_started",
    );
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: "RotateActorKeys" }));
  });
});

describe("key rotation authorization", () => {
  it("refuses users who are not admins, and requests without a token", async () => {
    const user = await authHeaders("rotate-user@example.com");
    const target = await signedInAccount("rotate-user-target@example.com");
    const before = await actorKey(`/users/${target.username}`);
    const instanceBefore = await actorKey("/actor");
    for (const path of [
      `/api/v1/admin/accounts/${target.id}/rotate_key`,
      "/api/v1/admin/actor_keys/instance_actor",
      "/api/v1/admin/actor_keys/rotate_all",
    ]) {
      expect((await post(path, user)).status, path).toBe(403);
      expect((await post(path, {})).status, path).toBe(401);
    }
    const { fetcher } = await signUp("rotate_not_admin");
    expect(await page(await fetcher("/admin/actor_keys"), 403)).toContain("administrators");
    for (const fields of [
      { do: "rotate_instance", confirmed: "1" },
      { do: "rotate_all", confirmed: "1" },
    ]) {
      expect((await postForm(fetcher, "/admin/actor_keys", fields)).status).toBe(403);
    }
    expect(
      (
        await postForm(fetcher, `/admin/accounts/${target.id}`, {
          do: "rotate_key",
          confirmed: "1",
        })
      ).status,
    ).toBe(403);
    expect((await actorKey(`/users/${target.username}`)).publicKeyPem).toBe(before.publicKeyPem);
    expect((await actorKey("/actor")).publicKeyPem).toBe(instanceBefore.publicKeyPem);
  });
});

describe("a remote actor that rotated its key", () => {
  const actorDocument = (actorUri: string, username: string, publicKeyPem: string) => ({
    "@context": ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"],
    id: actorUri,
    type: "Person",
    preferredUsername: username,
    inbox: `${actorUri}/inbox`,
    publicKey: { id: `${actorUri}#main-key`, owner: actorUri, publicKeyPem },
  });

  /** Serves the actor's document with `publicKeyPem`; counts the GETs of it. */
  const serveActor = (actorUri: string, username: string, publicKeyPem: () => string) => {
    const fetched: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      url.hash = "";
      if (url.href !== actorUri) {
        return new Response(null, { status: 404 });
      }
      fetched.push(url.href);
      return new Response(JSON.stringify(actorDocument(actorUri, username, publicKeyPem())), {
        headers: { "content-type": "application/activity+json" },
      });
    });
    return fetched;
  };

  const deliveryWith = async (
    actorUri: string,
    privateKeyJwk: Awaited<ReturnType<typeof generateAccountKeys>>["privateKeyJwk"],
  ): Promise<Request> => {
    const body = JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${actorUri}/likes/${crypto.randomUUID()}`,
      type: "Like",
      actor: actorUri,
      object: `${ORIGIN}/users/nobody/statuses/1`,
    });
    const url = new URL(`${ORIGIN}/inbox`);
    const headers = (
      await signInboxRequest(url, privateKeyJwk, `${actorUri}#main-key`, body)
    )._unsafeUnwrap();
    return new Request(url, { method: "POST", headers, body });
  };

  it("is fetched again once when its signature fails, and the request verifies", async () => {
    const remote = await remoteActor("rotating", "rotating.example");
    const rotated = await generateAccountKeys();
    let published = rotated.publicKeyPem;
    const fetched = serveActor(remote.actorUri, "rotating", () => published);
    const log = vi.spyOn(console, "log");

    const accepted = await SELF.fetch(await deliveryWith(remote.actorUri, rotated.privateKeyJwk));
    expect(accepted.status).not.toBe(401);
    expect(accepted.status).toBeLessThan(300);
    expect(fetched).toEqual([remote.actorUri]);
    expect(logged(log.mock.calls, "RemoteKeyRefetched")).toBe(1);
    const cached = (await findRemoteActorByUri(env.DB, remote.actorUri))._unsafeUnwrap();
    expect(cached?.publicKeyPem).toBe(rotated.publicKeyPem);

    // The next request with that key verifies against the cache: no fetch.
    expect(
      (await SELF.fetch(await deliveryWith(remote.actorUri, rotated.privateKeyJwk))).status,
    ).toBeLessThan(300);
    expect(fetched).toHaveLength(1);

    // It rotates again within the refetch window: not fetched, refused.
    const again = await generateAccountKeys();
    published = again.publicKeyPem;
    const throttled = await SELF.fetch(await deliveryWith(remote.actorUri, again.privateKeyJwk));
    expect(throttled.status).toBe(401);
    expect(fetched).toHaveLength(1);
    expect(logged(log.mock.calls, "RemoteKeyRefetchThrottled")).toBe(1);

    // Once the window has passed, the next failure fetches it again.
    await env.DB.prepare("UPDATE remote_actors SET key_refetched_at = ? WHERE actor_uri = ?")
      .bind(new Date(Date.now() - 6 * 60 * 1000).toISOString(), remote.actorUri)
      .run();
    expect(
      (await SELF.fetch(await deliveryWith(remote.actorUri, again.privateKeyJwk))).status,
    ).toBeLessThan(300);
    expect(fetched).toHaveLength(2);
  });

  it("stays refused when the refetched document has the same key (a forged signature)", async () => {
    const remote = await remoteActor("forged", "forged.example");
    const fetched = serveActor(remote.actorUri, "forged", () => remote.publicKeyPem);
    const forger = await generateAccountKeys();

    expect(
      (await SELF.fetch(await deliveryWith(remote.actorUri, forger.privateKeyJwk))).status,
    ).toBe(401);
    expect(fetched).toHaveLength(1);
    // Within the window a second forgery fetches nothing.
    expect(
      (await SELF.fetch(await deliveryWith(remote.actorUri, forger.privateKeyJwk))).status,
    ).toBe(401);
    expect(fetched).toHaveLength(1);
    const cached = (await findRemoteActorByUri(env.DB, remote.actorUri))._unsafeUnwrap();
    expect(cached?.publicKeyPem).toBe(remote.publicKeyPem);
  });

  it("verifies a signed GET after refetching the rotated key", async () => {
    const remote = await remoteActor("rotating-get", "rotating-get.example");
    const rotated = await generateAccountKeys();
    const fetched = serveActor(remote.actorUri, "rotating-get", () => rotated.publicKeyPem);
    const url = new URL(`${ORIGIN}/users/nobody`);
    const accept = "application/activity+json";
    const signed = (
      await signFetchRequest(url, rotated.privateKeyJwk, `${remote.actorUri}#main-key`, accept)
    )._unsafeUnwrap();
    const request = new Request(url, { headers: { ...signed, Accept: accept, Host: url.host } });

    const signer = await signedFetchActor(env, identity(), request);
    expect(signer?.actorUri).toBe(remote.actorUri);
    expect(fetched).toEqual([remote.actorUri]);
  });
});
