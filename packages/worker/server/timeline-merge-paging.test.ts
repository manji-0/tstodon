import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";

// About a dozen posts per case, each some 50 D1 statements.
vi.setConfig({ testTimeout: 45_000 });

const send = async (email: string, path: string, method = "GET", body?: unknown) => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method,
    headers: { ...(await authHeaders(email)), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status).toBe(200);
  return response.json();
};

const ids = (body: unknown): string[] => {
  const parsed = schemaResult(z.array(z.object({ id: z.string() })))(body);
  if (parsed.isErr()) {
    throw new Error("timeline schema rejected");
  }
  return parsed.value.map((status) => status.id);
};

const post = async (email: string, status: string, visibility = "public"): Promise<string> => {
  const parsed = schemaResult(z.object({ id: z.string() }))(
    await send(email, "/api/v1/statuses", "POST", { status, visibility }),
  );
  if (parsed.isErr()) {
    throw new Error("status schema rejected");
  }
  return parsed.value.id;
};

/** Every page of `path` at `limit`, walked with `max_id`. */
const walk = async (email: string, path: string, limit: number): Promise<string[][]> => {
  const pages: string[][] = [];
  let maxId = "";
  for (;;) {
    const page = ids(await send(email, `${path}?limit=${limit}${maxId ? `&max_id=${maxId}` : ""}`));
    if (page.length === 0) {
      return pages;
    }
    pages.push(page);
    maxId = page[page.length - 1] ?? "";
  }
};

describe("timelines merged from several sources", () => {
  it("pages a list timeline across members in id order", async () => {
    const owner = "merge-list-owner@example.com";
    const members = ["merge-list-a@example.com", "merge-list-b@example.com"];
    const outsider = "merge-list-c@example.com";
    const memberIds: string[] = [];
    for (const member of members) {
      const account = await signedInAccount(member);
      memberIds.push(account.id);
      await send(owner, `/api/v1/accounts/${account.id}/follow`, "POST", {});
    }
    await signedInAccount(outsider);
    const list = schemaResult(z.object({ id: z.string() }))(
      await send(owner, "/api/v1/lists", "POST", { title: "Merge" }),
    );
    if (list.isErr()) {
      throw new Error("list schema rejected");
    }
    await send(owner, `/api/v1/lists/${list.value.id}/accounts`, "POST", {
      account_ids: memberIds,
    });

    // Three in a row by one member, then both in turn: one page of two comes
    // from a single member and another mixes both.
    const posted: string[] = [];
    for (const author of [members[0], members[0], members[0], members[1], members[0], members[1]]) {
      posted.push(await post(author ?? "", `merge ${posted.length}`));
    }
    await post(outsider, "not on the list");
    await post(members[1] ?? "", "direct to nobody", "direct");
    const newestFirst = [...posted].reverse();
    const path = `/api/v1/timelines/list/${list.value.id}`;

    expect(ids(await send(owner, path))).toEqual(newestFirst);
    expect((await walk(owner, path, 2)).flat()).toEqual(newestFirst);
    expect(ids(await send(owner, `${path}?limit=2&since_id=${posted[1]}`))).toEqual(
      newestFirst.slice(0, 2),
    );
    const fromOldest = ids(await send(owner, `${path}?limit=2&min_id=${posted[1]}`));
    expect([...fromOldest].sort().reverse()).toEqual([posted[3], posted[2]]);
  });

  it("pages the direct timeline across own notes and mentions in id order", async () => {
    const me = await signedInAccount("merge-direct-me@example.com");
    const a = await signedInAccount("merge-direct-a@example.com");
    const b = await signedInAccount("merge-direct-b@example.com");
    const mine = "merge-direct-me@example.com";
    const aEmail = "merge-direct-a@example.com";
    const bEmail = "merge-direct-b@example.com";

    const expected: string[] = [];
    expected.push(await post(mine, `@${a.username} one`, "direct"));
    expected.push(await post(aEmail, `@${me.username} two`, "direct"));
    await post(aEmail, `@${b.username} not to me`, "direct");
    await post(aEmail, `@${me.username} public, not direct`);
    expected.push(await post(bEmail, `@${me.username} @${a.username} three`, "direct"));
    expected.push(await post(mine, `@${b.username} four`, "direct"));
    expected.push(await post(mine, "five, to nobody", "direct"));
    expected.push(await post(bEmail, `@${me.username} six`, "direct"));
    const newestFirst = [...expected].reverse();

    expect(ids(await send(mine, "/api/v1/timelines/direct"))).toEqual(newestFirst);
    expect((await walk(mine, "/api/v1/timelines/direct", 2)).flat()).toEqual(newestFirst);
  });
});
