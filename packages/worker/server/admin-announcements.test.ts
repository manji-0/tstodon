import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { ApiAnnouncement } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const auth = (email: string, admin = false): Promise<Record<string, string>> =>
  authHeaders(email, { admin });

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

const AdminAnnouncementSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  content: z.string(),
  starts_at: z.string().nullable(),
  ends_at: z.string().nullable(),
  all_day: z.boolean(),
  published_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const PublicAnnouncementSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  read: z.boolean(),
});

const create = async (
  email: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> =>
  json("/api/v1/admin/announcements", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email, true)) },
    body: JSON.stringify(body),
  });

const publicIds = async (email: string): Promise<string[]> => {
  const response = await json("/api/v1/announcements", { headers: await auth(email) });
  expect(response.status).toBe(200);
  return read(z.array(PublicAnnouncementSchema), response.body).map((entry) => entry.id);
};

describe("admin announcements", () => {
  it("rejects non-admins", async () => {
    expect((await json("/api/v1/admin/announcements")).status).toBe(401);
    expect(
      (await json("/api/v1/admin/announcements", { headers: await auth("ann-plain@example.com") }))
        .status,
    ).toBe(403);
  });

  it("creates, publishes, edits, and deletes an announcement", async () => {
    const email = "ann-admin@example.com";
    const created = await create(email, { text: "Server maintenance <soon>" });
    expect(created.status).toBe(200);
    const announcement = read(AdminAnnouncementSchema, created.body);
    expect(announcement.content).toBe("<p>Server maintenance &lt;soon&gt;</p>");
    expect(announcement.published_at).not.toBeNull();

    expect(await publicIds("ann-reader@example.com")).toContain(announcement.id);

    const updated = await json(`/api/v1/admin/announcements/${announcement.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth(email, true)) },
      body: JSON.stringify({ text: "Moved", all_day: true }),
    });
    expect(updated.status).toBe(200);
    const edited = read(AdminAnnouncementSchema, updated.body);
    expect(edited.content).toBe("<p>Moved</p>");
    expect(edited.all_day).toBe(true);

    const unpublished = await json(`/api/v1/admin/announcements/${announcement.id}/unpublish`, {
      method: "POST",
      headers: await auth(email, true),
    });
    expect(unpublished.status).toBe(200);
    expect(read(AdminAnnouncementSchema, unpublished.body).published_at).toBeNull();
    expect(await publicIds("ann-reader@example.com")).not.toContain(announcement.id);

    const republished = await json(`/api/v1/admin/announcements/${announcement.id}/publish`, {
      method: "POST",
      headers: await auth(email, true),
    });
    expect(republished.status).toBe(200);
    expect(read(AdminAnnouncementSchema, republished.body).published_at).not.toBeNull();

    const removed = await json(`/api/v1/admin/announcements/${announcement.id}`, {
      method: "DELETE",
      headers: await auth(email, true),
    });
    expect(removed.status).toBe(200);
    const list = await json("/api/v1/admin/announcements", { headers: await auth(email, true) });
    expect(
      read(z.array(AdminAnnouncementSchema), list.body).map((entry) => entry.id),
    ).not.toContain(announcement.id);
  });

  it("keeps a future-scheduled announcement out of the public list", async () => {
    const email = "ann-scheduler@example.com";
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const created = await create(email, { text: "Later", scheduled_at: scheduledAt });
    expect(created.status).toBe(200);
    const announcement = read(AdminAnnouncementSchema, created.body);
    expect(announcement.published_at).toBe(scheduledAt);
    expect(await publicIds("ann-schedule-reader@example.com")).not.toContain(announcement.id);
  });

  it("dismisses a stored announcement per viewer", async () => {
    const email = "ann-dismisser@example.com";
    const created = await create("ann-dismiss-author@example.com", { text: "Dismiss me" });
    const announcement = read(AdminAnnouncementSchema, created.body);

    const dismissed = await json(`/api/v1/announcements/${announcement.id}/dismiss`, {
      method: "POST",
      headers: await auth(email),
    });
    expect(dismissed.status).toBe(200);

    const response = await json("/api/v1/announcements", { headers: await auth(email) });
    const mine = read(z.array(PublicAnnouncementSchema), response.body).find(
      (entry) => entry.id === announcement.id,
    );
    expect(mine?.read).toBe(true);
  });

  it("renders an announcement's text as Mastodon's linkify, with its mentions and tags", async () => {
    const local = await signedInAccount("ann-mentioned@example.com");
    const remote = await remoteActor("annremote", "ann-remote.example");
    const created = await create("ann-linker@example.com", {
      text: `Read https://example.org/docs <now> #Maintenance\n\nAsk @${local.username}, @annremote@ann-remote.example or @nobody`,
    });
    const id = read(AdminAnnouncementSchema, created.body).id;

    const response = await json("/api/v1/announcements", {
      headers: await auth("ann-link-reader@example.com"),
    });
    const announcement = expectContract(z.array(ApiAnnouncement), response.body).find(
      (entry) => entry.id === id,
    );

    const hCard = (url: string, name: string) =>
      `<span class="h-card" translate="no"><a href="${url}" class="u-url mention">@<span>${name}</span></a></span>`;
    expect(announcement?.content).toBe(
      '<p>Read <a href="https://example.org/docs" target="_blank" rel="nofollow noopener" translate="no"><span class="invisible">https://</span><span class="">example.org/docs</span><span class="invisible"></span></a> &lt;now&gt; ' +
        '<a href="https://example.com/tags/maintenance" class="mention hashtag" rel="tag">#<span>Maintenance</span></a></p>' +
        `<p>Ask ${hCard(`https://example.com/@${local.username}`, local.username)}, ${hCard(remote.actorUri, "annremote")} or @nobody</p>`,
    );
    expect(announcement?.mentions).toEqual([
      {
        id: local.id,
        username: local.username,
        url: `https://example.com/@${local.username}`,
        acct: local.username,
      },
      {
        id: RemoteAccountId.encode(remote.actorUri),
        username: "annremote",
        url: remote.actorUri,
        acct: "annremote@ann-remote.example",
      },
    ]);
    expect(announcement?.tags).toEqual([
      { name: "maintenance", url: "https://example.com/tags/maintenance" },
    ]);
  });

  it("validates the payload", async () => {
    expect((await create("ann-invalid@example.com", {})).status).toBe(422);
    expect(
      (await create("ann-invalid@example.com", { text: "x", starts_at: "not-a-date" })).status,
    ).toBe(422);
    expect(
      (await create("ann-invalid@example.com", { text: "x", scheduled_at: "not-a-date" })).status,
    ).toBe(422);
  });
});
