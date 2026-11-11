import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiAccount, ApiConversation, ApiHashtag, ApiStatus, ApiTrendsLink } from "@tstodon/api";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";

type Page<T> = Readonly<{ items: T[]; next?: string | undefined; prev?: string | undefined }>;

/** The `rel` URL of a `Link` header, if it has one. */
const linkRel = (link: string | null, rel: "next" | "prev"): string | undefined =>
  new RegExp(`<([^>]+)>; rel="${rel}"`).exec(link ?? "")?.[1];

const getPage = async <T>(
  schema: z.ZodType<T>,
  path: string,
  headers: Record<string, string> = {},
): Promise<Page<T>> => {
  const url = path.startsWith("https://") ? path : `https://example.com${path}`;
  const response = await SELF.fetch(url, { headers });
  expect(response.status).toBe(200);
  const parsed = schemaResult(z.array(schema))(await response.json());
  if (parsed.isErr()) {
    throw new Error(`response schema rejected for ${path}`);
  }
  const link = response.headers.get("Link");
  return { items: parsed.value, next: linkRel(link, "next"), prev: linkRel(link, "prev") };
};

const param = (url: string | undefined, name: string): string | null =>
  url === undefined ? null : new URL(url).searchParams.get(name);

const postStatus = async (
  email: string,
  body: Readonly<Record<string, unknown>>,
): Promise<z.infer<typeof ApiStatus>> => {
  const response = await SELF.fetch("https://example.com/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  const parsed = schemaResult(ApiStatus)(await response.json());
  if (parsed.isErr()) {
    throw new Error("status schema rejected");
  }
  return parsed.value;
};

describe("GET /api/v1/conversations paging", () => {
  it("pages by each conversation's last status id, as Mastodon does", async () => {
    const alice = "conv-paging-alice@example.com";
    const bob = "conv-paging-bob@example.com";
    const bobResponse = await SELF.fetch("https://example.com/api/v1/accounts/verify_credentials", {
      headers: await authHeaders(bob),
    });
    const bobAccount = schemaResult(ApiAccount)(await bobResponse.json());
    if (bobAccount.isErr()) {
      throw new Error("account schema rejected");
    }
    const mention = `@${bobAccount.value.username}`;

    // Five conversations, then a reply that makes the first one the newest:
    // the list order is c1, c5, c4, c3, c2.
    const started: z.infer<typeof ApiStatus>[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
      started.push(
        await postStatus(alice, { status: `${mention} thread ${n}`, visibility: "direct" }),
      );
    }
    const [c1, c2, c3, c4, c5] = started;
    if (!c1 || !c2 || !c3 || !c4 || !c5) {
      throw new Error("statuses not posted");
    }
    const reply = await postStatus(alice, {
      status: `${mention} back to thread 1`,
      visibility: "direct",
      in_reply_to_id: c1.id,
    });

    const headers = await authHeaders(bob);
    const lastIds = (page: Page<z.infer<typeof ApiConversation>>): (string | undefined)[] =>
      page.items.map((conversation) => conversation.last_status?.id);

    const all = await getPage(ApiConversation, "/api/v1/conversations", headers);
    expect(lastIds(all)).toEqual([reply.id, c5.id, c4.id, c3.id, c2.id]);
    // A short page has no next, and any page has a prev.
    expect(all.next).toBeUndefined();
    expect(param(all.prev, "min_id")).toBe(reply.id);

    const first = await getPage(ApiConversation, "/api/v1/conversations?limit=2", headers);
    expect(lastIds(first)).toEqual([reply.id, c5.id]);
    expect(param(first.next, "max_id")).toBe(c5.id);
    expect(param(first.next, "limit")).toBe("2");
    expect(param(first.prev, "min_id")).toBe(reply.id);

    // Following next: the older conversations, none repeated (c1 has an older
    // status below the cursor, but its last status is above it).
    const second = await getPage(ApiConversation, first.next ?? "", headers);
    expect(lastIds(second)).toEqual([c4.id, c3.id]);
    expect(param(second.next, "max_id")).toBe(c3.id);
    expect(param(second.prev, "min_id")).toBe(c4.id);
    const firstIds = new Set(first.items.map((conversation) => conversation.id));
    expect(second.items.some((conversation) => firstIds.has(conversation.id))).toBe(false);

    const third = await getPage(ApiConversation, second.next ?? "", headers);
    expect(lastIds(third)).toEqual([c2.id]);
    expect(third.next).toBeUndefined();
    expect(param(third.prev, "min_id")).toBe(c2.id);

    // prev of the second page leads back to the first.
    const back = await getPage(ApiConversation, second.prev ?? "", headers);
    expect(lastIds(back)).toEqual([reply.id, c5.id]);

    // since_id: the newest above the cursor; min_id: the ones just above it.
    const since = await getPage(
      ApiConversation,
      `/api/v1/conversations?limit=2&since_id=${c3.id}`,
      headers,
    );
    expect(lastIds(since)).toEqual([reply.id, c5.id]);
    const min = await getPage(
      ApiConversation,
      `/api/v1/conversations?limit=2&min_id=${c3.id}`,
      headers,
    );
    expect(lastIds(min)).toEqual([c5.id, c4.id]);
    const between = await getPage(
      ApiConversation,
      `/api/v1/conversations?max_id=${c5.id}&min_id=${c2.id}`,
      headers,
    );
    expect(lastIds(between)).toEqual([c4.id, c3.id]);

    // Nothing newer than the newest: an empty page has no links.
    const none = await getPage(
      ApiConversation,
      `/api/v1/conversations?since_id=${reply.id}`,
      headers,
    );
    expect(none.items).toEqual([]);
    expect(none.next).toBeUndefined();
    expect(none.prev).toBeUndefined();
  });
});

describe("trends paging", () => {
  /**
   * Walk a trends endpoint by its `next` links at `limit` per page, checking
   * each page against the full list and the links Mastodon sends.
   */
  const walk = async <T>(schema: z.ZodType<T>, path: string, key: (item: T) => string) => {
    const all = (await getPage(schema, `${path}?limit=20`)).items.map(key);
    expect(all.length).toBeGreaterThanOrEqual(5);
    const limit = 2;

    const first = await getPage(schema, `${path}?limit=${limit}`);
    expect(first.items.map(key)).toEqual(all.slice(0, limit));
    expect(param(first.next, "offset")).toBe(String(limit));
    expect(param(first.next, "limit")).toBe(String(limit));
    expect(first.prev).toBeUndefined();

    const seen = [...first.items.map(key)];
    let page = first;
    let offset = 0;
    while (page.next !== undefined) {
      const next: Page<T> = await getPage(schema, page.next);
      offset += limit;
      const keys = next.items.map(key);
      expect(keys).toEqual(all.slice(offset, offset + limit));
      expect(keys.some((item) => seen.includes(item))).toBe(false);
      seen.push(...keys);
      expect(param(next.prev, "offset")).toBe(String(offset - limit));
      page = next;
    }
    // The walk ends on a short (or empty) page, which has no next.
    expect(page.items.length).toBeLessThan(limit);
    expect(seen).toEqual(all);

    // A page past the first goes back by `limit`, never below 0.
    const shifted = await getPage(schema, `${path}?limit=${limit}&offset=1`);
    expect(shifted.items.map(key)).toEqual(all.slice(1, 1 + limit));
    expect(param(shifted.prev, "offset")).toBe("0");
    expect(param(shifted.next, "offset")).toBe(String(1 + limit));
  };

  it("pages trending tags by offset with Link headers", async () => {
    // Uses 5, 4, 3, 2, 1: an odd count, so the last page of two is short.
    for (const [n, tag] of ["pagea", "pageb", "pagec", "paged", "pagee"].entries()) {
      for (let use = 0; use < 5 - n; use += 1) {
        await postStatus(`trend-tag-paging-${use}@example.com`, { status: `#${tag} ${use}` });
      }
    }
    await walk(ApiHashtag, "/api/v1/trends/tags", (tag) => tag.name);
  });

  it("pages trending statuses by offset with Link headers", async () => {
    for (const n of [1, 2, 3, 4, 5]) {
      await postStatus("trend-status-paging@example.com", { status: `trending ${n}` });
    }
    await walk(ApiStatus, "/api/v1/trends/statuses", (status) => status.id);
  });

  it("pages trending links by offset with Link headers", async () => {
    for (const n of [1, 2, 3, 4, 5]) {
      await postStatus("trend-link-paging@example.com", {
        status: `read https://paging.example/story-${n}`,
      });
    }
    await walk(ApiTrendsLink, "/api/v1/trends/links", (link) => link.url);
  });
});
