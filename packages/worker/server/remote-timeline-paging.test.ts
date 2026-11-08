import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const json = async (path: string, init?: RequestInit) => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  return { status: response.status, body: await response.json() };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const StatusesSchema = z.array(z.object({ id: z.string().min(1), uri: z.string().min(1) }));

const hashtagHtml = (tag: string): string =>
  `<a class="mention hashtag" rel="tag" href="https://example.com/tags/${tag}">#<span>${tag}</span></a>`;

/** A public note delivered to the inbox; resolves to its URI. */
const note = async (author: Remote, slug: string, tag?: string): Promise<string> => {
  const noteUri = `${new URL(author.actorUri).origin}/notes/${slug}`;
  expect(
    await author.send({
      id: `${noteUri}/activity`,
      type: "Create",
      object: {
        id: noteUri,
        type: "Note",
        attributedTo: author.actorUri,
        content: `<p>${slug} ${tag ? hashtagHtml(tag) : ""}</p>`,
        published: "2026-10-20T00:00:00.000Z",
        to: [PUBLIC],
        cc: [`${author.actorUri}/followers`],
      },
    }),
  ).toBe(202);
  return noteUri;
};

/** The URIs a timeline shows, in order. */
const uris = async (path: string, email?: string): Promise<string[]> => {
  const response = await json(path, email ? { headers: await authHeaders(email) } : {});
  expect(response.status).toBe(200);
  return read(StatusesSchema, response.body).map((status) => status.uri);
};

const postLocal = async (email: string, status: string): Promise<string> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ status }),
  });
  expect(response.status).toBe(200);
  return read(z.object({ uri: z.string().min(1) }), response.body).uri;
};

const viewerBlocksDomain = async (email: string, domain: string) =>
  expect(
    (
      await json("/api/v1/domain_blocks", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeaders(email)) },
        body: JSON.stringify({ domain }),
      })
    ).status,
  ).toBe(200);

const instanceBlocksDomain = async (domain: string, severity: "silence" | "suspend") =>
  expect(
    (
      await json("/api/v1/admin/domain_blocks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders("paging-admin@example.com", { admin: true })),
        },
        body: JSON.stringify({ domain, severity }),
      })
    ).status,
  ).toBe(200);

const acceptedFollow = async (email: string, remote: Remote, slug: string) => {
  const followed = await json(
    `/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/follow`,
    {
      method: "POST",
      headers: { ...(await authHeaders(email)), "content-type": "application/json" },
      body: "{}",
    },
  );
  expect(followed.status).toBe(200);
  const viewer = await signedInAccount(email);
  const row = await env.DB.prepare(
    "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
  )
    .bind(viewer.id, remote.actorUri)
    .first<{ follow_activity_id: string }>();
  expect(
    await remote.send({
      id: `${remote.actorUri}/accepts/${slug}`,
      type: "Accept",
      object: row?.follow_activity_id,
    }),
  ).toBe(202);
};

describe("remote statuses on public and tag pages", () => {
  const hiddenVariants = [
    {
      name: "a domain the viewer blocks",
      hide: async (email: string, domain: string) => viewerBlocksDomain(email, domain),
    },
    {
      name: "a domain the instance suspends",
      hide: async (_email: string, domain: string) => instanceBlocksDomain(domain, "suspend"),
    },
    {
      name: "a domain the instance silences",
      hide: async (_email: string, domain: string) => instanceBlocksDomain(domain, "silence"),
    },
  ] as const;

  for (const [index, variant] of hiddenVariants.entries()) {
    it(`fills a page of two past ${variant.name}`, async () => {
      const email = `paging-viewer-${index}@example.com`;
      const tag = `pagingtag${index}`;
      const good = await remoteActor(`good-${index}`, `good-${index}.example`);
      const hidden = await remoteActor(`hidden-${index}`, `Hidden-${index}.example`);
      const olderOne = await note(good, `older-one-${index}`, tag);
      const olderTwo = await note(good, `older-two-${index}`, tag);
      await note(hidden, `newer-one-${index}`, tag);
      await note(hidden, `newer-two-${index}`, tag);
      await variant.hide(email, `hidden-${index}.example`);

      const expected = [olderTwo, olderOne];
      for (const path of [
        "/api/v1/timelines/public?remote=true&limit=2",
        "/api/v1/timelines/public?limit=2",
        `/api/v1/timelines/tag/${tag}?limit=2`,
        `/api/v1/timelines/tag/${tag}?remote=true&limit=2`,
      ]) {
        expect(await uris(path, email), path).toEqual(expected);
      }
    });
  }

  it("pages the remote public timeline by id without repeating statuses", async () => {
    const author = await remoteActor("cursor-author", "cursor.example");
    const posted: string[] = [];
    for (const slug of ["a", "b", "c", "d", "e"]) {
      posted.push(await note(author, `cursor-${slug}`));
    }
    const newestFirst = posted.toReversed();

    const first = await uris("/api/v1/timelines/public?remote=true&limit=2");
    expect(first).toEqual(newestFirst.slice(0, 2));
    const ids = read(
      StatusesSchema,
      (await json("/api/v1/timelines/public?remote=true&limit=2")).body,
    );
    const second = await uris(
      `/api/v1/timelines/public?remote=true&limit=2&max_id=${ids[1]?.id ?? ""}`,
    );
    expect(second).toEqual(newestFirst.slice(2, 4));

    const all = read(
      StatusesSchema,
      (await json("/api/v1/timelines/public?remote=true&limit=5")).body,
    );
    const oldest = all[4]?.id ?? "";
    expect(await uris(`/api/v1/timelines/public?remote=true&limit=2&min_id=${oldest}`)).toEqual([
      newestFirst[3],
      newestFirst[2],
    ]);
    expect(
      await uris(`/api/v1/timelines/public?remote=true&limit=5&since_id=${all[2]?.id ?? ""}`),
    ).toEqual(newestFirst.slice(0, 2));
  });

  it("pages the merged local and remote public timeline without gaps or repeats", async () => {
    const email = "paging-merged@example.com";
    const author = await remoteActor("merged-author", "merged.example");
    const posted: string[] = [];
    posted.push(await note(author, "merged-r1"));
    posted.push(await postLocal(email, "merged l1"));
    posted.push(await note(author, "merged-r2"));
    posted.push(await postLocal(email, "merged l2"));
    posted.push(await note(author, "merged-r3"));
    const newestFirst = posted.toReversed();

    const seen: string[] = [];
    let maxId = "";
    for (let page = 0; page < 3; page += 1) {
      const response = await json(
        `/api/v1/timelines/public?limit=2${maxId ? `&max_id=${maxId}` : ""}`,
      );
      const statuses = read(StatusesSchema, response.body);
      seen.push(...statuses.map((status) => status.uri));
      maxId = statuses.at(-1)?.id ?? "";
    }
    expect(seen.slice(0, 5)).toEqual(newestFirst);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("home keeps silenced domains for followers", () => {
  it("still shows a silenced followee's post to its follower", async () => {
    const email = "paging-home@example.com";
    const followee = await remoteActor("silenced-followee", "silenced-home.example");
    await acceptedFollow(email, followee, "silenced-home");
    const uri = await note(followee, "silenced-home-note");
    await instanceBlocksDomain("silenced-home.example", "silence");

    expect(await uris("/api/v1/timelines/home", email)).toContain(uri);
    expect(await uris("/api/v1/timelines/public?remote=true", email)).not.toContain(uri);
  });
});
