import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  ApiAccount,
  ApiNotification,
  ApiNotificationRequest,
  ApiScheduledStatus,
  ApiStatus,
  ApiTag,
} from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";

const request = async (email: string | undefined, path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://example.com${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(email === undefined ? {} : await authHeaders(email)),
    },
  });

const send = async (
  email: string,
  path: string,
  body: unknown = {},
  method = "POST",
): Promise<unknown> => {
  const response = await request(email, path, { method, body: JSON.stringify(body) });
  expect(response.status, path).toBe(200);
  return response.json();
};

const me = async (email: string) =>
  expectContract(
    ApiAccount,
    await (await request(email, "/api/v1/accounts/verify_credentials")).json(),
  );

const post = async (email: string, status: string, extra: Record<string, unknown> = {}) =>
  expectContract(ApiStatus, await send(email, "/api/v1/statuses", { status, ...extra })).id;

/** A `Link` header's rels, each as the path and query it points at. */
type Links = Readonly<Partial<Record<"next" | "prev", URL>>>;

const parseLinks = (header: string | null): Links =>
  Object.fromEntries(
    [...(header ?? "").matchAll(/<([^>]+)>; rel="(next|prev)"/g)].map((match) => [
      match[2],
      new URL(match[1] ?? ""),
    ]),
  );

const page = async <T>(
  schema: z.ZodType<T>,
  email: string | undefined,
  path: string,
): Promise<Readonly<{ items: T[]; links: Links; hasLink: boolean }>> => {
  const response = await request(email, path);
  expect(response.status, path).toBe(200);
  return {
    items: expectContract(z.array(schema), await response.json()),
    links: parseLinks(response.headers.get("Link")),
    hasLink: response.headers.has("Link"),
  };
};

const query = (url: URL | undefined): Record<string, string[]> => {
  const params: Record<string, string[]> = {};
  for (const [name, value] of url?.searchParams ?? []) {
    params[name] = [...(params[name] ?? []), value];
  }
  return params;
};

/**
 * Mastodon v4.7.5's `Api::V1::Timelines::BaseController`: after any page that
 * is not empty, `rel="next"` is `max_id=<last id>` and `rel="prev"` is
 * `min_id=<first id>`, keeping the controller's `PERMITTED_PARAMS`.
 */
describe("timeline Link headers", () => {
  const expectTimelineLinks = (
    links: Links,
    path: string,
    ids: ReadonlyArray<string>,
    kept: Record<string, string[]>,
  ) => {
    expect(links.next?.pathname).toBe(path);
    expect(links.prev?.pathname).toBe(path);
    expect(query(links.next)).toEqual({ ...kept, max_id: [ids.at(-1)] });
    expect(query(links.prev)).toEqual({ ...kept, min_id: [ids[0]] });
  };

  it("links the home timeline, also after a page that is not full", async () => {
    const email = "links-home@example.com";
    for (const n of [1, 2, 3]) {
      await post(email, `home ${n}`);
    }
    const full = await page(ApiStatus, email, "/api/v1/timelines/home?limit=2&local=true&foo=1");
    expect(full.items).toHaveLength(2);
    expectTimelineLinks(
      full.links,
      "/api/v1/timelines/home",
      full.items.map((status) => status.id),
      { limit: ["2"], local: ["true"] },
    );

    const rest = await page(
      ApiStatus,
      email,
      `${full.links.next?.pathname}${full.links.next?.search}`,
    );
    expect(rest.items).toHaveLength(1);
    expect(rest.links.next?.searchParams.get("max_id")).toBe(rest.items[0]?.id);

    const end = await page(
      ApiStatus,
      email,
      `/api/v1/timelines/home?max_id=${rest.items[0]?.id ?? ""}`,
    );
    expect(end.items).toEqual([]);
    expect(end.hasLink).toBe(false);
  });

  it("links the public timeline with its permitted filters", async () => {
    await post("links-public@example.com", "public one");
    await post("links-public@example.com", "public two");
    const result = await page(
      ApiStatus,
      undefined,
      "/api/v1/timelines/public?limit=1&local=true&remote=false&only_media=false&max_id=&any[]=x",
    );
    expect(result.items).toHaveLength(1);
    expectTimelineLinks(
      result.links,
      "/api/v1/timelines/public",
      result.items.map((status) => status.id),
      { limit: ["1"], local: ["true"], remote: ["false"], only_media: ["false"] },
    );
  });

  it("links a tag timeline, keeping local and only_media but not the tag filters", async () => {
    const email = "links-tag@example.com";
    for (const n of [1, 2]) {
      await post(email, `tagged ${n} #linkstag`);
    }
    const result = await page(
      ApiStatus,
      undefined,
      "/api/v1/timelines/tag/linkstag?limit=5&local=true&remote=true&only_media=false&none[]=linksother",
    );
    expect(result.items).toHaveLength(2);
    expectTimelineLinks(
      result.links,
      "/api/v1/timelines/tag/linkstag",
      result.items.map((status) => status.id),
      { limit: ["5"], local: ["true"], only_media: ["false"] },
    );

    const unknown = await page(ApiStatus, undefined, "/api/v1/timelines/tag/linksnotused");
    expect(unknown.items).toEqual([]);
    expect(unknown.hasLink).toBe(false);
  });

  it("links a list timeline", async () => {
    const owner = "links-list-owner@example.com";
    const member = "links-list-member@example.com";
    const memberId = (await me(member)).id;
    await send(owner, `/api/v1/accounts/${memberId}/follow`);
    const list = z
      .object({ id: z.string() })
      .parse(await send(owner, "/api/v1/lists", { title: "l" }));
    await send(owner, `/api/v1/lists/${list.id}/accounts`, { account_ids: [memberId] });
    for (const n of [1, 2, 3]) {
      await post(member, `listed ${n}`);
    }
    const path = `/api/v1/timelines/list/${list.id}`;
    const result = await page(ApiStatus, owner, `${path}?limit=2&local=true`);
    expect(result.items).toHaveLength(2);
    expectTimelineLinks(
      result.links,
      path,
      result.items.map((status) => status.id),
      { limit: ["2"] },
    );
  });
});

/**
 * Lists whose `next_path` holds while `records_continue?` (a full page) and
 * whose `prev_path` holds for any page that is not empty.
 */
describe("Link headers of full pages", () => {
  it("links an account's statuses, keeping AccountStatusesFilter::KEYS", async () => {
    const email = "links-account@example.com";
    const account = await me(email);
    for (const n of [1, 2, 3]) {
      await post(email, `own ${n}`);
    }
    const path = `/api/v1/accounts/${account.id}/statuses`;
    const full = await page(
      ApiStatus,
      undefined,
      `${path}?limit=2&exclude_replies=true&exclude_reblogs=false&only_media=false&exclude_direct=true&foo=1`,
    );
    const ids = full.items.map((status) => status.id);
    expect(ids).toHaveLength(2);
    const kept = {
      limit: ["2"],
      exclude_replies: ["true"],
      exclude_reblogs: ["false"],
      only_media: ["false"],
    };
    expect(full.links.next?.pathname).toBe(path);
    expect(query(full.links.next)).toEqual({ ...kept, max_id: [ids[1]] });
    expect(query(full.links.prev)).toEqual({ ...kept, min_id: [ids[0]] });

    const partial = await page(ApiStatus, undefined, `${path}?limit=5`);
    expect(partial.items).toHaveLength(3);
    expect(partial.links.next).toBeUndefined();
    expect(query(partial.links.prev)).toEqual({ limit: ["5"], min_id: [partial.items[0]?.id] });

    const empty = await page(ApiStatus, undefined, `${path}?max_id=${partial.items[2]?.id ?? ""}`);
    expect(empty.items).toEqual([]);
    expect(empty.hasLink).toBe(false);
  });

  it("links scheduled statuses", async () => {
    const email = "links-scheduled@example.com";
    for (const n of [1, 2, 3]) {
      const at = new Date(Date.now() + (60 + n) * 60_000).toISOString();
      expectContract(
        ApiScheduledStatus,
        await send(email, "/api/v1/statuses", { status: `later ${n}`, scheduled_at: at }),
      );
    }
    const full = await page(ApiScheduledStatus, email, "/api/v1/scheduled_statuses?limit=2");
    const ids = full.items.map((status) => status.id);
    expect(ids).toHaveLength(2);
    expect(query(full.links.next)).toEqual({ limit: ["2"], max_id: [ids[1]] });
    expect(query(full.links.prev)).toEqual({ limit: ["2"], min_id: [ids[0]] });

    const rest = await page(
      ApiScheduledStatus,
      email,
      `${full.links.next?.pathname}${full.links.next?.search}`,
    );
    expect(rest.items).toHaveLength(1);
    expect(rest.links.next).toBeUndefined();
    expect(rest.links.prev?.searchParams.get("min_id")).toBe(rest.items[0]?.id);

    // A `min_id` page is newest first, so its `prev` is its newest id.
    const newer = await page(
      ApiScheduledStatus,
      email,
      `/api/v1/scheduled_statuses?min_id=${rest.items[0]?.id ?? ""}`,
    );
    expect(newer.items.map((status) => status.id)).toEqual(ids);
    expect(newer.links.prev?.searchParams.get("min_id")).toBe(ids[0]);
  });

  it("links notification requests by request id", async () => {
    const email = "links-requests@example.com";
    const username = (await me(email)).username;
    for (const sender of ["links-stranger-a@example.com", "links-stranger-b@example.com"]) {
      await post(sender, `@${username} psst`, { visibility: "direct" });
    }
    const full = await page(
      ApiNotificationRequest,
      email,
      "/api/v1/notifications/requests?limit=1",
    );
    expect(full.items).toHaveLength(1);
    const id = full.items[0]?.id;
    expect(query(full.links.next)).toEqual({ limit: ["1"], max_id: [id] });
    expect(query(full.links.prev)).toEqual({ limit: ["1"], min_id: [id] });

    const rest = await page(
      ApiNotificationRequest,
      email,
      `${full.links.next?.pathname}${full.links.next?.search}`,
    );
    expect(rest.items).toHaveLength(1);
    expect(rest.items[0]?.id).not.toBe(id);
  });

  it("links follow requests, prev by since_id", async () => {
    const email = "links-locked@example.com";
    await send(email, "/api/v1/accounts/update_credentials", { locked: true }, "PATCH");
    const target = (await me(email)).id;
    const requesters: string[] = [];
    for (const name of ["a", "b", "c"]) {
      const requester = `links-requester-${name}@example.com`;
      await send(requester, `/api/v1/accounts/${target}/follow`);
      requesters.push((await me(requester)).id);
    }
    const full = await page(ApiAccount, email, "/api/v1/follow_requests?limit=2");
    expect(full.items.map((account) => account.id)).toEqual(requesters.toReversed().slice(0, 2));
    const next = full.links.next?.searchParams.get("max_id");
    const prev = full.links.prev?.searchParams.get("since_id");
    expect(next).toEqual(expect.any(String));
    expect(prev).toEqual(expect.any(String));
    expect(query(full.links.next)).toEqual({ limit: ["2"], max_id: [next] });
    expect(query(full.links.prev)).toEqual({ limit: ["2"], since_id: [prev] });

    const rest = await page(
      ApiAccount,
      email,
      `/api/v1/follow_requests?limit=2&max_id=${next ?? ""}`,
    );
    expect(rest.items.map((account) => account.id)).toEqual([requesters[0]]);
    expect(rest.links.next).toBeUndefined();

    const newer = await page(ApiAccount, email, `/api/v1/follow_requests?since_id=${prev ?? ""}`);
    expect(newer.items).toEqual([]);
  });

  it("offers the next v1 notifications page after any page that is not empty", async () => {
    const email = "links-notified@example.com";
    const target = (await me(email)).id;
    await send("links-notifier@example.com", `/api/v1/accounts/${target}/follow`);
    const result = await page(ApiNotification, email, "/api/v1/notifications?limit=5");
    expect(result.items).toHaveLength(1);
    const id = result.items[0]?.id;
    expect(query(result.links.next)).toEqual({ limit: ["5"], max_id: [id] });
    expect(query(result.links.prev)).toEqual({ limit: ["5"], min_id: [id] });

    const end = await page(ApiNotification, email, `/api/v1/notifications?max_id=${id ?? ""}`);
    expect(end.items).toEqual([]);
    expect(end.hasLink).toBe(false);
  });
});

/** Lists Mastodon pages that tstodon answered in full. */
describe("lists paged as Mastodon pages them", () => {
  it("pages domain blocks by BLOCK_LIMIT", async () => {
    const email = "links-domains@example.com";
    const domains = ["one.example", "two.example", "three.example"];
    for (const domain of domains) {
      await send(email, "/api/v1/domain_blocks", { domain });
    }
    const all = await page(z.string(), email, "/api/v1/domain_blocks");
    expect(all.items).toEqual(domains.toReversed());
    expect(all.links.next).toBeUndefined();

    const full = await page(z.string(), email, "/api/v1/domain_blocks?limit=2");
    expect(full.items).toEqual(["three.example", "two.example"]);
    const next = full.links.next?.searchParams.get("max_id") ?? "";
    const prev = full.links.prev?.searchParams.get("since_id") ?? "";
    expect(query(full.links.next)).toEqual({ limit: ["2"], max_id: [next] });
    expect(query(full.links.prev)).toEqual({ limit: ["2"], since_id: [prev] });

    const rest = await page(z.string(), email, `/api/v1/domain_blocks?limit=2&max_id=${next}`);
    expect(rest.items).toEqual(["one.example"]);
    expect(rest.links.next).toBeUndefined();
    expect((await page(z.string(), email, `/api/v1/domain_blocks?since_id=${prev}`)).items).toEqual(
      [],
    );
    // `limit_param(BLOCK_LIMIT)` caps at 200, and 0 is an empty page.
    expect((await page(z.string(), email, "/api/v1/domain_blocks?limit=0")).items).toEqual([]);
  });

  it("pages followed tags by TAGS_LIMIT", async () => {
    const email = "links-tags@example.com";
    const tags = ["linksfirst", "linkssecond", "linksthird"];
    for (const tag of tags) {
      await send(email, `/api/v1/tags/${tag}/follow`);
    }
    const all = await page(ApiTag, email, "/api/v1/followed_tags");
    expect(all.items.map((tag) => tag.name)).toEqual(tags.toReversed());
    expect(all.links.next).toBeUndefined();

    const full = await page(ApiTag, email, "/api/v1/followed_tags?limit=2");
    expect(full.items.map((tag) => tag.name)).toEqual(["linksthird", "linkssecond"]);
    const next = full.links.next?.searchParams.get("max_id") ?? "";
    expect(query(full.links.prev)).toEqual({
      limit: ["2"],
      since_id: [full.links.prev?.searchParams.get("since_id") ?? ""],
    });
    const rest = await page(ApiTag, email, `/api/v1/followed_tags?limit=2&max_id=${next}`);
    expect(rest.items.map((tag) => tag.name)).toEqual(["linksfirst"]);
  });

  it("pages a list's accounts by account id, and answers all of them for limit=0", async () => {
    const owner = "links-members-owner@example.com";
    const list = z
      .object({ id: z.string() })
      .parse(await send(owner, "/api/v1/lists", { title: "m" }));
    const members: string[] = [];
    for (const name of ["a", "b", "c"]) {
      const id = (await me(`links-member-${name}@example.com`)).id;
      await send(owner, `/api/v1/accounts/${id}/follow`);
      await send(owner, `/api/v1/lists/${list.id}/accounts`, { account_ids: [id] });
      members.push(id);
    }
    const path = `/api/v1/lists/${list.id}/accounts`;
    const newestFirst = members.toSorted().toReversed();

    const full = await page(ApiAccount, owner, `${path}?limit=2`);
    expect(full.items.map((account) => account.id)).toEqual(newestFirst.slice(0, 2));
    expect(query(full.links.next)).toEqual({ limit: ["2"], max_id: [newestFirst[1]] });
    expect(query(full.links.prev)).toEqual({ limit: ["2"], since_id: [newestFirst[0]] });

    const rest = await page(ApiAccount, owner, `${path}?limit=2&max_id=${newestFirst[1] ?? ""}`);
    expect(rest.items.map((account) => account.id)).toEqual([newestFirst[2]]);
    expect(rest.links.next).toBeUndefined();

    const unlimited = await page(ApiAccount, owner, `${path}?limit=0`);
    expect(unlimited.items.map((account) => account.id)).toEqual(newestFirst);
    expect(unlimited.hasLink).toBe(false);
    // Only `"0"` is unlimited: `00` reads as 0, an empty page.
    expect((await page(ApiAccount, owner, `${path}?limit=00`)).items).toEqual([]);
  });
});

/**
 * Mastodon reads a `min_id` page oldest first and answers it newest first
 * (`paginate_by_min_id(...).reverse`, and the feeds' `Status` default scope),
 * so its `rel="prev"` is its newest id and a client catching up moves a whole
 * page at a time.
 */
describe("min_id pages", () => {
  const expectNewestFirst = async (
    schema: z.ZodType<{ id: string }>,
    email: string | undefined,
    path: string,
    oldest: string,
    newer: ReadonlyArray<string>,
  ) => {
    const separator = path.includes("?") ? "&" : "?";
    const result = await page(schema, email, `${path}${separator}limit=2&min_id=${oldest}`);
    const expected = newer.slice(0, 2).toReversed();
    expect(result.items.map((item) => item.id)).toEqual(expected);
    expect(result.links.prev?.searchParams.get("min_id")).toBe(expected[0]);
    expect(result.links.next?.searchParams.get("max_id")).toBe(expected[1]);
  };

  it("answers timelines and an account's statuses newest first", async () => {
    const email = "links-min-id@example.com";
    const account = await me(email);
    const posted: string[] = [];
    for (const n of [1, 2, 3, 4]) {
      posted.push(await post(email, `min ${n} #linksminid`));
    }
    const [oldest = "", ...newer] = posted;
    await expectNewestFirst(ApiStatus, email, "/api/v1/timelines/home", oldest, newer);
    await expectNewestFirst(ApiStatus, undefined, "/api/v1/timelines/public?local=true", oldest, [
      ...newer,
    ]);
    await expectNewestFirst(
      ApiStatus,
      undefined,
      "/api/v1/timelines/tag/linksminid",
      oldest,
      newer,
    );
    await expectNewestFirst(
      ApiStatus,
      undefined,
      `/api/v1/accounts/${account.id}/statuses`,
      oldest,
      newer,
    );
  });

  it("answers v1 notifications, favourites and bookmarks newest first", async () => {
    const email = "links-min-id-notified@example.com";
    const target = (await me(email)).id;
    for (const name of ["a", "b", "c", "d"]) {
      await send(`links-min-id-${name}@example.com`, `/api/v1/accounts/${target}/follow`);
    }
    const all = (await page(ApiNotification, email, "/api/v1/notifications")).items
      .map((item) => item.id)
      .toReversed();
    const [oldest = "", ...newer] = all;
    await expectNewestFirst(ApiNotification, email, "/api/v1/notifications", oldest, newer);

    const statuses: string[] = [];
    for (const n of [1, 2, 3, 4]) {
      const id = await post(email, `saved ${n}`);
      await send(email, `/api/v1/statuses/${id}/favourite`);
      await send(email, `/api/v1/statuses/${id}/bookmark`);
      statuses.push(id);
    }
    const [, ...rest] = statuses;
    for (const path of ["/api/v1/favourites", "/api/v1/bookmarks"]) {
      // These page by row id: the first status's row is the last of a full page.
      const firstRow =
        (await page(ApiStatus, email, `${path}?limit=4`)).links.next?.searchParams.get("max_id") ??
        "";
      const result = await page(ApiStatus, email, `${path}?limit=2&min_id=${firstRow}`);
      expect(result.items.map((item) => item.id)).toEqual(rest.slice(0, 2).toReversed());
      const prev = result.links.prev?.searchParams.get("min_id") ?? "";
      const next = result.links.next?.searchParams.get("max_id") ?? "";
      expect(next > firstRow && prev > next).toBe(true);
    }
  });
});

describe("unread_count limit", () => {
  it("counts at most limit unread notifications (100 by default, at most 1000)", async () => {
    const email = "links-unread@example.com";
    const target = (await me(email)).id;
    for (const name of ["a", "b", "c"]) {
      await send(`links-unread-${name}@example.com`, `/api/v1/accounts/${target}/follow`);
    }
    const count = async (suffix: string) =>
      z
        .object({ count: z.number() })
        .parse(await (await request(email, `/api/v1/notifications/unread_count${suffix}`)).json())
        .count;
    expect(await count("")).toBe(3);
    // A bare `limit` is Rack's `nil`: the default.
    expect(await count("?limit")).toBe(3);
    expect(await count("?limit=2")).toBe(2);
    expect(await count("?limit=-2")).toBe(2);
    expect(await count("?limit=5000")).toBe(3);
    expect(await count("?limit=0")).toBe(0);

    // v2 counts groups, at most limit of them.
    const groups = async (suffix: string) =>
      z
        .object({ count: z.number() })
        .parse(await (await request(email, `/api/v2/notifications/unread_count${suffix}`)).json())
        .count;
    expect(await groups("?limit=1")).toBe(1);
    expect(await groups("?limit=0")).toBe(0);
    // The three follows are one group, counted under the list's own filters.
    expect(await groups("")).toBe(1);
    expect(await groups("?exclude_types[]=follow")).toBe(0);
    expect(await groups("?types[]=mention")).toBe(0);
  });
});

/**
 * Mastodon v4.7.5 pages an account's pins as its other statuses
 * (`AccountStatusesFilter#pinned_scope` under `to_a_paginated_by_id`): newest
 * pin first, bounded by status id, with the `Link` of a full page.
 */
describe("pinned statuses", () => {
  it("pages an account's pins by status id, keeping pinned", async () => {
    const email = "links-pinned@example.com";
    const account = await me(email);
    const posted: string[] = [];
    for (const n of [1, 2, 3]) {
      const id = await post(email, `pin ${n}`);
      await send(email, `/api/v1/statuses/${id}/pin`);
      posted.push(id);
    }
    await post(email, "not pinned");
    const [first = "", second = "", third = ""] = posted;
    const path = `/api/v1/accounts/${account.id}/statuses`;

    const full = await page(ApiStatus, undefined, `${path}?pinned=true&limit=2`);
    expect(full.items.map((status) => status.id)).toEqual([third, second]);
    expect(full.links.next?.pathname).toBe(path);
    expect(query(full.links.next)).toEqual({ limit: ["2"], pinned: ["true"], max_id: [second] });
    expect(query(full.links.prev)).toEqual({ limit: ["2"], pinned: ["true"], min_id: [third] });

    const rest = await page(
      ApiStatus,
      undefined,
      `${full.links.next?.pathname}${full.links.next?.search}`,
    );
    expect(rest.items.map((status) => status.id)).toEqual([first]);
    expect(rest.links.next).toBeUndefined();

    const newer = await page(ApiStatus, undefined, `${path}?pinned=true&limit=1&min_id=${first}`);
    expect(newer.items.map((status) => status.id)).toEqual([second]);
  });
});

/**
 * Mastodon's `paginate_by_max_id` applies `max_id` and `since_id` together,
 * and `paginate_by_min_id` `min_id` and `max_id` together.
 */
describe("both bounds of an id page", () => {
  it("bounds scheduled statuses by max_id with since_id or min_id", async () => {
    const email = "links-bounds-scheduled@example.com";
    for (const n of [1, 2, 3, 4]) {
      const at = new Date(Date.now() + (60 + n) * 60_000).toISOString();
      await send(email, "/api/v1/statuses", { status: `bounded ${n}`, scheduled_at: at });
    }
    const all = (await page(ApiScheduledStatus, email, "/api/v1/scheduled_statuses")).items.map(
      (status) => status.id,
    );
    expect(all).toHaveLength(4);
    const [d = "", c = "", b = "", a = ""] = all;

    const since = await page(
      ApiScheduledStatus,
      email,
      `/api/v1/scheduled_statuses?since_id=${a}&max_id=${d}`,
    );
    expect(since.items.map((status) => status.id)).toEqual([c, b]);

    const min = await page(
      ApiScheduledStatus,
      email,
      `/api/v1/scheduled_statuses?min_id=${a}&max_id=${c}&limit=5`,
    );
    expect(min.items.map((status) => status.id)).toEqual([b]);
  });

  it("bounds the admin tags by max_id with since_id or min_id", async () => {
    const admin = "links-bounds-admin@example.com";
    for (const name of ["a", "b", "c", "d"]) {
      await post(admin, `#linksboundtag${name}`);
    }
    const names = async (query: string): Promise<string[]> => {
      const response = await SELF.fetch(`https://example.com/api/v1/admin/tags?${query}`, {
        headers: await authHeaders(admin, { admin: true }),
      });
      expect(response.status).toBe(200);
      return z
        .array(z.object({ name: z.string() }))
        .parse(await response.json())
        .map((tag) => tag.name)
        .filter((name) => name.startsWith("linksboundtag"));
    };

    expect(await names("since_id=linksboundtaga&max_id=linksboundtagd")).toEqual([
      "linksboundtagc",
      "linksboundtagb",
    ]);
    expect(await names("min_id=linksboundtaga&max_id=linksboundtagc")).toEqual(["linksboundtagb"]);
  });

  it("bounds v1 notifications by max_id with since_id or min_id", async () => {
    const email = "links-bounds-notified@example.com";
    const target = (await me(email)).id;
    for (const name of ["a", "b", "c", "d"]) {
      await send(`links-bounds-follower-${name}@example.com`, `/api/v1/accounts/${target}/follow`);
    }
    const all = (await page(ApiNotification, email, "/api/v1/notifications")).items.map(
      (item) => item.id,
    );
    expect(all).toHaveLength(4);
    const [d = "", c = "", b = "", a = ""] = all;

    const since = await page(
      ApiNotification,
      email,
      `/api/v1/notifications?since_id=${a}&max_id=${d}`,
    );
    expect(since.items.map((item) => item.id)).toEqual([c, b]);

    const min = await page(ApiNotification, email, `/api/v1/notifications?min_id=${a}&max_id=${c}`);
    expect(min.items.map((item) => item.id)).toEqual([b]);
  });

  it("bounds follow requests by max_id and since_id", async () => {
    const email = "links-bounds-locked@example.com";
    await send(email, "/api/v1/accounts/update_credentials", { locked: true }, "PATCH");
    const target = (await me(email)).id;
    const requesters: string[] = [];
    for (const name of ["a", "b", "c"]) {
      const requester = `links-bounds-requester-${name}@example.com`;
      await send(requester, `/api/v1/accounts/${target}/follow`);
      requesters.push((await me(requester)).id);
    }
    // The follow row ids, newest first, as each one-row page names it in `rel="next"`.
    const rowIds: string[] = [];
    let path = "/api/v1/follow_requests?limit=1";
    for (const _ of requesters) {
      const next = (await page(ApiAccount, email, path)).links.next;
      rowIds.push(next?.searchParams.get("max_id") ?? "");
      path = `${next?.pathname}${next?.search}`;
    }
    const [newest = "", , oldest = ""] = rowIds;

    const between = await page(
      ApiAccount,
      email,
      `/api/v1/follow_requests?since_id=${oldest}&max_id=${newest}`,
    );
    expect(between.items.map((account) => account.id)).toEqual([requesters[1]]);
  });

  it("bounds notification requests by max_id with since_id or min_id", async () => {
    const email = "links-bounds-requests@example.com";
    const username = (await me(email)).username;
    for (const name of ["a", "b", "c"]) {
      await post(`links-bounds-stranger-${name}@example.com`, `@${username} psst`, {
        visibility: "direct",
      });
    }
    const all = (
      await page(ApiNotificationRequest, email, "/api/v1/notifications/requests")
    ).items.map((request) => request.id);
    expect(all).toHaveLength(3);
    const [newest = "", middle = "", oldest = ""] = all;

    const since = await page(
      ApiNotificationRequest,
      email,
      `/api/v1/notifications/requests?since_id=${oldest}&max_id=${newest}`,
    );
    expect(since.items.map((request) => request.id)).toEqual([middle]);

    const min = await page(
      ApiNotificationRequest,
      email,
      `/api/v1/notifications/requests?min_id=${oldest}&max_id=${newest}`,
    );
    expect(min.items.map((request) => request.id)).toEqual([middle]);
  });
});

/**
 * Mastodon pages favourites and bookmarks by the `Favourite` and `Bookmark`
 * row id: the newest favourite first, whatever the status's age, and the
 * `Link` names row ids.
 */
describe("favourites and bookmarks by row id", () => {
  it.each(["favourite", "bookmark"] as const)(
    "lists %ss newest first and links by row id",
    async (action) => {
      const email = `links-rows-${action}@example.com`;
      const older = await post(email, "older");
      const newer = await post(email, "newer");
      await send(email, `/api/v1/statuses/${newer}/${action}`);
      await send(email, `/api/v1/statuses/${older}/${action}`);
      const path = `/api/v1/${action}s`;

      const all = await page(ApiStatus, email, path);
      expect(all.items.map((status) => status.id)).toEqual([older, newer]);

      const full = await page(ApiStatus, email, `${path}?limit=1`);
      expect(full.items.map((status) => status.id)).toEqual([older]);
      const rowId = full.links.next?.searchParams.get("max_id") ?? "";
      expect(rowId).not.toBe(older);
      expect(full.links.prev?.searchParams.get("min_id")).toBe(rowId);

      const rest = await page(ApiStatus, email, `${path}?limit=1&max_id=${rowId}`);
      expect(rest.items.map((status) => status.id)).toEqual([newer]);
      const restRowId = rest.links.next?.searchParams.get("max_id") ?? "";
      expect(restRowId < rowId).toBe(true);

      const back = await page(ApiStatus, email, `${path}?min_id=${restRowId}`);
      expect(back.items.map((status) => status.id)).toEqual([older]);
    },
  );
});
