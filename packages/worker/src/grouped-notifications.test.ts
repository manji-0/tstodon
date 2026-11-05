import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { MastodonAccountPreviewSchema } from "../test/mastodon-preview-schemas";

const auth = (email: string): Promise<Record<string, string>> => authHeaders(email);

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

const EnvelopeSchema = z.object({
  accounts: z.array(MastodonAccountPreviewSchema),
  statuses: z.array(z.object({ id: z.string().min(1) })),
  notification_groups: z.array(
    z.object({
      group_key: z.string().min(1),
      notifications_count: z.number(),
      type: z.string().min(1),
      most_recent_notification_id: z.string().min(1),
      sample_account_ids: z.array(z.string().min(1)),
      status_id: z.string().min(1).optional(),
      page_min_id: z.string().optional(),
      page_max_id: z.string().optional(),
      latest_page_notification_at: z.string().optional(),
    }),
  ),
});

const credentials = async (email: string): Promise<{ id: string; username: string }> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  const account = read(MastodonAccountPreviewSchema, response.body);
  return { id: account.id, username: account.username };
};

const postStatus = async (email: string, body: Record<string, unknown>): Promise<string> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return read(z.object({ id: z.string().min(1) }), response.body).id;
};

const favourite = async (email: string, statusId: string): Promise<void> => {
  const response = await json(`/api/v1/statuses/${statusId}/favourite`, {
    method: "POST",
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
};

describe("grouped notifications", () => {
  it("folds favourites of one status into a single group", async () => {
    const authorEmail = "group-author@example.com";
    const statusId = await postStatus(authorEmail, { status: "group me" });
    const fans = ["group-fan-a@example.com", "group-fan-b@example.com", "group-fan-c@example.com"];
    for (const fan of fans) {
      await favourite(fan, statusId);
    }

    const response = await json("/api/v2/notifications", { headers: await auth(authorEmail) });
    expect(response.status).toBe(200);
    const envelope = read(EnvelopeSchema, response.body);
    const group = envelope.notification_groups.find((entry) => entry.status_id === statusId);
    expect(group).toBeDefined();
    expect(group?.type).toBe("favourite");
    expect(group?.notifications_count).toBe(3);
    expect(group?.sample_account_ids).toHaveLength(3);
    expect(group?.page_min_id).toBeDefined();
    expect(group?.latest_page_notification_at).toBeDefined();
    // The referenced accounts and status travel in the envelope.
    expect(envelope.accounts.map((account) => account.id)).toEqual(
      expect.arrayContaining(group?.sample_account_ids ?? []),
    );
    expect(envelope.statuses.map((status) => status.id)).toContain(statusId);

    // The single-group endpoint returns the same group without page ids.
    const single = await json(`/api/v2/notifications/${group?.group_key ?? ""}`, {
      headers: await auth(authorEmail),
    });
    expect(single.status).toBe(200);
    const one = read(EnvelopeSchema, single.body);
    expect(one.notification_groups).toHaveLength(1);
    expect(one.notification_groups[0]?.page_min_id).toBeUndefined();

    const accounts = await json(`/api/v2/notifications/${group?.group_key ?? ""}/accounts`, {
      headers: await auth(authorEmail),
    });
    expect(accounts.status).toBe(200);
    expect(read(z.array(MastodonAccountPreviewSchema), accounts.body)).toHaveLength(3);

    // Dismissing the group empties the list, and unread_count drops with it.
    const unread = await json("/api/v2/notifications/unread_count", {
      headers: await auth(authorEmail),
    });
    expect(read(z.object({ count: z.number() }), unread.body).count).toBe(1);

    const dismissed = await json(`/api/v2/notifications/${group?.group_key ?? ""}/dismiss`, {
      method: "POST",
      headers: await auth(authorEmail),
    });
    expect(dismissed.status).toBe(200);
    const after = await json("/api/v2/notifications", { headers: await auth(authorEmail) });
    expect(read(EnvelopeSchema, after.body).notification_groups).toHaveLength(0);
  });

  it("keeps ungrouped types in their own groups", async () => {
    const authorEmail = "group-mention-author@example.com";
    const author = await credentials(authorEmail);
    const mentioner = "group-mentioner@example.com";
    await credentials(mentioner);
    await postStatus(mentioner, { status: `@${author.username} hi` });

    const grouped = await json("/api/v2/notifications", { headers: await auth(authorEmail) });
    const envelope = read(EnvelopeSchema, grouped.body);
    const mention = envelope.notification_groups.find((entry) => entry.type === "mention");
    expect(mention).toBeDefined();
    expect(mention?.notifications_count).toBe(1);
    expect(mention?.group_key.startsWith("ungrouped-")).toBe(true);
    expect(mention?.status_id).toBeDefined();
  });

  it("paginates by group and requires auth", async () => {
    const authorEmail = "group-page-author@example.com";
    const first = await postStatus(authorEmail, { status: "page one" });
    const second = await postStatus(authorEmail, { status: "page two" });
    await favourite("group-page-fan-a@example.com", first);
    await favourite("group-page-fan-b@example.com", second);

    const page = await json("/api/v2/notifications?limit=1", { headers: await auth(authorEmail) });
    expect(read(EnvelopeSchema, page.body).notification_groups).toHaveLength(1);

    expect((await json("/api/v2/notifications")).status).toBe(401);
  });

  it("links the next and previous pages from the page bounds", async () => {
    const authorEmail = "group-link-author@example.com";
    const older = await postStatus(authorEmail, { status: "link older" });
    const newer = await postStatus(authorEmail, { status: "link newer" });
    await favourite("group-link-fan-a@example.com", older);
    await favourite("group-link-fan-b@example.com", newer);

    const response = await SELF.fetch(
      "https://example.com/api/v2/notifications?limit=1&types[]=favourite",
      { headers: await auth(authorEmail) },
    );
    const [group] = read(EnvelopeSchema, await response.json()).notification_groups;
    expect(group?.status_id).toBe(newer);
    const links = parseLinks(response.headers.get("link"));
    expect(links.next?.searchParams.get("max_id")).toBe(group?.page_min_id);
    expect(links.prev?.searchParams.get("min_id")).toBe(group?.page_max_id);
    expect(links.next?.searchParams.get("limit")).toBe("1");
    expect(links.next?.searchParams.getAll("types[]")).toEqual(["favourite"]);

    const next = await json(`${links.next?.pathname ?? ""}${links.next?.search ?? ""}`, {
      headers: await auth(authorEmail),
    });
    expect(read(EnvelopeSchema, next.body).notification_groups.map((g) => g.status_id)).toEqual([
      older,
    ]);
  });

  it("does not page past groups left off a full page", async () => {
    const authorEmail = "group-link-full-author@example.com";
    const [a, b, c] = [
      await postStatus(authorEmail, { status: "full a" }),
      await postStatus(authorEmail, { status: "full b" }),
      await postStatus(authorEmail, { status: "full c" }),
    ];
    // Newest first: a, b, c, b. With limit=2 the page holds a and b; c sits
    // between b's two notifications and must still be reachable.
    await favourite("group-link-full-fan-a@example.com", b);
    await favourite("group-link-full-fan-a@example.com", c);
    await favourite("group-link-full-fan-b@example.com", b);
    await favourite("group-link-full-fan-a@example.com", a);

    const seen: Array<string | undefined> = [];
    let path: string | undefined = "/api/v2/notifications?limit=2";
    for (let pages = 0; path && pages < 5; pages += 1) {
      const response: Response = await SELF.fetch(`https://example.com${path}`, {
        headers: await auth(authorEmail),
      });
      const body = schemaResult(EnvelopeSchema)(await response.json());
      seen.push(...(body.isOk() ? body.value.notification_groups.map((g) => g.status_id) : []));
      const next = parseLinks(response.headers.get("link")).next;
      path = next ? `${next.pathname}${next.search}` : undefined;
    }
    expect(seen).toContain(c);
  });

  it("counts a group's notifications older than the page's last group", async () => {
    const authorEmail = "group-count-author@example.com";
    const [a, b] = [
      await postStatus(authorEmail, { status: "count a" }),
      await postStatus(authorEmail, { status: "count b" }),
    ];
    // Newest first: a, b, a. Mastodon counts both of a's on a limit=2 page.
    await favourite("group-count-fan-a@example.com", a);
    await favourite("group-count-fan-a@example.com", b);
    await favourite("group-count-fan-b@example.com", a);

    const page = await json("/api/v2/notifications?limit=2", { headers: await auth(authorEmail) });
    const groups = read(EnvelopeSchema, page.body).notification_groups;
    expect(groups.map((group) => [group.status_id, group.notifications_count])).toEqual([
      [a, 2],
      [b, 1],
    ]);
    expect(groups[0]?.sample_account_ids).toHaveLength(2);
  });

  it("returns a min_id page newest first with each group's newest notification", async () => {
    const authorEmail = "group-min-author@example.com";
    const [marker, p, r] = [
      await postStatus(authorEmail, { status: "min marker" }),
      await postStatus(authorEmail, { status: "min p" }),
      await postStatus(authorEmail, { status: "min r" }),
    ];
    await favourite("group-min-fan-a@example.com", marker);
    const before = await json("/api/v2/notifications", { headers: await auth(authorEmail) });
    const minId = read(EnvelopeSchema, before.body).notification_groups[0]?.page_max_id ?? "";
    await favourite("group-min-fan-a@example.com", p);
    await favourite("group-min-fan-b@example.com", r);
    await favourite("group-min-fan-b@example.com", p);

    const v1 = await json("/api/v1/notifications", { headers: await auth(authorEmail) });
    const newestP = read(z.array(z.object({ id: z.string() })), v1.body)[0]?.id;

    const page = await json(`/api/v2/notifications?min_id=${minId}`, {
      headers: await auth(authorEmail),
    });
    const groups = read(EnvelopeSchema, page.body).notification_groups;
    // As Mastodon's `to_a_grouped_paginated_by_id`: groups ordered by their
    // first notification after min_id, newest first.
    expect(groups.map((group) => group.status_id)).toEqual([r, p]);
    expect(groups[1]).toMatchObject({
      most_recent_notification_id: newestP,
      page_max_id: newestP,
      notifications_count: 2,
    });
  });

  it("acts on the whole group by key, past the request's page of groups", async () => {
    const authorEmail = "group-key-author@example.com";
    const p = await postStatus(authorEmail, { status: "key p" });
    await favourite("group-key-old@example.com", p);
    const fan = "group-key-other@example.com";
    for (let index = 0; index < 41; index += 1) {
      await favourite(fan, await postStatus(authorEmail, { status: `key other ${index}` }));
    }
    await favourite("group-key-new@example.com", p);
    const groupKey = `favourite-${p}`;

    const single = await json(`/api/v2/notifications/${groupKey}`, {
      headers: await auth(authorEmail),
    });
    expect(read(EnvelopeSchema, single.body).notification_groups[0]?.notifications_count).toBe(2);
    const accounts = await json(`/api/v2/notifications/${groupKey}/accounts`, {
      headers: await auth(authorEmail),
    });
    expect(read(z.array(MastodonAccountPreviewSchema), accounts.body)).toHaveLength(2);

    const dismissed = await json(`/api/v2/notifications/${groupKey}/dismiss`, {
      method: "POST",
      headers: await auth(authorEmail),
    });
    expect(dismissed.status).toBe(200);
    const after = await json("/api/v2/notifications?limit=80", {
      headers: await auth(authorEmail),
    });
    const groups = read(EnvelopeSchema, after.body).notification_groups;
    expect(groups).toHaveLength(41);
    expect(groups.map((group) => group.status_id)).not.toContain(p);
    const gone = await json(`/api/v2/notifications/${groupKey}`, {
      headers: await auth(authorEmail),
    });
    expect(gone.status).toBe(404);
  }, 90_000);
});

const parseLinks = (header: string | null): { next?: URL; prev?: URL } =>
  Object.fromEntries(
    (header ?? "").split(",").flatMap((part) => {
      const match = /<([^>]+)>;\s*rel="(next|prev)"/.exec(part.trim());
      return match?.[1] && match[2] ? [[match[2], new URL(match[1])]] : [];
    }),
  );

const notificationIds = async (email: string, query: string): Promise<string[]> => {
  const response = await json(`/api/v1/notifications?limit=80${query}`, {
    headers: await auth(email),
  });
  return read(z.array(z.object({ id: z.string() })), response.body).map((entry) => entry.id);
};

const favouriteFrom = async (prefix: string, count: number, statusId: string): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    await favourite(`${prefix}-${index}@example.com`, statusId);
  }
};

describe("a notification group by key", () => {
  it("shows a large group from its sample accounts and pages its senders", async () => {
    const authorEmail = "group-large-author@example.com";
    const p = await postStatus(authorEmail, { status: "large p" });
    await favouriteFrom("group-large-fan", 45, p);
    const groupKey = `favourite-${p}`;

    const single = read(
      EnvelopeSchema,
      (await json(`/api/v2/notifications/${groupKey}`, { headers: await auth(authorEmail) })).body,
    );
    const [group] = single.notification_groups;
    expect(group?.notifications_count).toBe(45);
    expect(group?.sample_account_ids).toHaveLength(3);
    expect(single.accounts.map((account) => account.id)).toEqual(group?.sample_account_ids);
    const newest = (await notificationIds(authorEmail, "&types[]=favourite"))[0];
    expect(group?.most_recent_notification_id).toBe(newest);

    const first = await SELF.fetch(
      `https://example.com/api/v2/notifications/${groupKey}/accounts`,
      {
        headers: await auth(authorEmail),
      },
    );
    const firstPage = read(z.array(MastodonAccountPreviewSchema), await first.json());
    expect(firstPage).toHaveLength(40);
    expect(firstPage[0]?.username).toBe("group_large_fan_44");
    const next = parseLinks(first.headers.get("link")).next;
    expect(next?.searchParams.get("max_id")).toBeTruthy();
    const second = await SELF.fetch(
      `https://example.com${next?.pathname ?? ""}${next?.search ?? ""}`,
      {
        headers: await auth(authorEmail),
      },
    );
    const secondPage = read(z.array(MastodonAccountPreviewSchema), await second.json());
    expect(secondPage.map((account) => account.username)).toEqual(
      [4, 3, 2, 1, 0].map((index) => `group_large_fan_${index}`),
    );
    expect(parseLinks(second.headers.get("link")).next).toBeUndefined();

    const capped = await json(`/api/v2/notifications/${groupKey}/accounts?limit=200`, {
      headers: await auth(authorEmail),
    });
    expect(read(z.array(MastodonAccountPreviewSchema), capped.body)).toHaveLength(45);
    const small = await json(`/api/v2/notifications/${groupKey}/accounts?limit=2`, {
      headers: await auth(authorEmail),
    });
    expect(read(z.array(MastodonAccountPreviewSchema), small.body)).toHaveLength(2);
  }, 90_000);

  it("dismisses every notification of a group larger than 50, muted senders included", async () => {
    const authorEmail = "group-dismiss-author@example.com";
    const p = await postStatus(authorEmail, { status: "dismiss p" });
    const other = await postStatus(authorEmail, { status: "dismiss other" });
    await favouriteFrom("group-dismiss-fan", 60, p);
    await favourite("group-dismiss-fan-0@example.com", other);
    const muted = await credentials("group-dismiss-fan-7@example.com");
    const mute = await json(`/api/v1/accounts/${muted.id}/mute`, {
      method: "POST",
      headers: await auth(authorEmail),
    });
    expect(mute.status).toBe(200);

    const dismissed = await json(`/api/v2/notifications/favourite-${p}/dismiss`, {
      method: "POST",
      headers: await auth(authorEmail),
    });
    expect(dismissed.status).toBe(200);
    await json(`/api/v1/accounts/${muted.id}/unmute`, {
      method: "POST",
      headers: await auth(authorEmail),
    });

    const groups = read(
      EnvelopeSchema,
      (await json("/api/v2/notifications", { headers: await auth(authorEmail) })).body,
    ).notification_groups;
    expect(groups.map((group) => [group.status_id, group.notifications_count])).toEqual([
      [other, 1],
    ]);
    expect(await notificationIds(authorEmail, "&include_filtered=true")).toHaveLength(1);
    const gone = await json(`/api/v2/notifications/favourite-${p}`, {
      headers: await auth(authorEmail),
    });
    expect(gone.status).toBe(404);
  }, 90_000);

  it("answers a dismiss with 200 whether or not anything matched", async () => {
    const authorEmail = "group-dismiss-twice-author@example.com";
    const p = await postStatus(authorEmail, { status: "twice p" });
    await favourite("group-dismiss-twice-fan@example.com", p);
    for (const groupKey of [`favourite-${p}`, `favourite-${p}`, "ungrouped-0", "nonsense"]) {
      const dismissed = await json(`/api/v2/notifications/${groupKey}/dismiss`, {
        method: "POST",
        headers: await auth(authorEmail),
      });
      expect(dismissed.status).toBe(200);
    }
  });

  it("leaves held notifications out of a type and target key, but not out of their own key", async () => {
    const authorEmail = "group-held-author@example.com";
    const p = await postStatus(authorEmail, { status: "held p" });
    await favourite("group-held-fan-a@example.com", p);
    const policy = await json("/api/v2/notifications/policy", {
      method: "PATCH",
      headers: { ...(await auth(authorEmail)), "content-type": "application/json" },
      body: JSON.stringify({ for_not_following: "filter" }),
    });
    expect(policy.status).toBe(200);
    await favourite("group-held-fan-b@example.com", p);
    const [held] = await notificationIds(authorEmail, "&include_filtered=true");
    expect(await notificationIds(authorEmail, "")).not.toContain(held);

    await json(`/api/v2/notifications/favourite-${p}/dismiss`, {
      method: "POST",
      headers: await auth(authorEmail),
    });
    expect(await notificationIds(authorEmail, "&include_filtered=true")).toEqual([held]);

    await json(`/api/v2/notifications/ungrouped-${held ?? ""}/dismiss`, {
      method: "POST",
      headers: await auth(authorEmail),
    });
    expect(await notificationIds(authorEmail, "&include_filtered=true")).toEqual([]);
  });
});
