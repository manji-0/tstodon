import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActorFromDocument } from "./remote-actor-fetch";

const ORIGIN = "https://example.com";
const MEDIA = "https://media.example.com";
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, init);
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

const ImageSchema = z.object({
  type: z.literal("Image"),
  mediaType: z.string().optional(),
  url: z.string(),
});

const ActorSchema = z.object({
  "@context": z.array(z.unknown()),
  id: z.string(),
  type: z.string(),
  name: z.string(),
  summary: z.string(),
  manuallyApprovesFollowers: z.boolean(),
  discoverable: z.boolean(),
  indexable: z.boolean(),
  published: z.string(),
  suspended: z.boolean().optional(),
  icon: ImageSchema.optional(),
  image: ImageSchema.optional(),
  tag: z.array(
    z.object({
      type: z.literal("Emoji"),
      name: z.string(),
      icon: z.object({ type: z.literal("Image"), url: z.string() }),
    }),
  ),
  attachment: z.array(
    z.object({ type: z.literal("PropertyValue"), name: z.string(), value: z.string() }),
  ),
});

const actorJson = async (username: string): Promise<unknown> => {
  const response = await json(`/users/${username}`, {
    headers: { Accept: "application/activity+json" },
  });
  expect(response.status).toBe(200);
  return response.body;
};

const actor = async (username: string) => read(ActorSchema, await actorJson(username));

const imageFile = (name: string, type: string): File =>
  new File([new Uint8Array([137, 80, 78, 71])], name, { type });

const updateProfile = async (email: string, form: FormData) => {
  const response = await json("/api/v1/accounts/update_credentials", {
    method: "PATCH",
    headers: await authHeaders(email),
    body: form,
  });
  expect(response.status).toBe(200);
  return read(z.object({ avatar: z.string(), header: z.string() }), response.body);
};

const UpdateSchema = z.object({
  "@context": z.array(z.unknown()),
  type: z.literal("Update"),
  actor: z.string(),
  to: z.array(z.string()),
  object: ActorSchema.omit({ "@context": true }),
});

/** The actor `Update`s the account queued, oldest first. */
const queuedUpdates = async (accountId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT payload_json FROM outbound_activities WHERE account_id = ? AND kind = 'Update' ORDER BY rowid",
  )
    .bind(accountId)
    .all<{ payload_json: string }>();
  return results.map((row) => read(UpdateSchema, JSON.parse(row.payload_json)));
};

describe("a local actor's profile", () => {
  it("publishes no icon, image or bio for an account that set none", async () => {
    const account = await signedInAccount("actor-bare@example.com");
    const document = await actor(account.username);
    expect(document.icon).toBeUndefined();
    expect(document.image).toBeUndefined();
    expect(document).toMatchObject({
      type: "Person",
      name: account.displayName,
      summary: "",
      manuallyApprovesFollowers: false,
      discoverable: true,
      indexable: true,
      published: `${account.createdAt.slice(0, 10)}T00:00:00Z`,
      tag: [],
      attachment: [],
    });
    expect(document.suspended).toBeUndefined();
  });

  it("publishes the avatar, header, bio, fields, flags and emoji as Mastodon does", async () => {
    const email = "actor-full@example.com";
    const account = await signedInAccount(email);
    const form = new FormData();
    form.set("display_name", "Full :tstodon:");
    form.set("note", "Hello <world>\nsecond line");
    form.set("locked", "true");
    form.set("bot", "true");
    form.set("discoverable", "false");
    form.set("indexable", "false");
    form.set("avatar", imageFile("a.png", "image/png"));
    form.set("header", imageFile("h.gif", "image/gif"));
    const rest = await updateProfile(email, form);
    // Profile fields go in as JSON.
    const fields = await json("/api/v1/accounts/update_credentials", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(await authHeaders(email)) },
      body: JSON.stringify({ fields: [{ name: "Site", value: "a & b" }] }),
    });
    expect(fields.status).toBe(200);

    const document = await actor(account.username);
    expect(document.icon).toEqual({ type: "Image", mediaType: "image/png", url: rest.avatar });
    expect(document.image).toEqual({ type: "Image", mediaType: "image/gif", url: rest.header });
    expect(document.icon?.url.startsWith(`${MEDIA}/avatars/${account.id}/`)).toBe(true);
    expect(document.image?.url.startsWith(`${MEDIA}/headers/${account.id}/`)).toBe(true);
    expect(document).toMatchObject({
      type: "Service",
      name: "Full :tstodon:",
      summary: "<p>Hello &lt;world&gt;<br>second line</p>",
      manuallyApprovesFollowers: true,
      discoverable: false,
      indexable: false,
      attachment: [{ type: "PropertyValue", name: "Site", value: "a &amp; b" }],
      tag: [
        {
          type: "Emoji",
          name: ":tstodon:",
          icon: { type: "Image", url: `${MEDIA}/emoji/tstodon.png` },
        },
      ],
    });
    const terms = document["@context"].find(
      (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
    );
    expect(terms).toMatchObject({
      manuallyApprovesFollowers: "as:manuallyApprovesFollowers",
      toot: "http://joinmastodon.org/ns#",
      schema: "http://schema.org#",
      PropertyValue: "schema:PropertyValue",
      value: "schema:value",
      discoverable: "toot:discoverable",
      indexable: "toot:indexable",
      suspended: "toot:suspended",
      Emoji: "toot:Emoji",
    });

    // Another tstodon instance reads the avatar, header and bio back.
    const raw = await actorJson(account.username);
    const parsed = remoteActorFromDocument(raw, document.id);
    expect(parsed.isOk()).toBe(true);
    expect(parsed.isOk() && parsed.value.profile).toMatchObject({
      avatarUrl: rest.avatar,
      headerUrl: rest.header,
      note: "Hello <world>\nsecond line",
      locked: true,
      bot: true,
    });
  });

  it("tells remote servers about a profile change with an actor Update", async () => {
    const email = "actor-update@example.com";
    const account = await signedInAccount(email);
    expect(await queuedUpdates(account.id)).toHaveLength(0);

    const form = new FormData();
    form.set("note", "New bio");
    form.set("avatar", imageFile("a.png", "image/png"));
    const rest = await updateProfile(email, form);
    const [update] = await queuedUpdates(account.id);
    const actorUri = `${ORIGIN}/users/${account.username}`;
    expect(update).toMatchObject({
      actor: actorUri,
      to: [PUBLIC],
      object: {
        id: actorUri,
        summary: "<p>New bio</p>",
        icon: { type: "Image", mediaType: "image/png", url: rest.avatar },
      },
    });
    expect(update?.["@context"]).toContain("https://www.w3.org/ns/activitystreams");

    // Removing the avatar is a change too; removing it again is not.
    const deleted = await json("/api/v1/profile/avatar", {
      method: "DELETE",
      headers: await authHeaders(email),
    });
    expect(deleted.status).toBe(200);
    const updates = await queuedUpdates(account.id);
    expect(updates).toHaveLength(2);
    expect(updates[1]?.object.icon).toBeUndefined();
    await json("/api/v1/profile/avatar", { method: "DELETE", headers: await authHeaders(email) });
    expect(await queuedUpdates(account.id)).toHaveLength(2);
  });

  it("strips a suspended account's profile and says it is suspended", async () => {
    const email = "actor-suspended@example.com";
    const account = await signedInAccount(email);
    const form = new FormData();
    form.set("display_name", "Shown Name");
    form.set("note", "Bio");
    form.set("locked", "true");
    form.set("avatar", imageFile("a.png", "image/png"));
    await updateProfile(email, form);

    const suspended = await json(`/api/v1/admin/accounts/${account.id}/suspend`, {
      method: "POST",
      headers: await authHeaders("actor-admin@example.com", { admin: true }),
    });
    expect(suspended.status).toBe(200);
    const document = await actor(account.username);
    expect(document).toMatchObject({
      name: account.username,
      summary: "",
      suspended: true,
      manuallyApprovesFollowers: false,
      discoverable: false,
      indexable: false,
      tag: [],
      attachment: [],
    });
    expect(document.icon).toBeUndefined();
  });
});
