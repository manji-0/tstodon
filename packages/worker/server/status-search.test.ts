import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiAccount, ApiStatus } from "@tstodon/api";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";

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

const SearchResultsSchema = z.object({
  statuses: z.array(ApiStatus),
});

const accountOf = async (email: string): Promise<z.infer<typeof ApiAccount>> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await authHeaders(email),
  });
  expect(response.status).toBe(200);
  return read(ApiAccount, response.body);
};

const post = async (
  email: string,
  status: string,
  visibility: "public" | "unlisted" | "private" | "direct" = "public",
): Promise<string> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ status, visibility }),
  });
  expect(response.status).toBe(200);
  return read(ApiStatus, response.body).id;
};

const act = async (email: string, path: string): Promise<void> => {
  const response = await json(path, { method: "POST", headers: await authHeaders(email) });
  expect(response.status).toBe(200);
};

const search = async (
  email: string,
  query: string,
): Promise<z.infer<typeof SearchResultsSchema>> => {
  const response = await json(`/api/v2/search?${query}`, { headers: await authHeaders(email) });
  expect(response.status).toBe(200);
  return read(SearchResultsSchema, response.body);
};

describe("status search", () => {
  it("pages statuses with offset, counting only the ones the viewer may see", async () => {
    const viewer = "status-search-pager@example.com";
    const author = "status-search-author@example.com";
    const stranger = "status-search-stranger@example.com";
    const blocked = "status-search-blocked@example.com";
    await accountOf(viewer);
    const blockedAccount = await accountOf(blocked);
    await act(viewer, `/api/v1/accounts/${blockedAccount.id}/block`);
    // Hidden matches sit between the visible ones, newest first.
    const visible: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      visible.push(await post(author, `pagedstatusq visible ${index}`));
      await post(stranger, `pagedstatusq followers only ${index}`, "private");
      await post(blocked, `pagedstatusq blocked ${index}`);
    }
    await post(stranger, "pagedstatusq direct to nobody", "direct");

    const pages = [];
    for (const offset of [0, 2, 4, 6]) {
      pages.push(
        (
          await search(viewer, `q=pagedstatusq&type=statuses&limit=2&offset=${offset}`)
        ).statuses.map((status) => status.id),
      );
    }
    expect(pages).toEqual([[visible[4], visible[3]], [visible[2], visible[1]], [visible[0]], []]);
  });

  it("finds the followers-only and direct statuses the viewer may see", async () => {
    const viewer = "status-search-insider@example.com";
    const friend = "status-search-friend@example.com";
    const viewerAccount = await accountOf(viewer);
    const friendAccount = await accountOf(friend);
    await act(viewer, `/api/v1/accounts/${friendAccount.id}/follow`);
    const expected = [
      await post(friend, "insiderstatusq followers only", "private"),
      await post(friend, `insiderstatusq @${viewerAccount.username} direct`, "direct"),
      await post(viewer, "insiderstatusq my own followers only", "private"),
    ];
    const found = await search(viewer, "q=insiderstatusq&type=statuses&limit=10");
    expect(found.statuses.map((status) => status.id).toSorted()).toEqual(expected.toSorted());

    const outsider = await search(
      "status-search-outsider@example.com",
      "q=insiderstatusq&type=statuses&limit=10",
    );
    expect(outsider.statuses).toEqual([]);
    const anonymous = await json("/api/v2/search?q=insiderstatusq&type=statuses&limit=10");
    expect(read(SearchResultsSchema, anonymous.body).statuses).toEqual([]);
  });

  // Mastodon's `StatusFilter`: a silenced account's status is left out only
  // for a reader who neither follows nor is that account; a suspended
  // account's status is left out for every reader (`StatusPolicy#show?`).
  it("shows a silenced account's statuses only to the account and its followers", async () => {
    const silenced = "search-silenced@example.com";
    const follower = "search-silenced-fan@example.com";
    const stranger = "search-silenced-other@example.com";
    const suspended = "search-suspended@example.com";
    const other = "search-silenced-third@example.com";
    const silencedAccount = await accountOf(silenced);
    const suspendedAccount = await accountOf(suspended);
    await accountOf(stranger);
    await act(follower, `/api/v1/accounts/${silencedAccount.id}/follow`);
    const kept = await post(other, "silencedstatusq from someone else");
    const hidden = [
      await post(silenced, "silencedstatusq silenced one"),
      await post(silenced, "silencedstatusq silenced two"),
    ];
    await post(suspended, "silencedstatusq suspended");
    const admin = await authHeaders("search-silence-admin@example.com", { admin: true });
    for (const path of [
      `/api/v1/admin/accounts/${silencedAccount.id}/silence`,
      `/api/v1/admin/accounts/${suspendedAccount.id}/suspend`,
    ]) {
      const response = await json(path, { method: "POST", headers: admin });
      expect(response.status, path).toBe(200);
    }

    const found = async (email: string, offset = 0, limit = 10) =>
      (
        await search(email, `q=silencedstatusq&type=statuses&limit=${limit}&offset=${offset}`)
      ).statuses.map((status) => status.id);
    for (const reader of [silenced, follower]) {
      expect(await found(reader), reader).toEqual([hidden[1], hidden[0], kept]);
    }
    expect(await found(stranger)).toEqual([kept]);
    // The filter runs before `offset`, so a page skips only what its reader sees.
    expect(await found(stranger, 0, 1)).toEqual([kept]);
    expect(await found(stranger, 1, 1)).toEqual([]);
    expect(await found(follower, 2, 1)).toEqual([kept]);
  });
});
