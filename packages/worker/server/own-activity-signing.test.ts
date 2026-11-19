import { schemaResult } from "@tstodon/core";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import type { ApActivityDocumentJSON } from "@tstodon/api/activitypub";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { envWith } from "../test/env-fixture";
import { enqueueLocalActivity } from "./delivery";
import { ldSignedBytes, readLdSignature, verifyLdSignature } from "./ld-signature";
import { listOutboundActivities } from "./outbox-store";
import { ldSigningOf } from "./own-activity-signature";
import { ownActivitySamples } from "./own-activity-samples";

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

  it("does not sign what Mastodon does not: a private status, its boost and its Delete, a Like, a pin", () => {
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

  it("in secure mode, signs a status's Delete but not its Create, as Mastodon", async () => {
    const account = await signedInAccount("ld-sign-secure@example.com");
    const actor = `https://example.com/users/${account.username}`;
    const note = `${actor}/statuses/1`;
    const secure = envWith({ AUTHORIZED_FETCH: "true" });
    const create = sample("createRichNote");
    if (create.type !== "Create" || create.object.type !== "Note") {
      throw new Error("sample");
    }
    const deleteNote = sample("deleteNote");
    if (deleteNote.type !== "Delete") {
      throw new Error("sample");
    }
    const object = { ...create.object, id: note, attributedTo: actor, to: [PUBLIC], cc: [] };
    (
      await enqueueLocalActivity(secure, account.id, "Create", {
        ...create,
        id: `${note}/activity`,
        actor,
        object,
      })
    )._unsafeUnwrap();
    (
      await enqueueLocalActivity(secure, account.id, "Delete", {
        ...deleteNote,
        id: `${note}#delete`,
        actor,
        to: [PUBLIC],
        cc: [],
        object: { id: note, type: "Tombstone", atomUri: note },
      })
    )._unsafeUnwrap();
    const [deleted, created] = await stored(account.id);
    expect(created?.activity.type).toBe("Create");
    expect(created?.activity.signature).toBeUndefined();
    expect(deleted?.activity.type).toBe("Delete");
    expect(await verifiesAsForward(deleted?.body, account.publicKeyPem)).toBe(true);
  });
});
