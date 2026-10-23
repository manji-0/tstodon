import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { cacheLinkCard, processLinkCardJob } from "./link-card";

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

const TimelineSchema = z.array(
  z.object({ id: z.string().min(1), card: z.object({ url: z.string() }).nullable() }),
);

const postStatus = async (
  email: string,
  status: string,
  visibility: "public" | "unlisted" = "public",
): Promise<string> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ status, visibility }),
  });
  expect(response.status).toBe(200);
  return read(z.object({ id: z.string().min(1) }), response.body).id;
};

/** Seed the cached preview so the queue job stores the card without a fetch. */
const seedCard = async (url: string): Promise<void> => {
  const cached = await cacheLinkCard(env.DB, url, {
    url,
    title: "Linked",
    description: "",
    providerName: new URL(url).hostname,
    providerUrl: `https://${new URL(url).hostname}`,
    authorName: "",
    authorUrl: "",
    image: null,
    type: "link",
  });
  expect(cached.isOk()).toBe(true);
};

const linkTimeline = (url: string, query = ""): Promise<{ status: number; body: unknown }> =>
  json(`/api/v1/timelines/link?url=${encodeURIComponent(url)}${query}`);

describe("link timeline", () => {
  it("lists public statuses carrying a trending link's card", async () => {
    const url = "https://linked.example/story";
    await seedCard(url);
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const id = await postStatus("link-tl@example.com", `take ${n} ${url}`);
      expect(
        await processLinkCardJob(env, { kind: "ProcessLinkCard", target: "Status", id, url }),
      ).toBe("ok");
      ids.push(id);
    }
    const unlisted = await postStatus("link-tl@example.com", `quiet ${url}`, "unlisted");
    await processLinkCardJob(env, { kind: "ProcessLinkCard", target: "Status", id: unlisted, url });

    const actorUri = "https://remote-link.example/users/sharer";
    await env.DB.prepare(
      `INSERT INTO remote_actors (actor_uri, username, domain, inbox_uri, public_key_id, public_key_pem, display_name, fetched_at)
       VALUES (?, 'sharer', 'remote-link.example', ?, ?, 'pem', 'Sharer', '2026-01-01T00:00:00.000Z')`,
    )
      .bind(actorUri, `${actorUri}/inbox`, `${actorUri}#main-key`)
      .run();
    await env.DB.prepare(
      `INSERT INTO remote_statuses (id, actor_uri, object_uri, content_html, visibility, published_at)
       VALUES ('link-remote', ?, ?, ?, 'public', '2026-01-01T00:00:00.000Z')`,
    )
      .bind(actorUri, `${actorUri}/statuses/1`, `<p><a href="${url}">${url}</a></p>`)
      .run();
    expect(
      await processLinkCardJob(env, {
        kind: "ProcessLinkCard",
        target: "RemoteStatus",
        id: "link-remote",
        url,
      }),
    ).toBe("ok");

    const all = await linkTimeline(url);
    expect(all.status).toBe(200);
    const statuses = read(TimelineSchema, all.body);
    const returned = statuses.map((status) => status.id);
    expect(returned).toEqual(expect.arrayContaining([...ids, "link-remote"]));
    expect(returned).not.toContain(unlisted);
    expect(statuses.every((status) => status.card?.url === url)).toBe(true);

    const local = returned.filter((id) => ids.includes(id));
    expect(local).toEqual(ids.toReversed());

    const page = read(
      TimelineSchema,
      (await linkTimeline(url, `&limit=1&max_id=${ids[2]}`)).body,
    ).map((status) => status.id);
    expect(page).toHaveLength(1);
    expect(page).not.toContain(ids[2]);

    const authed = await json(`/api/v1/timelines/link?url=${encodeURIComponent(url)}`, {
      headers: await authHeaders("link-tl-viewer@example.com"),
    });
    expect(authed.status).toBe(200);
  });

  it("answers 404 for a link that is not trending or was rejected", async () => {
    expect((await linkTimeline("https://never-posted.example/")).status).toBe(404);
    expect((await json("/api/v1/timelines/link")).status).toBe(404);

    const url = "https://rejected-link.example/post";
    await seedCard(url);
    const id = await postStatus("link-rejected@example.com", `look ${url}`);
    await processLinkCardJob(env, { kind: "ProcessLinkCard", target: "Status", id, url });
    expect((await linkTimeline(url)).status).toBe(200);

    const rejected = await json(`/api/v1/admin/trends/links/${encodeURIComponent(url)}/reject`, {
      method: "POST",
      headers: await authHeaders("link-admin@example.com", { admin: true }),
    });
    expect(rejected.status).toBe(200);
    expect((await linkTimeline(url)).status).toBe(404);
  });
});
