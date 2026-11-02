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
