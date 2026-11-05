import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { signUp } from "../test/passkey-browser";
import { purgeAccount } from "./admin-actions";
import { processOutboxJob } from "./outbox-job";

const BYTES = [137, 80, 78, 71, 1, 2, 3];

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const fetchPath = (path: string, init?: RequestInit): Promise<Response> =>
  SELF.fetch(`https://example.com${path}`, { redirect: "manual", ...init });

const accountIdOf = async (email: string): Promise<string> => {
  const response = await fetchPath("/api/v1/accounts/verify_credentials", {
    headers: await authHeaders(email),
  });
  return read(z.object({ id: z.string().min(1) }), await response.json()).id;
};

const AttachmentSchema = z.object({ id: z.string().min(1), url: z.string().min(1) });

const upload = async (email: string): Promise<z.infer<typeof AttachmentSchema>> => {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(BYTES)], "a.png", { type: "image/png" }));
  const response = await fetchPath("/api/v2/media", {
    method: "POST",
    headers: await authHeaders(email),
    body: form,
  });
  expect(response.status).toBe(200);
  return read(AttachmentSchema, await response.json());
};

const post = async (
  email: string,
  mediaId: string,
  visibility: string,
): Promise<z.infer<typeof AttachmentSchema>> => {
  const response = await fetchPath("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ status: "a picture", media_ids: [mediaId], visibility }),
  });
  expect(response.status).toBe(200);
  const attachment = read(
    z.object({ media_attachments: z.array(AttachmentSchema) }),
    await response.json(),
  ).media_attachments[0];
  if (!attachment) {
    throw new Error("status has no attachment");
  }
  return attachment;
};

const bytesAt = async (url: string): Promise<number[]> => {
  const response = await SELF.fetch(url);
  expect(response.status).toBe(200);
  return [...new Uint8Array(await response.arrayBuffer())];
};

describe("media access", () => {
  it("does not serve a direct post's attachment to someone who knows only its account and id", async () => {
    const email = "media-direct@example.com";
    const accountId = await accountIdOf(email);
    const media = await upload(email);
    const attached = await post(email, media.id, "direct");

    // The id's instant bounds a guess; the stored object must not sit at the guessed key.
    expect((await fetchPath(`/attachments/${accountId}/${media.id}`)).status).toBe(404);
    expect((await fetchPath(`/media/${media.id}`)).status).toBe(404);

    const lastSegment = new URL(attached.url).pathname.split("/").at(-1) ?? "";
    expect(lastSegment).toMatch(/^[0-9a-f]{32}$/);
    expect(await bytesAt(attached.url)).toEqual(BYTES);
  });

  it("gives every upload its own random key", async () => {
    const email = "media-keys@example.com";
    const first = await upload(email);
    const second = await upload(email);
    expect(first.url).not.toBe(second.url);
    expect(first.url).not.toContain(first.id);
  });

  it("redirects /media/:id to the file only for media on a status the viewer may see", async () => {
    const email = "media-public@example.com";
    const media = await upload(email);
    expect((await fetchPath(`/media/${media.id}`)).status).toBe(404);

    const attached = await post(email, media.id, "public");
    const response = await fetchPath(`/media/${media.id}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(attached.url);

    const privateMedia = await upload(email);
    await post(email, privateMedia.id, "private");
    expect((await fetchPath(`/media/${privateMedia.id}`)).status).toBe(404);
  });

  it("redirects the author's own browser session to media on a private post", async () => {
    const { fetcher } = await signUp("media_owner");
    const email = "media_owner@mail.example";
    const media = await upload(email);
    const attached = await post(email, media.id, "private");

    const response = await fetcher(`/media/${media.id}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(attached.url);
    expect((await fetchPath(`/media/${media.id}`)).status).toBe(404);
  });
});

const StoredKeysSchema = z.object({
  object_key: z.string(),
  legacy_object_key: z.string().nullable(),
});

const storedKeys = async (
  mediaId: string,
): Promise<z.infer<typeof StoredKeysSchema> | undefined> => {
  const row = await env.DB.prepare(
    "SELECT object_key, legacy_object_key FROM media_attachments WHERE id = ?",
  )
    .bind(mediaId)
    .first();
  return row === null ? undefined : read(StoredKeysSchema, row);
};

/**
 * Put an upload back at the id-derived key it had before random keys. `AtLegacyKey`
 * is a row as the old Worker wrote it; `MovedKeepingLegacy` is a row already
 * pointed at its copy while the legacy object is still stored.
 */
const storeAtLegacyKey = async (
  accountId: string,
  mediaId: string,
  layout: "AtLegacyKey" | "MovedKeepingLegacy" = "AtLegacyKey",
): Promise<string> => {
  const legacyKey = `attachments/${accountId}/${mediaId}`;
  const current = await storedKeys(mediaId);
  if (!current) {
    throw new Error("media row missing");
  }
  const object = await env.MEDIA.get(current.object_key);
  if (!object) {
    throw new Error("media object missing");
  }
  await env.MEDIA.put(legacyKey, await object.arrayBuffer(), {
    httpMetadata: object.httpMetadata ?? {},
    customMetadata: { origin: "legacy" },
  });
  if (layout === "AtLegacyKey") {
    await env.MEDIA.delete(current.object_key);
  }
  await env.DB.prepare(
    "UPDATE media_attachments SET object_key = ?, legacy_object_key = ? WHERE id = ?",
  )
    .bind(
      layout === "AtLegacyKey" ? legacyKey : current.object_key,
      layout === "AtLegacyKey" ? null : legacyKey,
      mediaId,
    )
    .run();
  return legacyKey;
};

const statusAttachmentUrl = async (email: string, statusId: string): Promise<string> => {
  const response = await fetchPath(`/api/v1/statuses/${statusId}`, {
    headers: await authHeaders(email),
  });
  const url = read(
    z.object({ media_attachments: z.array(AttachmentSchema) }),
    await response.json(),
  ).media_attachments[0]?.url;
  if (!url) {
    throw new Error("status has no attachment");
  }
  return url;
};

const postWithId = async (email: string, mediaId: string): Promise<string> => {
  const response = await fetchPath("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ status: "old picture", media_ids: [mediaId], visibility: "direct" }),
  });
  return read(z.object({ id: z.string().min(1) }), await response.json()).id;
};

const rekey = (jobEnv: Env = env): Promise<unknown> =>
  processOutboxJob(jobEnv, { kind: "RekeyLegacyMedia", afterId: "" });

const deletingLegacy = (base: Env = env): Env =>
  Object.assign({}, base, { MEDIA_REKEY_DELETE_LEGACY: "true" });

const NETWORK_LOST = "D1_ERROR: Network connection lost.";

/** A D1 binding whose statements matching `matches` commit and then report a lost connection. */
const lostAfterCommit = (db: D1Database, matches: (sql: string) => boolean): D1Database => {
  const inner = new WeakMap<object, D1PreparedStatement>();
  const sqlOf = new WeakMap<object, string>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const outer = new Proxy(statement, {
      get(target, prop) {
        if (prop === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values), sql);
        }
        const value: unknown = Reflect.get(target, prop);
        if (typeof value !== "function") {
          return value;
        }
        if (matches(sql) && (prop === "all" || prop === "run" || prop === "first")) {
          return async (...args: unknown[]) => {
            await Reflect.apply(value, target, args);
            throw new Error(NETWORK_LOST);
          };
        }
        return (...args: unknown[]) => Reflect.apply(value, target, args);
      },
    });
    inner.set(outer, statement);
    sqlOf.set(outer, sql);
    return outer;
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => wrap(target.prepare(sql), sql);
      }
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements.map((s) => inner.get(s) ?? s));
          if (statements.some((s) => matches(sqlOf.get(s) ?? ""))) {
            throw new Error(NETWORK_LOST);
          }
          return results;
        };
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function"
        ? (...args: unknown[]) => Reflect.apply(value, target, args)
        : value;
    },
  });
};

/** An R2 binding that throws when asked for the object at `key`. */
const unreadableAt = (bucket: R2Bucket, key: string): R2Bucket =>
  new Proxy(bucket, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        if (prop === "get" && args[0] === key) {
          throw new Error("R2 get failed");
        }
        return Reflect.apply(value, target, args);
      };
    },
  });

const RANDOM_KEY = (accountId: string): RegExp =>
  new RegExp(`^attachments/${accountId}/[0-9a-f]{32}$`);

describe("rekeying attachments stored at an id-derived key", () => {
  it("copies the object to a random key and keeps the guessable one by default", async () => {
    const email = "media-legacy@example.com";
    const accountId = await accountIdOf(email);
    const media = await upload(email);
    const statusId = await postWithId(email, media.id);
    const legacyKey = await storeAtLegacyKey(accountId, media.id);
    expect(await statusAttachmentUrl(email, statusId)).toMatch(
      new RegExp(`/attachments/${accountId}/${media.id}$`),
    );

    expect(await rekey()).toBe("ok");

    const url = await statusAttachmentUrl(email, statusId);
    expect(new URL(url).pathname.slice(1)).toMatch(RANDOM_KEY(accountId));
    expect(await bytesAt(url)).toEqual(BYTES);
    const keys = await storedKeys(media.id);
    expect(keys?.legacy_object_key).toBe(legacyKey);
    expect((await env.MEDIA.head(keys?.object_key ?? ""))?.customMetadata).toEqual({
      origin: "legacy",
    });
    expect(await env.MEDIA.head(legacyKey)).not.toBeNull();

    expect(await rekey()).toBe("ok");
    expect(await statusAttachmentUrl(email, statusId)).toBe(url);
    expect(await env.MEDIA.head(legacyKey)).not.toBeNull();
  });

  it("deletes the guessable object once MEDIA_REKEY_DELETE_LEGACY is on", async () => {
    const email = "media-legacy-drop@example.com";
    const accountId = await accountIdOf(email);
    const media = await upload(email);
    const statusId = await postWithId(email, media.id);
    const legacyKey = await storeAtLegacyKey(accountId, media.id);
    expect(await rekey()).toBe("ok");
    const url = await statusAttachmentUrl(email, statusId);

    expect(await rekey(deletingLegacy())).toBe("ok");

    expect(await env.MEDIA.head(legacyKey)).toBeNull();
    expect((await fetchPath(`/attachments/${accountId}/${media.id}`)).status).toBe(404);
    expect(await statusAttachmentUrl(email, statusId)).toBe(url);
    expect(await bytesAt(url)).toEqual(BYTES);
    expect((await storedKeys(media.id))?.legacy_object_key).toBeNull();
  });

  it("finishes a move that stopped after the row took its new key", async () => {
    const email = "media-legacy-resume@example.com";
    const accountId = await accountIdOf(email);
    const media = await upload(email);
    const newKey = (await storedKeys(media.id))?.object_key;
    await storeAtLegacyKey(accountId, media.id, "MovedKeepingLegacy");

    expect(await rekey(deletingLegacy())).toBe("ok");

    expect((await fetchPath(`/attachments/${accountId}/${media.id}`)).status).toBe(404);
    expect(await storedKeys(media.id)).toEqual({ object_key: newKey, legacy_object_key: null });
    expect(await bytesAt(media.url)).toEqual(BYTES);
  });

  it("points the status's edit history at the new key", async () => {
    const email = "media-legacy-history@example.com";
    const accountId = await accountIdOf(email);
    const media = await upload(email);
    const statusId = await postWithId(email, media.id);
    await storeAtLegacyKey(accountId, media.id);
    const edited = await fetchPath(`/api/v1/statuses/${statusId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await authHeaders(email)) },
      body: JSON.stringify({ status: "old picture, edited", media_ids: [media.id] }),
    });
    expect(edited.status).toBe(200);

    expect(await rekey(deletingLegacy())).toBe("ok");

    const url = await statusAttachmentUrl(email, statusId);
    const history = await fetchPath(`/api/v1/statuses/${statusId}/history`, {
      headers: await authHeaders(email),
    });
    const revisions = read(
      z.array(z.object({ media_attachments: z.array(AttachmentSchema) })),
      await history.json(),
    );
    expect(revisions.length).toBeGreaterThan(1);
    for (const revision of revisions) {
      expect(revision.media_attachments.map((attachment) => attachment.url)).toEqual([url]);
    }
    expect(await bytesAt(url)).toEqual(BYTES);
  });

  it("keeps both objects when D1 loses the connection after pointing the row at the copy", async () => {
    const email = "media-legacy-lost@example.com";
    const accountId = await accountIdOf(email);
    const media = await upload(email);
    const statusId = await postWithId(email, media.id);
    const legacyKey = await storeAtLegacyKey(accountId, media.id);
    const flaky = {
      ...deletingLegacy(),
      DB: lostAfterCommit(env.DB, (sql) => sql.includes("UPDATE media_attachments SET object_key")),
    };

    await rekey(flaky);

    const moved = await storedKeys(media.id);
    expect(moved?.object_key).toMatch(RANDOM_KEY(accountId));
    expect(await env.MEDIA.head(moved?.object_key ?? "")).not.toBeNull();
    expect(await env.MEDIA.head(legacyKey)).not.toBeNull();

    expect(await rekey(deletingLegacy())).toBe("ok");
    expect(await env.MEDIA.head(legacyKey)).toBeNull();
    expect(await bytesAt(await statusAttachmentUrl(email, statusId))).toEqual(BYTES);
  });

  it("keeps the guessable object while the row's own object is missing", async () => {
    const email = "media-legacy-missing@example.com";
    const accountId = await accountIdOf(email);
    const media = await upload(email);
    const legacyKey = await storeAtLegacyKey(accountId, media.id, "MovedKeepingLegacy");
    await env.MEDIA.delete((await storedKeys(media.id))?.object_key ?? "");

    expect(await rekey(deletingLegacy())).toBe("ok");

    expect(await env.MEDIA.head(legacyKey)).not.toBeNull();
    expect((await storedKeys(media.id))?.legacy_object_key).toBe(legacyKey);
  });

  it("moves the other rows when one row's object cannot be read", async () => {
    const email = "media-legacy-unreadable@example.com";
    const accountId = await accountIdOf(email);
    const stuck = await upload(email);
    const movable = await upload(email);
    const stuckKey = await storeAtLegacyKey(accountId, stuck.id);
    await storeAtLegacyKey(accountId, movable.id);

    expect(await rekey({ ...env, MEDIA: unreadableAt(env.MEDIA, stuckKey) })).toBe("ok");

    expect((await storedKeys(stuck.id))?.object_key).toBe(stuckKey);
    expect((await storedKeys(movable.id))?.object_key).toMatch(RANDOM_KEY(accountId));
  });

  it("deletes both objects of unattached media removed before its move", async () => {
    const email = "media-legacy-delete@example.com";
    const accountId = await accountIdOf(email);
    const media = await upload(email);
    const newKey = (await storedKeys(media.id))?.object_key ?? "";
    const legacyKey = await storeAtLegacyKey(accountId, media.id, "MovedKeepingLegacy");

    const removed = await fetchPath(`/api/v1/media/${media.id}`, {
      method: "DELETE",
      headers: await authHeaders(email),
    });
    expect(removed.status).toBe(200);
    expect(await env.MEDIA.head(legacyKey)).toBeNull();
    expect(await env.MEDIA.head(newKey)).toBeNull();
  });

  it("purges copies under the account's prefix that no row names", async () => {
    const email = "media-legacy-purge@example.com";
    const accountId = await accountIdOf(email);
    const media = await upload(email);
    const rowKey = (await storedKeys(media.id))?.object_key ?? "";
    const orphan = `attachments/${accountId}/${"0".repeat(32)}`;
    await env.MEDIA.put(orphan, new Uint8Array(BYTES));

    expect((await purgeAccount(env, accountId)).isOk()).toBe(true);

    expect(await env.MEDIA.head(rowKey)).toBeNull();
    expect(await env.MEDIA.head(orphan)).toBeNull();
  });
});
