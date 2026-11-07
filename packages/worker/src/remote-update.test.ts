import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const json = async (path: string, init?: RequestInit): Promise<unknown> =>
  (await SELF.fetch(`https://example.com${path}`, init)).json();

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const StatusSchema = z.object({
  content: z.string(),
  edited_at: z.string().nullable(),
  created_at: z.string(),
  spoiler_text: z.string(),
  sensitive: z.boolean(),
});

const note = (
  author: Remote,
  slug: string,
  content: string,
  extra: Record<string, unknown> = {},
) => ({
  id: `https://remote.example/notes/${slug}`,
  type: "Note",
  attributedTo: author.actorUri,
  content,
  published: "2026-10-20T00:00:00.000Z",
  to: [PUBLIC],
  ...extra,
});

const create = async (author: Remote, slug: string, content: string): Promise<string> => {
  const object = note(author, slug, content);
  expect(
    await author.send({
      id: `https://remote.example/activities/create-${slug}`,
      type: "Create",
      object,
    }),
  ).toBe(202);
  const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
    .bind(object.id)
    .first<{ id: string }>();
  if (!row) {
    throw new Error(`remote note ${slug} was not stored`);
  }
  return row.id;
};

const status = async (id: string) => read(StatusSchema, await json(`/api/v1/statuses/${id}`));

const update = (author: Remote, slug: string, object: Record<string, unknown>) =>
  author.send({ id: `https://remote.example/activities/update-${slug}`, type: "Update", object });

describe("remote Update of a note", () => {
  it("refreshes the cached note and records when it was edited", async () => {
    const author = await remoteActor("update-author");
    const id = await create(author, "edit-me", "<p>before</p>");
    expect((await status(id)).edited_at).toBeNull();

    expect(
      await update(
        author,
        "edit-me",
        note(author, "edit-me", "<p>after</p>", {
          summary: "cw",
          sensitive: true,
          published: "2030-01-01T00:00:00.000Z",
          updated: "2026-10-21T12:00:00.000Z",
        }),
      ),
    ).toBe(202);

    const edited = await status(id);
    expect(edited.content).toBe("<p>after</p>");
    expect(edited.spoiler_text).toBe("cw");
    expect(edited.sensitive).toBe(true);
    expect(edited.edited_at).toBe("2026-10-21T12:00:00.000Z");
    expect(edited.created_at).toBe("2026-10-20T00:00:00.000Z");
  });

  it("does not let an older Update roll back a newer edit", async () => {
    const author = await remoteActor("update-order");
    const id = await create(author, "order-me", "<p>v1</p>");
    await update(
      author,
      "order-v3",
      note(author, "order-me", "<p>v3</p>", { updated: "2026-10-23T00:00:00.000Z" }),
    );
    await update(
      author,
      "order-v2",
      note(author, "order-me", "<p>v2</p>", { updated: "2026-10-22T00:00:00.000Z" }),
    );
    const current = await status(id);
    expect(current.content).toBe("<p>v3</p>");
    expect(current.edited_at).toBe("2026-10-23T00:00:00.000Z");
  });

  it("ignores an Update from an actor that did not write the note", async () => {
    const author = await remoteActor("update-owner");
    const impostor = await remoteActor("update-impostor", "elsewhere.example");
    const id = await create(author, "not-yours", "<p>mine</p>");

    expect(
      await update(
        impostor,
        "hijack-attributed",
        note(author, "not-yours", "<p>hijacked</p>", { updated: "2026-10-21T00:00:00.000Z" }),
      ),
    ).toBe(202);
    expect(
      await update(
        impostor,
        "hijack-claimed",
        note(impostor, "not-yours", "<p>hijacked</p>", { updated: "2026-10-21T00:00:00.000Z" }),
      ),
    ).toBe(202);

    const unchanged = await status(id);
    expect(unchanged.content).toBe("<p>mine</p>");
    expect(unchanged.edited_at).toBeNull();
  });

  it("does not store a note it never cached", async () => {
    const author = await remoteActor("update-unknown");
    const object = note(author, "never-seen", "<p>surprise</p>");
    expect(await update(author, "never-seen", object)).toBe(202);
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM remote_statuses WHERE object_uri = ?",
    )
      .bind(object.id)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("notifies only accounts that the edit newly mentions", async () => {
    const email = "remote-update-mention@example.com";
    const headers = await authHeaders(email);
    const account = read(
      z.object({ username: z.string() }),
      await json("/api/v1/accounts/verify_credentials", { headers }),
    );
    const actorUrl = `https://example.com/users/${account.username}`;
    const author = await remoteActor("update-mentioner");
    const id = await create(author, "add-mention", "<p>hi</p>");
    const mentioning = note(author, "add-mention", "<p>hi @you</p>", {
      tag: [{ type: "Mention", href: actorUrl }],
      cc: [actorUrl],
      updated: "2026-10-21T00:00:00.000Z",
    });
    await update(author, "add-mention-1", mentioning);
    await update(author, "add-mention-2", { ...mentioning, updated: "2026-10-22T00:00:00.000Z" });

    const mentions = read(
      z.array(z.object({ status: z.object({ id: z.string() }) })),
      await json("/api/v1/notifications?types[]=mention", { headers }),
    );
    expect(mentions.filter((entry) => entry.status.id === id)).toHaveLength(1);
  });

  it("notifies once when an edit turns a silent mention into a real one", async () => {
    const email = "remote-update-silent-mention@example.com";
    const headers = await authHeaders(email);
    const account = read(
      z.object({ id: z.string(), username: z.string() }),
      await json("/api/v1/accounts/verify_credentials", { headers }),
    );
    const actorUrl = `https://example.com/users/${account.username}`;
    const author = await remoteActor("update-silent-mentioner");
    const id = await create(author, "silent-mention", "<p>hi</p>");
    await env.DB.prepare(
      "INSERT INTO remote_status_mentions (status_id, account_id, silent) VALUES (?, ?, 1)",
    )
      .bind(id, account.id)
      .run();
    const mentioning = note(author, "silent-mention", "<p>hi @you</p>", {
      tag: [{ type: "Mention", href: actorUrl }],
      cc: [actorUrl],
      updated: "2026-10-21T00:00:00.000Z",
    });

    const mentionCount = async () =>
      read(
        z.array(z.object({ status: z.object({ id: z.string() }) })),
        await json("/api/v1/notifications?types[]=mention", { headers }),
      ).filter((entry) => entry.status.id === id).length;

    await update(author, "silent-mention-1", mentioning);
    expect(await mentionCount()).toBe(1);
    await update(author, "silent-mention-2", {
      ...mentioning,
      updated: "2026-10-22T00:00:00.000Z",
    });
    expect(await mentionCount()).toBe(1);
  });
});

describe("update notifications to local boosters", () => {
  const NotificationsSchema = z.array(
    z.object({ type: z.string(), status: z.object({ id: z.string() }).nullable() }),
  );

  const updates = async (headers: Record<string, string>, id: string) =>
    read(NotificationsSchema, await json("/api/v1/notifications?types[]=update", { headers }))
      .filter((entry) => entry.status?.id === id)
      .map((entry) => entry.type);

  const boosted = async (email: string, id: string) => {
    const headers = await authHeaders(email);
    const response = await SELF.fetch(`https://example.com/api/v1/statuses/${id}/reblog`, {
      method: "POST",
      headers,
    });
    expect(response.status).toBe(200);
    return headers;
  };

  it("notifies a booster once per content edit, not for poll refreshes or replays", async () => {
    const author = await remoteActor("notify-booster-author");
    const id = await create(author, "boosted", "<p>v1</p>");
    const booster = await boosted("update-notify-booster@example.com", id);
    const bystander = await authHeaders("update-notify-bystander@example.com");

    const edit = note(author, "boosted", "<p>v2</p>", { updated: "2026-10-21T00:00:00.000Z" });
    await update(author, "boosted-1", edit);
    expect(await updates(booster, id)).toEqual(["update"]);

    await update(author, "boosted-2", edit);
    await update(author, "boosted-3", { ...edit, updated: "2026-10-20T12:00:00.000Z" });
    expect(await updates(booster, id)).toEqual(["update"]);
    expect(await updates(bystander, id)).toEqual([]);

    await update(
      author,
      "boosted-4",
      note(author, "boosted", "<p>v3</p>", { updated: "2026-10-22T00:00:00.000Z" }),
    );
    expect(await updates(booster, id)).toEqual(["update", "update"]);
  });

  it("notifies nobody when the note is edited without a booster", async () => {
    const author = await remoteActor("notify-no-booster-author");
    const id = await create(author, "unboosted", "<p>v1</p>");
    const reader = await authHeaders("update-notify-reader@example.com");
    await update(
      author,
      "unboosted-1",
      note(author, "unboosted", "<p>v2</p>", { updated: "2026-10-21T00:00:00.000Z" }),
    );
    expect(await updates(reader, id)).toEqual([]);
  });

  it("notifies a booster whose policy drops strangers, as `update` is not filterable", async () => {
    const author = await remoteActor("notify-policy-author");
    const id = await create(author, "policy", "<p>v1</p>");
    const booster = await boosted("update-notify-strict@example.com", id);
    const policy = await SELF.fetch("https://example.com/api/v2/notifications/policy", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...booster },
      body: JSON.stringify({ for_not_following: "drop", for_not_followers: "drop" }),
    });
    expect(policy.status).toBe(200);
    await update(
      author,
      "policy-1",
      note(author, "policy", "<p>v2</p>", { updated: "2026-10-21T00:00:00.000Z" }),
    );
    expect(await updates(booster, id)).toEqual(["update"]);
  });

  it("sends nothing to a booster who muted the author", async () => {
    const author = await remoteActor("notify-muted-author");
    const id = await create(author, "muted", "<p>v1</p>");
    const booster = await boosted("update-notify-muter@example.com", id);
    const muted = await SELF.fetch(
      `https://example.com/api/v1/accounts/${RemoteAccountId.encode(author.actorUri)}/mute`,
      { method: "POST", headers: booster },
    );
    expect(muted.status).toBe(200);
    await update(
      author,
      "muted-1",
      note(author, "muted", "<p>v2</p>", { updated: "2026-10-21T00:00:00.000Z" }),
    );
    expect(await updates(booster, id)).toEqual([]);
  });
});

describe("history and source of an edited remote note", () => {
  const HistorySchema = z.array(
    z.object({
      content: z.string(),
      spoiler_text: z.string(),
      sensitive: z.boolean(),
      created_at: z.string(),
      account: z.object({ acct: z.string() }),
      poll: z.object({ options: z.array(z.object({ title: z.string() })) }).nullable(),
      media_attachments: z.array(z.object({ url: z.string() })),
      emojis: z.array(z.object({ shortcode: z.string(), url: z.string() })),
    }),
  );

  const history = async (id: string) => {
    const response = await SELF.fetch(`https://example.com/api/v1/statuses/${id}/history`);
    expect(response.status).toBe(200);
    return read(HistorySchema, await response.json());
  };

  it("lists every version, the original first and the current one last", async () => {
    const author = await remoteActor("history-author");
    const id = await create(author, "history-me", "<p>v1</p>");
    expect(await history(id)).toMatchObject([{ content: "<p>v1</p>" }]);

    await update(
      author,
      "history-1",
      note(author, "history-me", "<p>v2</p>", {
        summary: "cw",
        sensitive: true,
        attachment: [
          { type: "Image", mediaType: "image/png", url: "https://remote.example/a.png" },
        ],
        tag: [{ type: "Emoji", name: ":blob:", icon: { url: "https://remote.example/blob.png" } }],
        updated: "2026-10-21T00:00:00.000Z",
      }),
    );
    await update(
      author,
      "history-2",
      note(author, "history-me", "<p>v3 :blob:</p>", {
        tag: [{ type: "Emoji", name: ":blob:", icon: { url: "https://remote.example/blob.png" } }],
        updated: "2026-10-22T00:00:00.000Z",
      }),
    );

    const versions = await history(id);
    expect(versions.map((version) => version.content)).toEqual([
      "<p>v1</p>",
      "<p>v2</p>",
      "<p>v3 :blob:</p>",
    ]);
    expect(versions.map((version) => version.created_at)).toEqual([
      "2026-10-20T00:00:00.000Z",
      "2026-10-21T00:00:00.000Z",
      "2026-10-22T00:00:00.000Z",
    ]);
    expect(versions[1]).toMatchObject({
      spoiler_text: "cw",
      sensitive: true,
      account: { acct: expect.stringContaining("history-author") },
      media_attachments: [{ url: "https://remote.example/a.png" }],
    });
    expect(versions[0]).toMatchObject({
      spoiler_text: "",
      sensitive: false,
      media_attachments: [],
    });
    expect(versions[2]?.emojis).toEqual([
      { shortcode: "blob", url: "https://remote.example/blob.png" },
    ]);
  });

  it("keeps no version for a poll count refresh or a replayed Update", async () => {
    const author = await remoteActor("history-replay");
    const id = await create(author, "history-replay", "<p>a</p>");
    const edit = note(author, "history-replay", "<p>b</p>", {
      updated: "2026-10-21T00:00:00.000Z",
    });
    await update(author, "replay-1", edit);
    await update(author, "replay-2", edit);
    await update(author, "replay-3", {
      ...edit,
      content: "<p>stale</p>",
      updated: "2026-10-20T12:00:00.000Z",
    });
    expect((await history(id)).map((version) => version.content)).toEqual(["<p>a</p>", "<p>b</p>"]);
  });

  it("hides the history of a note the viewer cannot see", async () => {
    const author = await remoteActor("history-private");
    const object = note(author, "history-private", "<p>dm</p>", { to: [author.actorUri] });
    await author.send({ id: `${object.id}/create`, type: "Create", object });
    const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
      .bind(object.id)
      .first<{ id: string }>();
    const response = await SELF.fetch(`https://example.com/api/v1/statuses/${row?.id}/history`);
    expect(response.status).toBe(404);
  });

  it("answers 404 on the source of a remote note and of another account's note", async () => {
    const author = await remoteActor("source-author");
    const id = await create(author, "source-me", "<p>x</p>");
    const reader = await authHeaders("remote-source-reader@example.com");
    expect(
      (await SELF.fetch(`https://example.com/api/v1/statuses/${id}/source`, { headers: reader }))
        .status,
    ).toBe(404);

    const writer = await authHeaders("remote-source-writer@example.com");
    const created = read(
      z.object({ id: z.string() }),
      await json("/api/v1/statuses", {
        method: "POST",
        headers: { ...writer, "content-type": "application/json" },
        body: JSON.stringify({ status: "mine", visibility: "public" }),
      }),
    );
    const source = (headers: Record<string, string>) =>
      SELF.fetch(`https://example.com/api/v1/statuses/${created.id}/source`, { headers });
    expect((await source(writer)).status).toBe(200);
    expect((await source(reader)).status).toBe(404);
  });
});

describe("remote Update of an actor", () => {
  const AccountSchema = z.object({ display_name: z.string(), note: z.string() });
  const account = async (actorUri: string) =>
    read(AccountSchema, await json(`/api/v1/accounts/${RemoteAccountId.encode(actorUri)}`));

  const profile = (author: Remote, id: string, name: string, summary: string) => ({
    id,
    type: "Person",
    preferredUsername: author.actorUri.split("/").pop(),
    inbox: `${author.actorUri}/inbox`,
    name,
    summary,
    publicKey: { id: `${author.actorUri}#main-key`, owner: id, publicKeyPem: author.publicKeyPem },
  });

  it("refreshes the signer's cached profile", async () => {
    const author = await remoteActor("profile-owner");
    expect((await account(author.actorUri)).display_name).toBe("Remote profile-owner");

    expect(
      await update(
        author,
        "profile",
        profile(author, author.actorUri, "New Name", "<p>new bio</p>"),
      ),
    ).toBe(202);

    const refreshed = await account(author.actorUri);
    expect(refreshed.display_name).toBe("New Name");
    expect(refreshed.note).toContain("new bio");
  });

  it("ignores an Update whose actor is not the signer", async () => {
    const author = await remoteActor("profile-signer");
    const victim = await remoteActor("profile-victim");

    expect(
      await update(
        author,
        "profile-forged",
        profile(victim, victim.actorUri, "Forged", "<p>forged</p>"),
      ),
    ).toBe(202);
    expect((await account(victim.actorUri)).display_name).toBe("Remote profile-victim");
    expect((await account(author.actorUri)).display_name).toBe("Remote profile-signer");
  });
});
