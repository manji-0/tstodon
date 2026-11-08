import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  accountOf,
  adminApi,
  adminBrowser,
  api,
  IdSchema,
  page,
  redirectsTo,
} from "../test/admin-browser";
import { authHeaders } from "../test/auth-fixture";
import { ORIGIN, postForm, read, signUp } from "../test/passkey-browser";
import { type Remote, remoteActor } from "../test/remote-actor-fixture";
import { LocalAccountModeration } from "@tstodon/domain";
import { saveLocalAccountModeration } from "./account-moderation-store";
import { RemoteAccountId } from "./remote-account-id";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

/** Every admin page this change adds, with the form post it takes. */
const NEW_PAGES = [
  "/admin/dashboard",
  "/admin/announcements",
  "/admin/custom_emojis",
  "/admin/trends/tags",
  "/admin/trends/links",
  "/admin/trends/statuses",
  "/admin/email_domain_blocks",
] as const;

const postStatus = async (email: string, status: string, extra: Record<string, unknown> = {}) =>
  read(
    IdSchema,
    await api("/api/v1/statuses", await authHeaders(email), {
      method: "POST",
      body: JSON.stringify({ status, visibility: "public", ...extra }),
    }),
  );

const StatusSchema = z.object({ id: z.string(), sensitive: z.boolean() });

/** A status as the public API shows it, or `undefined` once it is gone. */
const publicStatus = async (id: string) => {
  const response = await SELF.fetch(`${ORIGIN}/api/v1/statuses/${id}`);
  if (response.status === 404) {
    return undefined;
  }
  expect(response.status).toBe(200);
  return read(StatusSchema, await response.json());
};

const stat = (html: string, label: string): number => {
  const found = new RegExp(`${label}[\\s\\S]*?<strong>(\\d+)</strong>`).exec(html);
  if (!found?.[1]) {
    throw new Error(`no ${label} on the dashboard`);
  }
  return Number(found[1]);
};

const AnnouncementSchema = z.object({
  id: z.string(),
  content: z.string(),
  published_at: z.string().nullable(),
  starts_at: z.string().nullable(),
  all_day: z.boolean(),
});

const apiAnnouncements = async () =>
  read(z.array(AnnouncementSchema), await api("/api/v1/admin/announcements", await adminApi()));

const EmojiSchema = z.object({
  id: z.string(),
  shortcode: z.string(),
  visible_in_picker: z.boolean(),
  category: z.string().optional(),
});

const apiEmojis = async () =>
  read(z.array(EmojiSchema), await api("/api/v1/admin/custom_emojis", await adminApi()));

const AdminTagSchema = z.object({
  name: z.string(),
  trendable: z.boolean(),
  requires_review: z.boolean(),
});

const apiAdminTags = async () =>
  read(z.array(AdminTagSchema), await api("/api/v1/admin/trends/tags", await adminApi()));

/** The names, URLs, or ids the public trends list shows. */
const publicTrends = async (family: "tags" | "links" | "statuses"): Promise<string[]> => {
  const response = await SELF.fetch(`${ORIGIN}/api/v1/trends/${family}`);
  expect(response.status).toBe(200);
  const key = { tags: "name", links: "url", statuses: "id" }[family];
  return read(z.array(z.record(z.string(), z.unknown())), await response.json()).flatMap(
    (entry) => {
      const value = entry[key];
      return typeof value === "string" ? [value] : [];
    },
  );
};

const EmailBlockSchema = z.object({ id: z.string(), domain: z.string() });

const apiEmailBlocks = async () =>
  read(z.array(EmailBlockSchema), await api("/api/v1/admin/email_domain_blocks", await adminApi()));

const remoteNote = async (author: Remote, slug: string): Promise<string> => {
  const noteUri = `${new URL(author.actorUri).origin}/notes/${slug}`;
  expect(
    await author.send({
      id: `${noteUri}/activity`,
      type: "Create",
      object: {
        id: noteUri,
        type: "Note",
        attributedTo: author.actorUri,
        content: `<p>${slug}</p>`,
        published: "2026-10-20T00:00:00.000Z",
        to: [PUBLIC],
        cc: [`${author.actorUri}/followers`],
      },
    }),
  ).toBe(202);
  return noteUri;
};

const RemoteEntrySchema = z.object({ id: z.string(), uri: z.string(), sensitive: z.boolean() });

const remoteEntries = async (remote: Remote) => {
  const response = await SELF.fetch(
    `${ORIGIN}/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/statuses`,
  );
  expect(response.status).toBe(200);
  return read(z.array(RemoteEntrySchema), await response.json());
};

const checkedIds = (html: string): string[] =>
  [...html.matchAll(/name="status_ids" value="([^"]+)"/g)].map((found) => found[1] ?? "");

describe("admin content pages", () => {
  it("sends a signed-out browser to sign in, back to the page it asked for", async () => {
    for (const path of ["/admin", "/admin/trends", "/admin/accounts/1/statuses", ...NEW_PAGES]) {
      const response = await SELF.fetch(`${ORIGIN}${path}`, { redirect: "manual" });
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location"), path).toBe(
        path === "/admin/trends"
          ? "/admin/trends/tags"
          : `/auth/sign_in?return_to=${encodeURIComponent(path)}`,
      );
    }
  });

  it("refuses a signed-in user who is not an admin, on pages and on form posts", async () => {
    const { fetcher } = await signUp("content_not_admin");
    const author = await accountOf("content-na-author@example.com");
    const status = await postStatus("content-na-author@example.com", "na post");
    const announcementsBefore = (await apiAnnouncements()).length;
    for (const path of [...NEW_PAGES, `/admin/accounts/${author.id}/statuses`]) {
      expect(await page(await fetcher(path), 403), path).toContain("administrators");
    }
    for (const [path, fields] of [
      [
        `/admin/accounts/${author.id}/statuses`,
        { do: "delete", status_ids: status.id, confirmed: "1" },
      ],
      ["/admin/announcements", { text: "na", publish: "1" }],
      ["/admin/custom_emojis", { do: "delete", id: "x", confirmed: "1" }],
      ["/admin/trends/tags", { do: "reject", target: "nope" }],
      ["/admin/email_domain_blocks", { do: "add", domain: "na.example" }],
    ] as const) {
      expect((await postForm(fetcher, path, fields)).status, path).toBe(403);
    }
    expect(await publicStatus(status.id)).toBeDefined();
    expect((await apiAnnouncements()).length).toBe(announcementsBefore);
    expect((await apiEmailBlocks()).map((block) => block.domain)).not.toContain("na.example");
  });

  it("refuses a cross-site form post on each new page", async () => {
    const admin = await adminBrowser("content_cross_site_admin");
    const crossSite = (path: string, body: string) =>
      admin.fetcher(path, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "cross-site",
        },
        body,
      });
    const author = await accountOf("content-cs-author@example.com");
    const status = await postStatus("content-cs-author@example.com", "cs post");
    const before = (await apiAnnouncements()).length;
    expect(
      (
        await crossSite(
          `/admin/accounts/${author.id}/statuses`,
          `do=delete&confirmed=1&status_ids=${status.id}`,
        )
      ).status,
    ).toBe(403);
    expect((await crossSite("/admin/announcements", "text=cs&publish=1")).status).toBe(403);
    expect((await crossSite("/admin/custom_emojis", "do=delete&id=x&confirmed=1")).status).toBe(
      403,
    );
    expect((await crossSite("/admin/trends/tags", "do=reject&target=cs")).status).toBe(403);
    expect((await crossSite("/admin/email_domain_blocks", "do=add&domain=cs.example")).status).toBe(
      403,
    );
    expect(await publicStatus(status.id)).toBeDefined();
    expect((await apiAnnouncements()).length).toBe(before);
    expect((await apiEmailBlocks()).map((block) => block.domain)).not.toContain("cs.example");
  });

  it("shows the dashboard at /admin and /admin/dashboard with counts that follow the data", async () => {
    const admin = await adminBrowser("content_dash_admin");
    const first = await page(await admin.fetcher("/admin/dashboard"));
    expect(await page(await admin.fetcher("/admin"))).toContain("<h1>Dashboard</h1>");
    for (const link of NEW_PAGES.filter(
      (path) => path !== "/admin/trends/links" && path !== "/admin/trends/statuses",
    )) {
      expect(first, link).toContain(`href="${link}"`);
    }
    const before = {
      reports: stat(first, "Open reports"),
      pending: stat(first, "waiting for approval"),
      signUps: stat(first, "New sign-ups"),
      active: stat(first, "Active users"),
    };

    const target = await accountOf("content-dash-target@example.com");
    await postStatus("content-dash-target@example.com", "dash post");
    await api("/api/v1/reports", await authHeaders("content-dash-reporter@example.com"), {
      method: "POST",
      body: JSON.stringify({ account_id: target.id, category: "spam" }),
    });
    const marked = await saveLocalAccountModeration(
      env.DB,
      target.id,
      LocalAccountModeration.awaitingApproval,
    );
    expect(marked.isOk()).toBe(true);
    const { fetcher } = await signUp("content_dash_new");
    await page(await fetcher("/settings/preferences"));

    const after = await page(await admin.fetcher("/admin/dashboard"));
    expect(stat(after, "Open reports")).toBe(before.reports + 1);
    expect(stat(after, "waiting for approval")).toBe(before.pending + 1);
    expect(stat(after, "New sign-ups")).toBeGreaterThanOrEqual(before.signUps + 1);
    expect(stat(after, "Active users")).toBeGreaterThanOrEqual(before.active + 2);
    const openReports = read(
      z.array(IdSchema),
      await api("/api/v1/admin/reports?resolved=false", await adminApi()),
    );
    expect(stat(after, "Open reports")).toBe(openReports.length);
  });

  it("lists a local account's posts and marks them sensitive, not sensitive, and deletes them", async () => {
    const admin = await adminBrowser("content_posts_admin");
    const author = await accountOf("content-posts-author@example.com");
    const keep = await postStatus("content-posts-author@example.com", "post to keep");
    const flag = await postStatus("content-posts-author@example.com", "post to flag");
    const drop = await postStatus("content-posts-author@example.com", "post to drop");
    const strangerPost = await postStatus("content-posts-stranger@example.com", "not theirs");
    const path = `/admin/accounts/${author.id}/statuses`;

    const list = await page(await admin.fetcher(path));
    expect(checkedIds(list)).toEqual([drop.id, flag.id, keep.id]);
    expect(list).toContain("post to flag");
    expect(list).toContain(`href="${`/admin/accounts/${author.id}`}"`);
    expect(await page(await admin.fetcher(`/admin/accounts/${author.id}`))).toContain(
      `href="${path}"`,
    );

    redirectsTo(
      await postForm(admin.fetcher, path, { do: "sensitize", status_ids: flag.id }),
      `${path}?notice=posts_marked_sensitive`,
    );
    expect(await publicStatus(flag.id)).toMatchObject({ sensitive: true });
    expect(await publicStatus(keep.id)).toMatchObject({ sensitive: false });
    expect(await page(await admin.fetcher(path))).toContain("sensitive");
    redirectsTo(
      await postForm(admin.fetcher, path, { do: "unsensitize", status_ids: flag.id }),
      `${path}?notice=posts_marked_not_sensitive`,
    );
    expect(await publicStatus(flag.id)).toMatchObject({ sensitive: false });

    const confirm = await page(
      await postForm(admin.fetcher, path, { do: "delete", status_ids: drop.id }),
    );
    expect(confirm).toContain("Delete 1 post?");
    expect(await publicStatus(drop.id)).toBeDefined();
    redirectsTo(
      await postForm(admin.fetcher, path, {
        do: "delete",
        selected: `${drop.id},${strangerPost.id}`,
        confirmed: "1",
      }),
      `${path}?notice=posts_deleted`,
    );
    expect(await publicStatus(drop.id)).toBeUndefined();
    expect(await publicStatus(strangerPost.id)).toBeDefined();
    expect(checkedIds(await page(await admin.fetcher(path)))).toEqual([flag.id, keep.id]);

    expect(await page(await postForm(admin.fetcher, path, { do: "delete" }), 422)).toContain(
      "Select at least one post.",
    );
    expect(await page(await admin.fetcher("/admin/accounts/999999999/statuses"), 404)).toContain(
      "no such account",
    );
  });

  it("does not let an admin moderate their own posts", async () => {
    const admin = await adminBrowser("content_posts_self_admin");
    const path = `/admin/accounts/${admin.id}/statuses`;
    expect(
      await page(await postForm(admin.fetcher, path, { do: "sensitize", status_ids: "1" }), 422),
    ).toContain("You cannot moderate your own account.");
  });

  it("lists a remote account's posts and marks them sensitive and deletes them", async () => {
    const admin = await adminBrowser("content_remote_posts_admin");
    const actor = await remoteActor("content-remote-poster", "poster.example");
    const keepUri = await remoteNote(actor, "content-remote-keep");
    const dropUri = await remoteNote(actor, "content-remote-drop");
    const entries = await remoteEntries(actor);
    const keep = entries.find((entry) => entry.uri === keepUri);
    const drop = entries.find((entry) => entry.uri === dropUri);
    if (!keep || !drop) {
      throw new Error("remote notes not stored");
    }
    const path = `/admin/accounts/${RemoteAccountId.encode(actor.actorUri)}/statuses`;

    const list = await page(await admin.fetcher(path));
    expect(checkedIds(list)).toEqual([drop.id, keep.id]);
    expect(list).toContain("content-remote-drop");
    expect(
      await page(await admin.fetcher(`/admin/accounts/${RemoteAccountId.encode(actor.actorUri)}`)),
    ).toContain(`href="${path}"`);

    redirectsTo(
      await postForm(admin.fetcher, path, { do: "sensitize", status_ids: keep.id }),
      `${path}?notice=posts_marked_sensitive`,
    );
    expect((await remoteEntries(actor)).find((entry) => entry.id === keep.id)?.sensitive).toBe(
      true,
    );
    expect((await remoteEntries(actor)).find((entry) => entry.id === drop.id)?.sensitive).toBe(
      false,
    );
    redirectsTo(
      await postForm(admin.fetcher, path, { do: "unsensitize", status_ids: keep.id }),
      `${path}?notice=posts_marked_not_sensitive`,
    );
    expect((await remoteEntries(actor)).find((entry) => entry.id === keep.id)?.sensitive).toBe(
      false,
    );

    expect(
      await page(await postForm(admin.fetcher, path, { do: "delete", status_ids: drop.id })),
    ).toContain("Delete 1 post?");
    expect((await remoteEntries(actor)).map((entry) => entry.id)).toContain(drop.id);
    redirectsTo(
      await postForm(admin.fetcher, path, { do: "delete", status_ids: drop.id, confirmed: "1" }),
      `${path}?notice=posts_deleted`,
    );
    expect((await remoteEntries(actor)).map((entry) => entry.id)).toEqual([keep.id]);

    const unknown = RemoteAccountId.encode("https://poster.example/users/nobody");
    expect(await page(await admin.fetcher(`/admin/accounts/${unknown}/statuses`), 404)).toContain(
      "no such account",
    );
  });

  it("creates, edits, publishes, unpublishes, and deletes an announcement the admin API reports", async () => {
    const admin = await adminBrowser("content_announce_admin");
    const before = (await apiAnnouncements()).length;

    redirectsTo(
      await postForm(admin.fetcher, "/admin/announcements", {
        text: "Maintenance <soon>",
        starts_at: "2026-12-01T09:30",
        all_day: "1",
        publish: "1",
      }),
      "/admin/announcements?notice=announcement_created",
    );
    redirectsTo(
      await postForm(admin.fetcher, "/admin/announcements", { text: "A draft" }),
      "/admin/announcements?notice=announcement_created",
    );
    const created = await apiAnnouncements();
    expect(created.length).toBe(before + 2);
    const live = created.find((entry) => entry.content.includes("Maintenance"));
    const draft = created.find((entry) => entry.content.includes("A draft"));
    if (!live || !draft) {
      throw new Error("announcements not stored");
    }
    expect(live).toMatchObject({
      content: "<p>Maintenance &lt;soon&gt;</p>",
      starts_at: "2026-12-01T09:30:00.000Z",
      all_day: true,
    });
    expect(live.published_at).not.toBeNull();
    expect(draft.published_at).toBeNull();

    const list = await page(await admin.fetcher("/admin/announcements"));
    expect(list).toContain(`href="/admin/announcements/${live.id}"`);
    expect(list).toContain("draft");

    const edit = await page(await admin.fetcher(`/admin/announcements/${live.id}`));
    expect(edit).toContain("Maintenance &lt;soon&gt;");
    expect(edit).toContain('value="2026-12-01T09:30"');
    const path = `/admin/announcements/${live.id}`;
    redirectsTo(
      await postForm(admin.fetcher, path, { do: "save", text: "Rescheduled", all_day: "" }),
      `${path}?notice=announcement_saved`,
    );
    expect((await apiAnnouncements()).find((entry) => entry.id === live.id)).toMatchObject({
      content: "<p>Rescheduled</p>",
      starts_at: null,
      all_day: false,
    });

    redirectsTo(
      await postForm(admin.fetcher, path, { do: "unpublish" }),
      `${path}?notice=announcement_unpublished`,
    );
    expect(
      (await apiAnnouncements()).find((entry) => entry.id === live.id)?.published_at,
    ).toBeNull();
    redirectsTo(
      await postForm(admin.fetcher, `/admin/announcements/${draft.id}`, { do: "publish" }),
      `/admin/announcements/${draft.id}?notice=announcement_published`,
    );
    expect(
      (await apiAnnouncements()).find((entry) => entry.id === draft.id)?.published_at,
    ).not.toBeNull();

    expect(await page(await postForm(admin.fetcher, path, { do: "delete" }))).toContain(
      "Delete this announcement?",
    );
    expect((await apiAnnouncements()).map((entry) => entry.id)).toContain(live.id);
    redirectsTo(
      await postForm(admin.fetcher, path, { do: "delete", confirmed: "1" }),
      "/admin/announcements?notice=announcement_deleted",
    );
    expect((await apiAnnouncements()).map((entry) => entry.id)).not.toContain(live.id);

    expect(
      await page(
        await postForm(admin.fetcher, "/admin/announcements", { text: "  ", publish: "1" }),
        422,
      ),
    ).toContain("Enter the announcement's text.");
    expect(
      await page(
        await postForm(admin.fetcher, "/admin/announcements", { text: "x", starts_at: "soon" }),
        422,
      ),
    ).toContain("Enter the times as dates and times.");
    expect(await page(await admin.fetcher("/admin/announcements/missing"), 404)).toContain(
      "no such announcement",
    );
  });

  it("uploads, hides, shows, and deletes a custom emoji the admin API reports", async () => {
    const admin = await adminBrowser("content_emoji_admin");
    const upload = (fields: Record<string, string>, image?: File) => {
      const form = new FormData();
      for (const [name, value] of Object.entries(fields)) {
        form.set(name, value);
      }
      if (image) {
        form.set("image", image);
      }
      return admin.fetcher("/admin/custom_emojis", { method: "POST", body: form });
    };
    const png = new File([new Uint8Array([137, 80, 78, 71])], "blob.png", { type: "image/png" });

    redirectsTo(
      await upload(
        { do: "upload", shortcode: "pagesblob", category: "Pages", visible_in_picker: "1" },
        png,
      ),
      "/admin/custom_emojis?notice=emoji_uploaded",
    );
    const uploaded = (await apiEmojis()).find((emoji) => emoji.shortcode === "pagesblob");
    if (!uploaded) {
      throw new Error("emoji not stored");
    }
    expect(uploaded).toMatchObject({ visible_in_picker: true, category: "Pages" });
    expect(await env.MEDIA.head(`emoji/${uploaded.id}`)).not.toBeNull();
    const list = await page(await admin.fetcher("/admin/custom_emojis"));
    expect(list).toContain(":pagesblob:");
    expect(list).toContain("shown in the picker");

    redirectsTo(
      await postForm(admin.fetcher, "/admin/custom_emojis", { do: "hide", id: uploaded.id }),
      "/admin/custom_emojis?notice=emoji_hidden",
    );
    expect((await apiEmojis()).find((emoji) => emoji.id === uploaded.id)).toMatchObject({
      visible_in_picker: false,
      category: "Pages",
    });
    redirectsTo(
      await postForm(admin.fetcher, "/admin/custom_emojis", { do: "show", id: uploaded.id }),
      "/admin/custom_emojis?notice=emoji_shown",
    );
    expect((await apiEmojis()).find((emoji) => emoji.id === uploaded.id)?.visible_in_picker).toBe(
      true,
    );

    expect(
      await page(
        await postForm(admin.fetcher, "/admin/custom_emojis", { do: "delete", id: uploaded.id }),
      ),
    ).toContain("Delete this emoji?");
    expect(await env.MEDIA.head(`emoji/${uploaded.id}`)).not.toBeNull();
    redirectsTo(
      await postForm(admin.fetcher, "/admin/custom_emojis", {
        do: "delete",
        id: uploaded.id,
        confirmed: "1",
      }),
      "/admin/custom_emojis?notice=emoji_deleted",
    );
    expect((await apiEmojis()).map((emoji) => emoji.id)).not.toContain(uploaded.id);
    expect(await env.MEDIA.head(`emoji/${uploaded.id}`)).toBeNull();
  });

  it("refuses an emoji upload with a bad shortcode, no image, or a taken shortcode", async () => {
    const admin = await adminBrowser("content_emoji_errors_admin");
    const upload = (fields: Record<string, string>, withImage: boolean) => {
      const form = new FormData();
      for (const [name, value] of Object.entries(fields)) {
        form.set(name, value);
      }
      if (withImage) {
        form.set("image", new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" }));
      }
      return admin.fetcher("/admin/custom_emojis", { method: "POST", body: form });
    };
    const before = (await apiEmojis()).length;
    expect(
      await page(await upload({ do: "upload", shortcode: "bad shortcode!" }, true), 422),
    ).toContain("shortcode is invalid");
    expect(await page(await upload({ do: "upload", shortcode: "noimage" }, false), 422)).toContain(
      "image is required",
    );
    redirectsTo(
      await upload({ do: "upload", shortcode: "pagestaken" }, true),
      "/admin/custom_emojis?notice=emoji_uploaded",
    );
    const taken = await page(await upload({ do: "upload", shortcode: "pagestaken" }, true), 422);
    expect(taken).toContain("shortcode has already been taken");
    expect(taken).toContain('value="pagestaken"');
    expect((await apiEmojis()).length).toBe(before + 1);
  });

  it("approves and rejects a trending tag the admin API and the public trends then follow", async () => {
    const admin = await adminBrowser("content_trend_tag_admin");
    await postStatus("content-trend-author@example.com", "trend #pagestrendtag");
    await postStatus("content-trend-author2@example.com", "again #pagestrendtag");
    const list = await page(await admin.fetcher("/admin/trends/tags"));
    expect(list).toContain("#pagestrendtag");
    expect(list).toContain("waiting for review");
    expect(await publicTrends("tags")).toContain("pagestrendtag");

    redirectsTo(
      await postForm(admin.fetcher, "/admin/trends/tags", {
        do: "reject",
        target: "pagestrendtag",
      }),
      "/admin/trends/tags?notice=trend_rejected",
    );
    expect((await apiAdminTags()).find((tag) => tag.name === "pagestrendtag")).toMatchObject({
      trendable: false,
      requires_review: false,
    });
    expect(await publicTrends("tags")).not.toContain("pagestrendtag");
    expect(await page(await admin.fetcher("/admin/trends/tags"))).toContain("rejected");

    redirectsTo(
      await postForm(admin.fetcher, "/admin/trends/tags", {
        do: "approve",
        target: "pagestrendtag",
      }),
      "/admin/trends/tags?notice=trend_approved",
    );
    expect((await apiAdminTags()).find((tag) => tag.name === "pagestrendtag")).toMatchObject({
      trendable: true,
      requires_review: false,
    });
    expect(await publicTrends("tags")).toContain("pagestrendtag");
  });

  it("rejects a trending link and a trending post out of the public trends, and approves them back", async () => {
    const admin = await adminBrowser("content_trend_more_admin");
    const url = "https://pages-trend.example/article";
    const post = await postStatus("content-trend-link@example.com", `worth a read ${url}`);

    const links = await page(await admin.fetcher("/admin/trends/links"));
    expect(links).toContain(url);
    expect(await publicTrends("links")).toContain(url);
    redirectsTo(
      await postForm(admin.fetcher, "/admin/trends/links", { do: "reject", target: url }),
      "/admin/trends/links?notice=trend_rejected",
    );
    expect(await publicTrends("links")).not.toContain(url);
    expect(await page(await admin.fetcher("/admin/trends/links"))).toContain("rejected");
    redirectsTo(
      await postForm(admin.fetcher, "/admin/trends/links", { do: "approve", target: url }),
      "/admin/trends/links?notice=trend_approved",
    );
    expect(await publicTrends("links")).toContain(url);

    const statuses = await page(await admin.fetcher("/admin/trends/statuses"));
    expect(statuses).toContain(`value="${post.id}"`);
    expect(await publicTrends("statuses")).toContain(post.id);
    redirectsTo(
      await postForm(admin.fetcher, "/admin/trends/statuses", { do: "reject", target: post.id }),
      "/admin/trends/statuses?notice=trend_rejected",
    );
    expect(await publicTrends("statuses")).not.toContain(post.id);
    expect(await page(await admin.fetcher("/admin/trends/statuses"))).toContain(
      `value="${post.id}"`,
    );
    redirectsTo(
      await postForm(admin.fetcher, "/admin/trends/statuses", { do: "approve", target: post.id }),
      "/admin/trends/statuses?notice=trend_approved",
    );
    expect(await publicTrends("statuses")).toContain(post.id);
  });

  it("answers 404 for a trend that does not exist", async () => {
    const admin = await adminBrowser("content_trend_missing_admin");
    for (const [path, target] of [
      ["/admin/trends/links", "not a url"],
      ["/admin/trends/statuses", "999999999"],
    ] as const) {
      expect(
        await page(await postForm(admin.fetcher, path, { do: "approve", target }), 404),
        path,
      ).toContain("no such trend");
    }
  });

  it("adds and removes an email domain block the admin API reports", async () => {
    const admin = await adminBrowser("content_email_admin");
    redirectsTo(
      await postForm(admin.fetcher, "/admin/email_domain_blocks", {
        do: "add",
        domain: "  Spam-Mail.EXAMPLE ",
      }),
      "/admin/email_domain_blocks?notice=email_block_added",
    );
    const block = (await apiEmailBlocks()).find((entry) => entry.domain === "spam-mail.example");
    if (!block) {
      throw new Error("block not stored");
    }
    const list = await page(await admin.fetcher("/admin/email_domain_blocks"));
    expect(list).toContain("spam-mail.example");
    expect(list).toContain("0 accounts created in the last 5 days");

    expect(
      await page(
        await postForm(admin.fetcher, "/admin/email_domain_blocks", {
          do: "add",
          domain: "spam-mail.example",
        }),
        422,
      ),
    ).toContain("already blocked");
    expect(
      await page(
        await postForm(admin.fetcher, "/admin/email_domain_blocks", { do: "add", domain: " " }),
        422,
      ),
    ).toContain("Enter a domain.");

    redirectsTo(
      await postForm(admin.fetcher, "/admin/email_domain_blocks", { do: "remove", id: block.id }),
      "/admin/email_domain_blocks?notice=email_block_removed",
    );
    expect((await apiEmailBlocks()).map((entry) => entry.domain)).not.toContain(
      "spam-mail.example",
    );
    expect(
      await page(
        await postForm(admin.fetcher, "/admin/email_domain_blocks", { do: "remove", id: block.id }),
        404,
      ),
    ).toContain("no such email domain block");
  });

  it("links every page from one navigation, and keeps the notice for admin paths not built", async () => {
    const admin = await adminBrowser("content_nav_admin");
    for (const path of ["/admin/reports", ...NEW_PAGES]) {
      const html = await page(await admin.fetcher(path));
      for (const href of [
        "/admin/dashboard",
        "/admin/reports",
        "/admin/accounts",
        "/admin/instances",
        "/admin/announcements",
        "/admin/custom_emojis",
        "/admin/trends/tags",
        "/admin/email_domain_blocks",
      ]) {
        expect(html, `${path} links ${href}`).toContain(`href="${href}"`);
      }
    }
    const unbuilt = await page(await admin.fetcher("/admin/software_updates"));
    expect(unbuilt).toContain("Administration");
    expect(unbuilt).toContain('href="/admin/dashboard"');
  });
});
