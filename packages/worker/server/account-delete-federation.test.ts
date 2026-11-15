import { schemaResult } from "@tstodon/core";
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApActivityDocument, PUBLIC_COLLECTION } from "@tstodon/api/activitypub";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { deliverTarget } from "../test/delivery-fixture";
import { PNG_40X30 } from "../test/image-fixtures";
import { actorDeleteInboxes } from "./actor-delete";
import { purgeAccount } from "./admin-actions";
import { remoteActor } from "../test/remote-actor-fixture";
import { parseSignatureHeader, verifyInboxRequest } from "./http-signature";
import { findOutboundActivityWithSigner, persistOutboxTarget } from "./outbox-store";
import { listKnownRemoteInboxes } from "./remote-actor-store";
import { RemoteAccountId } from "./remote-account-id";

/**
 * INT-15, account deletion over federation: deleting a local account sends a
 * `Delete` of its actor, as Mastodon's `DeleteAccountService`, to the remote
 * servers that know it, signed with the account's key although the account's
 * row is gone when it is delivered.
 */

const ORIGIN = "https://example.com";

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const followedBy = async (accountId: string, followerUri: string): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind, created_at)
     VALUES (?, ?, ?, 'Fulfilled', 'Accepted', ?)`,
  )
    .bind(crypto.randomUUID(), followerUri, accountId, new Date().toISOString())
    .run();
};

const DeleteRows = z.array(
  z.object({ id: z.string(), account_id: z.string().nullable(), payload_json: z.string() }),
);

/** The queued `Delete` activities of `actorUri`, with the inboxes each goes to. */
const queuedActorDeletes = async (actorUri: string) => {
  const { results } = await env.DB.prepare(
    "SELECT id, account_id, payload_json FROM outbound_activities WHERE kind = 'Delete' ORDER BY rowid",
  ).all();
  const deletes = read(DeleteRows, results)
    .map((row) => ({
      ...row,
      activity: expectContract(ApActivityDocument, JSON.parse(row.payload_json)),
    }))
    .filter(({ activity }) => activity.actor === actorUri);
  return Promise.all(
    deletes.map(async (row) => {
      const targets = await env.DB.prepare(
        "SELECT inbox_url FROM outbox_deliveries WHERE activity_id = ? AND inbox_url IS NOT NULL ORDER BY inbox_url",
      )
        .bind(row.id)
        .all();
      return {
        ...row,
        inboxes: read(z.array(z.object({ inbox_url: z.string() })), targets.results).map(
          (target) => target.inbox_url,
        ),
      };
    }),
  );
};

/** Whether the private key kept to sign `activityId` is still stored. */
const keepsSignerKey = async (activityId: string): Promise<boolean> => {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM outbound_departed_signers WHERE activity_id = ?",
  )
    .bind(activityId)
    .first();
  return read(z.object({ n: z.number() }), row).n > 0;
};

const adminDelete = async (accountId: string): Promise<number> => {
  const response = await SELF.fetch(`${ORIGIN}/api/v1/admin/accounts/${accountId}`, {
    method: "DELETE",
    headers: await authHeaders("delete-federation-admin@example.com", { admin: true }),
  });
  await response.arrayBuffer();
  return response.status;
};

describe("deleting a local account", () => {
  it("sends a Delete of the actor to its followers' and its follows' inboxes, signed with its key", async () => {
    const email = "delete-leaver@example.com";
    const leaver = await signedInAccount(email);
    const actorUri = `${ORIGIN}/users/${leaver.username}`;
    const sharedInbox = "https://fans.example/inbox";
    const fan = await remoteActor("fan", "fans.example", { sharedInboxUri: sharedInbox });
    const otherFan = await remoteActor("other-fan", "fans.example", {
      sharedInboxUri: sharedInbox,
    });
    const followed = await remoteActor("followed", "followed.example");
    // Known to this server, with no tie to the account: it may hold a boost or a mention.
    const bystander = await remoteActor("bystander", "bystanders.example");
    await followedBy(leaver.id, fan.actorUri);
    await followedBy(leaver.id, otherFan.actorUri);
    const follow = await SELF.fetch(
      `${ORIGIN}/api/v1/accounts/${RemoteAccountId.encode(followed.actorUri)}/follow`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeaders(email)) },
        body: "{}",
      },
    );
    expect(follow.status).toBe(200);
    const actor = await SELF.fetch(actorUri, { headers: { accept: "application/activity+json" } });
    const { publicKeyPem } = read(
      z.object({ publicKey: z.object({ publicKeyPem: z.string() }) }),
      await actor.json(),
    ).publicKey;

    expect(await adminDelete(leaver.id)).toBe(200);

    // Gone for good, where a name that never existed is not found.
    const gone = await SELF.fetch(actorUri, { headers: { accept: "application/activity+json" } });
    expect(gone.status).toBe(410);
    const unknown = await SELF.fetch(`${ORIGIN}/users/delete_never_existed`, {
      headers: { accept: "application/activity+json" },
    });
    expect(unknown.status).toBe(404);
    const deletes = await queuedActorDeletes(actorUri);
    expect(deletes).toHaveLength(1);
    const [queued] = deletes;
    if (!queued) {
      throw new Error("no Delete queued");
    }
    expect(queued.account_id).toBeNull();
    expect(queued.activity).toEqual({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: expect.stringMatching(new RegExp(`^${actorUri}#deletes/[0-9]+$`)),
      type: "Delete",
      actor: actorUri,
      to: [PUBLIC_COLLECTION],
      object: actorUri,
    });
    expect(queued.inboxes).toEqual(
      [sharedInbox, `${followed.actorUri}/inbox`, `${bystander.actorUri}/inbox`].toSorted(),
    );

    const sent = await deliverTarget(queued.id, sharedInbox);
    const body = await sent.clone().text();
    expect(parseSignatureHeader(sent.headers.get("signature") ?? "")?.keyId).toBe(
      `${actorUri}#main-key`,
    );
    expect(await verifyInboxRequest(sent.clone(), publicKeyPem, body)).toBe(true);

    // The key is kept while an inbox is still to be attempted, and no longer.
    expect(await keepsSignerKey(queued.id)).toBe(true);
    for (const inbox of [sharedInbox, `${bystander.actorUri}/inbox`]) {
      expect(
        (await persistOutboxTarget(env.DB, queued.id, inbox, { kind: "Delivered" })).isOk(),
      ).toBe(true);
    }
    expect(await keepsSignerKey(queued.id)).toBe(true);
    expect(
      (
        await persistOutboxTarget(env.DB, queued.id, `${followed.actorUri}/inbox`, {
          kind: "Failed",
          reasonKind: "Permanent",
          httpStatus: 410,
        })
      ).isOk(),
    ).toBe(true);
    expect(await keepsSignerKey(queued.id)).toBe(false);
    const settled = await findOutboundActivityWithSigner(env.DB, queued.id);
    expect(settled.isOk() && settled.value?.signer_private_key_jwk).toBeNull();
  });

  it("sends nothing when the deletion fails part way, and one Delete when it is tried again", async () => {
    const email = "delete-retried@example.com";
    const leaver = await signedInAccount(email);
    const actorUri = `${ORIGIN}/users/${leaver.username}`;
    const fan = await remoteActor("retry-fan", "retry-fans.example");
    await followedBy(leaver.id, fan.actorUri);
    const upload = new FormData();
    upload.set("file", new File([PNG_40X30], "a.png", { type: "image/png" }));
    const uploaded = await SELF.fetch(`${ORIGIN}/api/v2/media`, {
      method: "POST",
      headers: await authHeaders(email),
      body: upload,
    });
    expect(uploaded.status).toBe(200);

    const failingBucket = new Proxy(env.MEDIA, {
      get: (target, key) =>
        key === "delete"
          ? async () => {
              throw new Error("the bucket does not answer");
            }
          : Reflect.get(target, key),
    });
    await expect(purgeAccount({ ...env, MEDIA: failingBucket }, leaver.id)).rejects.toThrow(
      "the bucket does not answer",
    );

    expect(await queuedActorDeletes(actorUri)).toEqual([]);
    const kept = await SELF.fetch(actorUri, { headers: { accept: "application/activity+json" } });
    expect(kept.status).toBe(200);

    expect((await purgeAccount(env, leaver.id)).isOk()).toBe(true);
    const deletes = await queuedActorDeletes(actorUri);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.inboxes).toContain(`${fan.actorUri}/inbox`);
  });

  it("gives the Delete of a username that is registered and deleted again another id", async () => {
    const email = "delete-again@example.com";
    const inbox = "https://again-fans.example/users/again-fan/inbox";
    const fan = await remoteActor("again-fan", "again-fans.example");
    const ids: string[] = [];
    for (const _round of [1, 2]) {
      const leaver = await signedInAccount(email);
      const actorUri = `${ORIGIN}/users/${leaver.username}`;
      const served = await SELF.fetch(actorUri, {
        headers: { accept: "application/activity+json" },
      });
      expect(served.status).toBe(200);
      await followedBy(leaver.id, fan.actorUri);
      expect(await adminDelete(leaver.id)).toBe(200);
      const deletes = await queuedActorDeletes(actorUri);
      expect(deletes.at(-1)?.inboxes).toContain(inbox);
      ids.push(deletes.at(-1)?.activity.id ?? "");
      // The fixture's sign-in row, which it makes itself and a purge leaves.
      await env.DB.prepare('DELETE FROM "user" WHERE email = ?').bind(email).run();
    }
    expect(new Set(ids).size).toBe(2);
  });

  it("caps only the other known inboxes, never the account's followers and follows", () => {
    const related = ["https://a.example/inbox", "https://b.example/inbox"];
    const known = ["https://c.example/inbox", "https://a.example/inbox", "https://d.example/inbox"];
    expect(actorDeleteInboxes(related, known, 3)).toEqual([
      "https://a.example/inbox",
      "https://b.example/inbox",
      "https://c.example/inbox",
    ]);
    expect(actorDeleteInboxes(related, known, 1)).toEqual(related);
    expect(actorDeleteInboxes(related, known, 0)).toEqual(related);
  });

  it("leaves the servers the instance suspends out of the known inboxes, so they take no slot under the cap", async () => {
    const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO domain_blocks (id, domain, severity) VALUES ('known-inboxes-suspended', 'Suspended-Known.example', 'suspend')",
    ).run();
    const kept = await remoteActor("kept", "kept-known.example", { fetchedAt: soon(1) });
    await remoteActor("newest", "suspended-known.example", { fetchedAt: soon(2) });
    await remoteActor("on-host", "elsewhere-known.example", {
      accountDomain: "suspended-known.example",
      fetchedAt: soon(3),
    });

    const known = await listKnownRemoteInboxes(env.DB, 1);

    expect(known.isOk() && known.value).toEqual([`${kept.actorUri}/inbox`]);
  });

  it("sends nothing for an account no remote server knows", async () => {
    const loner = await signedInAccount("delete-loner@example.com");
    const actorUri = `${ORIGIN}/users/${loner.username}`;

    expect(await adminDelete(loner.id)).toBe(200);

    expect(await queuedActorDeletes(actorUri)).toEqual([]);
  });
});
