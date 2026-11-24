import { schemaResult, Sensitive } from "@tstodon/core";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import type { ApActivityDocumentJSON } from "@tstodon/api/activitypub";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { deliverTarget } from "../test/delivery-fixture";
import { envWith } from "../test/env-fixture";
import { meter, meterWork, patchD1, resetMeter } from "../test/meter";
import { remoteActor } from "../test/remote-actor-fixture";
import { findAccountById } from "./account-store";
import { rotateAccountKey } from "./actor-key-rotation";
import { enqueueLocalActivity, enqueueTargetedActivity } from "./delivery";
import { ldSignedBytes, readLdSignature, verifyLdSignature } from "./ld-signature";
import { insertForwardedActivity, listOutboundActivities } from "./outbox-store";
import { deliveredActivity, ldSigningOf } from "./own-activity-signature";
import { ownActivitySamples } from "./own-activity-samples";
import { parseInstanceIdentity } from "./runtime-config";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const StoredSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  signature: z.looseObject({ creator: z.string() }).optional(),
});

/** The activities `accountId` stored for delivery, newest first, as stored. */
const stored = async (accountId: string) => {
  const activities = await listOutboundActivities(env.DB, accountId, 50);
  if (activities.isErr()) {
    throw new Error(activities.error.message);
  }
  return activities.value.map((row) => {
    const body: unknown = JSON.parse(row.payload_json);
    const parsed = schemaResult(StoredSchema)(body);
    if (parsed.isErr()) {
      throw new Error("stored activity rejected");
    }
    return { body, activity: parsed.value };
  });
};

/** Whether `body` passes the check tstodon makes of a forward, with `publicKeyPem`. */
const verifiesAsForward = async (body: unknown, publicKeyPem: string): Promise<boolean> => {
  const signed = readLdSignature(body, new Date());
  if (signed.isErr()) {
    return false;
  }
  const bytes = await ldSignedBytes(signed.value);
  return bytes.isOk() && verifyLdSignature(signed.value, bytes.value, publicKeyPem);
};

const post = async (email: string, body: Record<string, unknown>): Promise<string> => {
  const response = await SELF.fetch("https://example.com/api/v1/statuses", {
    method: "POST",
    headers: { ...(await authHeaders(email)), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return z.object({ id: z.string() }).parse(await response.json()).id;
};

const sample = (name: string): ApActivityDocumentJSON => {
  const activity = ownActivitySamples()[name];
  if (activity === undefined) {
    throw new Error(name);
  }
  return activity;
};

describe("ldSigningOf", () => {
  it.each([
    ["createRichNote", "OutsideSecureMode"],
    ["createQuestion", "OutsideSecureMode"],
    ["updateNote", "OutsideSecureMode"],
    ["updateClosedPoll", "OutsideSecureMode"],
    ["announcePublic", "OutsideSecureMode"],
    ["announceUnlisted", "OutsideSecureMode"],
    ["updateActor", "OutsideSecureMode"],
    ["updateSuspendedActor", "OutsideSecureMode"],
    ["addHashtag", "OutsideSecureMode"],
    ["removeHashtag", "OutsideSecureMode"],
    ["quoteRequest", "OutsideSecureMode"],
    ["undoAnnounce", "Always"],
    ["deleteNote", "Always"],
    ["deleteActor", "Always"],
    ["deleteQuoteAuthorization", "Always"],
  ])("signs %s %s, as Mastodon", (name, signing) => {
    expect(ldSigningOf(sample(name))).toBe(signing);
  });

  it("does not sign what Mastodon does not: a private status, its edit, boost and Delete, a Like, a pin", () => {
    const note = sample("createRichNote");
    if (note.type !== "Create" || note.object.type !== "Note") {
      throw new Error("sample");
    }
    const followers = "https://tstodon.example/users/alice/followers";
    const privateNote = { ...note.object, to: [followers], cc: [] };
    expect(ldSigningOf({ ...note, object: privateNote })).toBe("Never");
    const announce = sample("announcePublic");
    if (announce.type !== "Announce") {
      throw new Error("sample");
    }
    const privateBoost = { ...announce, to: [followers], cc: [] };
    expect(ldSigningOf(privateBoost)).toBe("Never");
    const undo = sample("undoAnnounce");
    if (undo.type !== "Undo" || undo.object.type !== "Announce") {
      throw new Error("sample");
    }
    expect(ldSigningOf({ ...undo, object: { ...undo.object, to: [followers], cc: [] } })).toBe(
      "Never",
    );
    const edit = sample("updateNote");
    if (edit.type !== "Update" || edit.object.type !== "Note") {
      throw new Error("sample");
    }
    expect(ldSigningOf({ ...edit, object: { ...edit.object, to: [followers], cc: [] } })).toBe(
      "Never",
    );
    const deleted = sample("deleteNote");
    if (deleted.type !== "Delete") {
      throw new Error("sample");
    }
    expect(ldSigningOf({ ...deleted, to: [followers], cc: [] })).toBe("Never");
    expect(
      ldSigningOf({
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://tstodon.example/users/alice#likes/1",
        type: "Like",
        actor: "https://tstodon.example/users/alice",
        to: ["https://mastodon.example/users/alice"],
        object: "https://mastodon.example/users/alice/statuses/1",
      }),
    ).toBe("Never");
    expect(
      ldSigningOf({
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://tstodon.example/users/alice#adds/1",
        type: "Add",
        actor: "https://tstodon.example/users/alice",
        target: "https://tstodon.example/users/alice/collections/featured",
        object: "https://tstodon.example/users/alice/statuses/1",
      }),
    ).toBe("Never");
  });
});

describe("own activities as delivered", () => {
  it("signs a public note's Create once, with the author's key, so that a forward of it verifies", async () => {
    const email = "ld-sign-public@example.com";
    const account = await signedInAccount(email);
    await post(email, { status: "signed for forwarding", visibility: "public" });
    const [create] = await stored(account.id);
    const actor = `https://example.com/users/${account.username}`;
    expect(create?.activity).toMatchObject({
      type: "Create",
      signature: { type: "RsaSignature2017", creator: `${actor}#main-key` },
    });
    expect(await verifiesAsForward(create?.body, account.publicKeyPem)).toBe(true);
  });

  it("does not sign a followers-only note's Create", async () => {
    const email = "ld-sign-private@example.com";
    const account = await signedInAccount(email);
    await post(email, { status: "for followers", visibility: "private" });
    const [create] = await stored(account.id);
    expect(create?.activity.type).toBe("Create");
    expect(create?.activity.signature).toBeUndefined();
  });

  it.each([
    ["secure mode", { AUTHORIZED_FETCH: "true" }],
    ["limited federation", { FEDERATION_ALLOW_HOSTS: "mastodon.example" }],
  ])(
    "in %s, signs a status's Delete and the Undo of a boost but not a Create, as Mastodon",
    async (mode, vars) => {
      const account = await signedInAccount(`ld-sign-${mode.replace(" ", "-")}@example.com`);
      const actor = `https://example.com/users/${account.username}`;
      const note = `${actor}/statuses/1`;
      const secure = envWith(vars);
      const create = sample("createRichNote");
      const deleteNote = sample("deleteNote");
      const undo = sample("undoAnnounce");
      if (
        create.type !== "Create" ||
        create.object.type !== "Note" ||
        deleteNote.type !== "Delete" ||
        undo.type !== "Undo" ||
        undo.object.type !== "Announce"
      ) {
        throw new Error("sample");
      }
      const object = { ...create.object, id: note, attributedTo: actor, to: [PUBLIC], cc: [] };
      const enqueue = async (kind: string, activity: ApActivityDocumentJSON) =>
        (await enqueueLocalActivity(secure, account, kind, activity))._unsafeUnwrap();
      await enqueue("Create", { ...create, id: `${note}/activity`, actor, object });
      await enqueue("Delete", {
        ...deleteNote,
        id: `${note}#delete`,
        actor,
        to: [PUBLIC],
        cc: [],
        object: { id: note, type: "Tombstone", atomUri: note },
      });
      const boost = `${actor}/statuses/2/activity`;
      await enqueue("Undo", {
        ...undo,
        id: `${boost}/undo`,
        actor,
        object: { ...undo.object, id: boost, actor },
      });
      const [undone, deleted, created] = await stored(account.id);
      expect(created?.activity.type).toBe("Create");
      expect(created?.activity.signature).toBeUndefined();
      expect(deleted?.activity.type).toBe("Delete");
      expect(await verifiesAsForward(deleted?.body, account.publicKeyPem)).toBe(true);
      expect(undone?.activity.type).toBe("Undo");
      expect(await verifiesAsForward(undone?.body, account.publicKeyPem)).toBe(true);
    },
  );

  it("delivers an activity unsigned, and says so, when its signature cannot be made", async () => {
    const account = await signedInAccount("ld-sign-broken-key@example.com");
    const announce = sample("announcePublic");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const delivered = await deliveredActivity(
      env,
      { ...account, privateKeyJwk: Sensitive.of("{}") },
      announce,
    );
    expect(delivered).toEqual(announce);
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(
      expect.stringContaining('"kind":"ActivityNotLdSigned"'),
    );
    errors.mockRestore();
  });
});

describe("an activity stored before its author's key rotation (OPS-8)", () => {
  const INBOX = "https://rotated-ld.example/inbox";

  /** A public boost by the local account `username`. */
  const ownBoost = (username: string): ApActivityDocumentJSON => {
    const announce = sample("announcePublic");
    if (announce.type !== "Announce") {
      throw new Error("sample");
    }
    return { ...announce, actor: `https://example.com/users/${username}` };
  };

  const rotatedKey = async (accountId: string): Promise<string> => {
    const identity = parseInstanceIdentity(env)._unsafeUnwrap();
    (await rotateAccountKey(env, identity, accountId))._unsafeUnwrap();
    const account = (await findAccountById(env.DB, accountId))._unsafeUnwrap();
    if (account === undefined) {
      throw new Error("the account is gone");
    }
    return account.publicKeyPem;
  };

  const storedPayload = async (activityId: string): Promise<string> =>
    z
      .object({ payload_json: z.string() })
      .parse(
        await env.DB.prepare("SELECT payload_json FROM outbound_activities WHERE id = ?")
          .bind(activityId)
          .first(),
      ).payload_json;

  it("goes out signed with the new key, and every inbox gets the same body", async () => {
    const account = await signedInAccount("ld-sign-rotated@example.com");
    (
      await enqueueTargetedActivity(env, account, "Announce", ownBoost(account.username), INBOX)
    )._unsafeUnwrap();
    const [queued] = await stored(account.id);
    const activityId = (await listOutboundActivities(env.DB, account.id, 1))._unsafeUnwrap()[0]?.id;
    if (activityId === undefined) {
      throw new Error("nothing was queued");
    }
    expect(await verifiesAsForward(queued?.body, account.publicKeyPem)).toBe(true);

    const publicKeyPem = await rotatedKey(account.id);

    const sent = await (await deliverTarget(activityId, INBOX)).text();
    expect(await verifiesAsForward(JSON.parse(sent), publicKeyPem)).toBe(true);
    expect(await verifiesAsForward(JSON.parse(sent), account.publicKeyPem)).toBe(false);
    // Stored as sent: the next inbox gets the same body, not another signature.
    expect(await storedPayload(activityId)).toBe(sent);
    // Dated no earlier than the rotation, so no later delivery takes it for the old key's.
    const rotatedAt = z
      .object({ key_rotated_at: z.string() })
      .parse(
        await env.DB.prepare("SELECT key_rotated_at FROM accounts WHERE id = ?")
          .bind(account.id)
          .first(),
      ).key_rotated_at;
    const created = z
      .object({ signature: z.object({ created: z.string() }) })
      .parse(JSON.parse(sent)).signature.created;
    expect(Date.parse(created)).toBeGreaterThanOrEqual(Date.parse(rotatedAt));
    expect(await (await deliverTarget(activityId, INBOX)).text()).toBe(sent);
  });

  it("costs one more D1 statement, once per activity", async () => {
    const queue = async (email: string) => {
      const account = await signedInAccount(email);
      (
        await enqueueTargetedActivity(env, account, "Announce", ownBoost(account.username), INBOX)
      )._unsafeUnwrap();
      const id = (await listOutboundActivities(env.DB, account.id, 1))._unsafeUnwrap()[0]?.id;
      if (id === undefined) {
        throw new Error("nothing was queued");
      }
      return { account, id };
    };
    const statements = async (activityId: string): Promise<number> => {
      resetMeter();
      await meterWork(() => deliverTarget(activityId, INBOX));
      return meter.tally.statements;
    };
    patchD1();
    const unrotated = await queue("ld-sign-budget-unrotated@example.com");
    const rotated = await queue("ld-sign-budget-rotated@example.com");
    await rotatedKey(rotated.account.id);

    const baseline = await statements(unrotated.id);
    expect(await statements(rotated.id)).toBe(baseline + 1);
    expect(await statements(rotated.id)).toBe(baseline);
  });

  it("keeps a forwarded activity's signature, which is its actor's", async () => {
    const account = await signedInAccount("ld-sign-rotated-forward@example.com");
    const alice = await remoteActor("ld-sign-rotated-alice", "rotated-ld-a.example");
    const signed = await alice.ldSigned({
      id: `${alice.actorUri}/statuses/1#delete`,
      type: "Delete",
      actor: alice.actorUri,
      to: [PUBLIC],
      object: { id: `${alice.actorUri}/statuses/1`, type: "Tombstone" },
    });
    const payloadJson = JSON.stringify(signed);
    const activityId = (
      await insertForwardedActivity(env.DB, {
        accountId: account.id,
        kind: "Delete",
        payloadJson,
        forwardOf: String(signed["id"]),
      })
    )._unsafeUnwrap();
    if (activityId === undefined) {
      throw new Error("the forward was not stored");
    }

    await rotatedKey(account.id);

    expect(await (await deliverTarget(activityId, INBOX)).text()).toBe(payloadJson);
    expect(await storedPayload(activityId)).toBe(payloadJson);
  });

  it("never signs a forward whose signature names the local key, a forger's choice", async () => {
    const account = await signedInAccount("ld-sign-rotated-forged@example.com");
    const actor = `https://example.com/users/${account.username}`;
    // Anyone can write a `creator`: this one claims the local account's key.
    const forged = {
      "@context": ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"],
      id: "https://forger.example/activities/1",
      type: "Delete",
      actor,
      to: [PUBLIC],
      object: actor,
      signature: {
        type: "RsaSignature2017",
        creator: `${actor}#main-key`,
        created: "2020-01-01T00:00:00Z",
        signatureValue: "Zm9yZ2Vk",
      },
    };
    const payloadJson = JSON.stringify(forged);
    const activityId = (
      await insertForwardedActivity(env.DB, {
        accountId: account.id,
        kind: "Delete",
        payloadJson,
        forwardOf: forged.id,
      })
    )._unsafeUnwrap();
    if (activityId === undefined) {
      throw new Error("the forward was not stored");
    }

    await rotatedKey(account.id);

    expect(await (await deliverTarget(activityId, INBOX)).text()).toBe(payloadJson);
    expect(await storedPayload(activityId)).toBe(payloadJson);
  });

  it("does not sign again an activity whose actor is not its signer", async () => {
    const account = await signedInAccount("ld-sign-rotated-other-actor@example.com");
    const announce = sample("announcePublic");
    (await enqueueTargetedActivity(env, account, "Announce", announce, INBOX))._unsafeUnwrap();
    const activityId = (await listOutboundActivities(env.DB, account.id, 1))._unsafeUnwrap()[0]?.id;
    if (activityId === undefined) {
      throw new Error("nothing was queued");
    }
    // The sample's actor is `tstodon.example`'s alice, not this account.
    const payloadJson = await storedPayload(activityId);

    await rotatedKey(account.id);

    expect(await (await deliverTarget(activityId, INBOX)).text()).toBe(payloadJson);
  });
});
