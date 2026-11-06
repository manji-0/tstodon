import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { ENTITY_ID_DIGITS } from "./ids";
import { generateAccountKeys } from "./keys";
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

  it("acts on the whole group by key, across another group's notifications", async () => {
    const authorEmail = "group-key-author@example.com";
    const p = await postStatus(authorEmail, { status: "key p" });
    const other = await postStatus(authorEmail, { status: "key other" });
    await favourite("group-key-old@example.com", p);
    await favourite("group-key-other@example.com", other);
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
    expect(groups.map((group) => group.status_id)).toEqual([other]);
    const gone = await json(`/api/v2/notifications/${groupKey}`, {
      headers: await auth(authorEmail),
    });
    expect(gone.status).toBe(404);
  });
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

/**
 * Write `count` accounts `<prefix>_<n>` and their favourites of `statusId`,
 * oldest first, in one batch: one key pair for all, as an API favourite
 * costs about half a second and a new account's key pair a tenth. Ids are
 * `idPrefix` padded to an entity id's length. Returns the senders' ids.
 */
const favouriteFrom = async (
  authorEmail: string,
  prefix: string,
  count: number,
  statusId: string,
  idPrefix: string,
): Promise<string[]> => {
  const author = await credentials(authorEmail);
  const keys = await generateAccountKeys();
  const id = (index: number): string =>
    `${idPrefix}${String(index).padStart(ENTITY_ID_DIGITS - idPrefix.length, "0")}`;
  const senders = Array.from({ length: count }, (_, index) => ({
    id: id(index),
    username: `${prefix}_${index}`,
    createdAt: new Date(Date.UTC(2026, 10, 5, 0, 0, index)).toISOString(),
  }));
  await env.DB.batch(
    senders.flatMap((sender) => [
      env.DB.prepare(
        `INSERT INTO accounts (id, username, access_email, display_name, locked, default_post_visibility,
           default_quote_policy, public_key_pem, private_key_jwk, created_at, updated_at, bio_text)
         VALUES (?, ?, ?, ?, 0, 'public', 'public', ?, ?, ?, ?, '')`,
      ).bind(
        sender.id,
        sender.username,
        `${sender.username}@example.com`,
        sender.username,
        keys.publicKeyPem,
        keys.privateKeyJwk.reveal(),
        sender.createdAt,
        sender.createdAt,
      ),
      env.DB.prepare(
        `INSERT INTO notifications (id, account_id, from_account_id, kind, status_id, created_at)
         VALUES (?, ?, ?, 'favourite', ?, ?)`,
      ).bind(sender.id, author.id, sender.id, statusId, sender.createdAt),
    ]),
  );
  return senders.map((sender) => sender.id);
};

describe("a notification group by key", () => {
  it("shows a large group from its sample accounts and pages its senders", async () => {
    const authorEmail = "group-large-author@example.com";
    const p = await postStatus(authorEmail, { status: "large p" });
    await favouriteFrom(authorEmail, "group_large_fan", 45, p, "91");
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
  });

  it("dismisses every notification of a group larger than 50, muted senders included", async () => {
    const authorEmail = "group-dismiss-author@example.com";
    const p = await postStatus(authorEmail, { status: "dismiss p" });
    const other = await postStatus(authorEmail, { status: "dismiss other" });
    const senders = await favouriteFrom(authorEmail, "group_dismiss_fan", 60, p, "92");
    await favourite("group-dismiss-other-fan@example.com", other);
    const muted = senders[7] ?? "";
    const mute = await json(`/api/v1/accounts/${muted}/mute`, {
      method: "POST",
      headers: await auth(authorEmail),
    });
    expect(mute.status).toBe(200);

    const dismissed = await json(`/api/v2/notifications/favourite-${p}/dismiss`, {
      method: "POST",
      headers: await auth(authorEmail),
    });
    expect(dismissed.status).toBe(200);
    await json(`/api/v1/accounts/${muted}/unmute`, {
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
  });

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

  it("lists a held notification under a key that dismisses it", async () => {
    const authorEmail = "group-held-listed-author@example.com";
    const p = await postStatus(authorEmail, { status: "held listed p" });
    await favourite("group-held-listed-fan-a@example.com", p);
    const policy = await json("/api/v2/notifications/policy", {
      method: "PATCH",
      headers: { ...(await auth(authorEmail)), "content-type": "application/json" },
      body: JSON.stringify({ for_not_following: "filter" }),
    });
    expect(policy.status).toBe(200);
    await favourite("group-held-listed-fan-b@example.com", p);
    const [held] = await notificationIds(authorEmail, "&include_filtered=true");

    const listed = read(
      EnvelopeSchema,
      (
        await json("/api/v2/notifications?include_filtered=true", {
          headers: await auth(authorEmail),
        })
      ).body,
    ).notification_groups;
    const heldGroup = listed.find((group) => group.most_recent_notification_id === held);
    expect(heldGroup?.notifications_count).toBe(1);

    const dismissed = await json(`/api/v2/notifications/${heldGroup?.group_key ?? ""}/dismiss`, {
      method: "POST",
      headers: await auth(authorEmail),
    });
    expect(dismissed.status).toBe(200);
    expect(await notificationIds(authorEmail, "&include_filtered=true")).not.toContain(held);
  });

  it("reads a group by key whatever grouped_types the request lists", async () => {
    const authorEmail = "group-key-types-author@example.com";
    const p = await postStatus(authorEmail, { status: "key types p" });
    await favourite("group-key-types-fan@example.com", p);
    const groupKey = `favourite-${p}`;
    const query = "grouped_types[]=reblog";

    const single = await json(`/api/v2/notifications/${groupKey}?${query}`, {
      headers: await auth(authorEmail),
    });
    expect(single.status).toBe(200);
    expect(read(EnvelopeSchema, single.body).notification_groups[0]?.group_key).toBe(groupKey);
    const accounts = await json(`/api/v2/notifications/${groupKey}/accounts?${query}`, {
      headers: await auth(authorEmail),
    });
    expect(read(z.array(MastodonAccountPreviewSchema), accounts.body)).toHaveLength(1);

    await json(`/api/v2/notifications/${groupKey}/dismiss?${query}`, {
      method: "POST",
      headers: await auth(authorEmail),
    });
    expect(await notificationIds(authorEmail, "")).toEqual([]);
    const unknown = await json(`/api/v2/notifications/nonsense-${p}`, {
      headers: await auth(authorEmail),
    });
    expect(unknown.status).toBe(404);
  });
});

const groupsAt = async (
  email: string,
  path: string,
): Promise<{
  groups: z.infer<typeof EnvelopeSchema>["notification_groups"];
  prev: URL | undefined;
}> => {
  const response = await SELF.fetch(`https://example.com${path}`, { headers: await auth(email) });
  expect(response.status).toBe(200);
  return {
    groups: read(EnvelopeSchema, await response.json()).notification_groups,
    prev: parseLinks(response.headers.get("link")).prev,
  };
};

describe("grouped notification pages over long runs", () => {
  it("reaches an older group past a long run of one group by following page_max_id", async () => {
    const authorEmail = "group-run-author@example.com";
    const older = await postStatus(authorEmail, { status: "run older" });
    const p = await postStatus(authorEmail, { status: "run p" });
    await favourite("group-run-fan@example.com", older);
    await favouriteFrom(authorEmail, "group_run_fan", 20, p, "96");

    const reached: Array<string | undefined> = [];
    let path = "/api/v2/notifications?limit=2";
    for (let request = 0; request < 2 && !reached.includes(older); request += 1) {
      const { groups } = await groupsAt(authorEmail, path);
      reached.push(...groups.map((group) => group.status_id));
      path = `/api/v2/notifications?limit=2&max_id=${groups.at(-1)?.page_max_id ?? ""}`;
    }
    expect(reached).toContain(older);
  });

  it("pages up past more than one window of unavailable senders", async () => {
    const authorEmail = "group-up-author@example.com";
    const marker = await postStatus(authorEmail, { status: "up marker" });
    const hidden = await postStatus(authorEmail, { status: "up hidden" });
    const shown = await postStatus(authorEmail, { status: "up shown" });
    await favourite("group-up-fan@example.com", marker);
    const [minId] = await notificationIds(authorEmail, "");
    const senders = await favouriteFrom(authorEmail, "group_up_gone", 10, hidden, "93");
    await env.DB.batch(
      senders.map((sender) =>
        env.DB.prepare(
          "INSERT INTO account_moderation (account_id, moderation) VALUES (?, 'Suspended')",
        ).bind(sender),
      ),
    );
    await favouriteFrom(authorEmail, "group_up_kept", 1, shown, "94");

    const reached: Array<string | undefined> = [];
    let path: string | undefined = `/api/v2/notifications?limit=1&min_id=${minId ?? ""}`;
    for (let request = 0; path && request < 3 && !reached.includes(shown); request += 1) {
      const page = await groupsAt(authorEmail, path);
      reached.push(...page.groups.map((group) => group.status_id));
      path = page.prev ? `${page.prev.pathname}${page.prev.search}` : undefined;
    }
    expect(reached).toContain(shown);
    expect(reached).not.toContain(hidden);
  });

  it("counts a group larger than one page the same in the list and by key", async () => {
    const authorEmail = "group-big-author@example.com";
    const p = await postStatus(authorEmail, { status: "big p" });
    await favouriteFrom(authorEmail, "group_big_fan", 12, p, "95");

    const { groups } = await groupsAt(authorEmail, "/api/v2/notifications?limit=1");
    const single = await groupsAt(authorEmail, `/api/v2/notifications/favourite-${p}`);
    expect(groups.map((group) => group.notifications_count)).toEqual([12]);
    expect(single.groups.map((group) => group.notifications_count)).toEqual([12]);
  });

  it("groups only groupable types whatever grouped_types lists, and reads an empty min_id as none", async () => {
    const authorEmail = "group-types-author@example.com";
    const author = await credentials(authorEmail);
    await credentials("group-types-mentioner@example.com");
    const older = await postStatus(authorEmail, { status: "types older" });
    await favourite("group-types-fan@example.com", older);
    await postStatus("group-types-mentioner@example.com", { status: `@${author.username} hi` });

    const mentions = await groupsAt(authorEmail, "/api/v2/notifications?grouped_types[]=mention");
    expect(mentions.groups.find((group) => group.type === "mention")?.group_key).toMatch(
      /^ungrouped-/,
    );
    const empty = await groupsAt(authorEmail, "/api/v2/notifications?limit=1&min_id=");
    expect(empty.groups.map((group) => group.type)).toEqual(["mention"]);
  });
});
