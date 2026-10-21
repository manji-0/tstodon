import { SELF, env } from "cloudflare:test";
import { IsoInstant, RemoteActor } from "@tstodon/domain";
import { nowIso } from "./clock";
import { generateAccountKeys } from "./keys";
import { parseInstanceIdentity } from "./runtime-config";
import { upsertRemoteActor } from "./remote-actor-store";
import { persistRemoteObject } from "./remote-status-persist";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { cacheLinkCard, processLinkCardJob } from "./link-card";
import { processOutboxJob } from "./outbox-job";

const auth = (email: string): Promise<Record<string, string>> => accessAuthHeaders(email);

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

const CardSchema = z.object({
  url: z.string().min(1),
  title: z.string(),
  description: z.string(),
  type: z.string().min(1),
  provider_name: z.string(),
  provider_url: z.string(),
  image: z.string().nullable(),
});

const StatusSchema = z.object({ id: z.string().min(1), card: CardSchema.nullable() });

const OG_HTML = `<!doctype html><html><head>
<meta property="og:title" content="A Fine Article" />
<meta property="og:description" content="Plenty to say &amp; more" />
<meta property="og:site_name" content="Example News" />
<meta property="og:image" content="/cover.jpg" />
<title>ignored</title></head><body>hi</body></html>`;

/**
 * Install a fetch stub for one test. Only the calls the handler answers are
 * counted, and anything else falls through to the real fetch, so another test
 * file running in this isolate cannot skew the count.
 */
const withFetchStub = async (
  handler: (url: URL) => Response | undefined,
  run: () => Promise<unknown>,
): Promise<number> => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const stubbed = handler(new URL(href));
    if (stubbed) {
      calls += 1;
      return stubbed;
    }
    return original(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
  return calls;
};

const postStatus = async (email: string, status: string): Promise<z.infer<typeof StatusSchema>> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify({ status }),
  });
  expect(response.status).toBe(200);
  return read(StatusSchema, response.body);
};

const statusCard = async (statusId: string): Promise<z.infer<typeof CardSchema> | null> => {
  const response = await json(`/api/v1/statuses/${statusId}`);
  expect(response.status).toBe(200);
  return read(StatusSchema, response.body).card;
};

const unfurl = (statusId: string, url: string) =>
  processLinkCardJob(env, { kind: "ProcessLinkCard", target: "Status", id: statusId, url });

describe("link cards", () => {
  it("unfurls through the queue job, caches it, and renders the card", async () => {
    const email = "card-author@example.com";
    const calls = await withFetchStub(
      (url) =>
        url.hostname === "news.example"
          ? new Response(OG_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
          : undefined,
      async () => {
        // The request only queues the unfurl. The queue consumer may finish it
        // before the response is rendered, so the card is checked after the job.
        const created = await postStatus(
          email,
          "please read https://news.example/story-one it is good",
        );

        await unfurl(created.id, "https://news.example/story-one");
        const card = await statusCard(created.id);
        expect(card?.title).toBe("A Fine Article");
        expect(card?.description).toBe("Plenty to say & more");
        expect(card?.provider_name).toBe("Example News");
        expect(card?.image).toBe("https://news.example/cover.jpg");

        // The URL is cached, so another post of the same link is unfurled
        // without another fetch.
        const second = await postStatus(email, "same link again https://news.example/story-one");
        await unfurl(second.id, "https://news.example/story-one");
        expect((await statusCard(second.id))?.title).toBe("A Fine Article");
      },
    );
    expect(calls).toBe(1);
  });

  it("does not reach into private hosts", async () => {
    const email = "card-private@example.com";
    const calls = await withFetchStub(
      (url) => (url.hostname === "127.0.0.1" ? new Response("nope", { status: 500 }) : undefined),
      async () => {
        const status = await postStatus(email, "local link http://127.0.0.1:8080/secret");
        await unfurl(status.id, "http://127.0.0.1:8080/secret");
        expect(await statusCard(status.id)).toBeNull();
      },
    );
    expect(calls).toBe(0);
  });

  it("unfurls a remote status and renders its card on the public timeline", async () => {
    const keys = await generateAccountKeys();
    const fetchedAt = IsoInstant.parse(nowIso());
    if (fetchedAt.isErr()) {
      throw new Error("clock");
    }
    const actorUri = "https://card-remote.example/users/erin";
    const actor = RemoteActor.fromFetched({
      actorUri,
      username: "erin",
      domain: "card-remote.example",
      inboxUri: `${actorUri}/inbox`,
      publicKeyId: `${actorUri}#main-key`,
      publicKeyPem: keys.publicKeyPem,
      displayName: "erin",
      fetchedAt: fetchedAt.value,
    });
    if (actor.isErr()) {
      throw new Error("actor fixture rejected");
    }
    await upsertRemoteActor(env.DB, actor.value);
    const identity = parseInstanceIdentity(env);
    if (identity.isErr()) {
      throw new Error("identity");
    }
    const persisted = await persistRemoteObject(env, identity.value, actor.value, {
      id: `${actorUri}/statuses/1`,
      type: "Note",
      attributedTo: actorUri,
      content: '<p>reading <a href="https://news.example/story-remote">this</a></p>',
      published: new Date().toISOString(),
      to: ["https://www.w3.org/ns/activitystreams#Public"],
    });
    expect(persisted.isOk()).toBe(true);
    const remoteId = persisted.isOk() && persisted.value ? persisted.value.id : "";
    expect(remoteId.length).toBeGreaterThan(0);

    await withFetchStub(
      (url) =>
        url.hostname === "news.example"
          ? new Response(OG_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
          : undefined,
      async () => {
        await processLinkCardJob(env, {
          kind: "ProcessLinkCard",
          target: "RemoteStatus",
          id: remoteId,
          url: "https://news.example/story-remote",
        });
      },
    );

    const timeline = await json("/api/v1/timelines/public");
    const status = read(
      z.array(z.object({ id: z.string(), card: CardSchema.nullable() })),
      timeline.body,
    ).find((entry) => entry.id === remoteId);
    expect(status?.card?.title).toBe("A Fine Article");
  });

  it("keeps the status when the link cannot be fetched", async () => {
    const email = "card-broken@example.com";
    await withFetchStub(
      (url) =>
        url.hostname === "missing.example"
          ? new Response("nope", { status: 404, headers: { "content-type": "text/html" } })
          : undefined,
      async () => {
        const status = await postStatus(email, "dead link https://missing.example/gone");
        await unfurl(status.id, "https://missing.example/gone");
        expect(await statusCard(status.id)).toBeNull();
      },
    );
  });

  it("refreshes a preview older than a week", async () => {
    const email = "card-ttl@example.com";
    const url = "https://news.example/story-ttl";
    let title = "First Title";
    // The title is the assertion, not the fetch count: a delayed queue
    // delivery may unfurl the same link again, which is harmless.
    const stub = (target: URL) =>
      target.hostname === "news.example"
        ? new Response(`<meta property="og:title" content="${title}" />`, {
            headers: { "content-type": "text/html" },
          })
        : undefined;

    const first = await postStatus(email, `ttl link ${url}`);
    await withFetchStub(stub, () => unfurl(first.id, url));
    expect((await statusCard(first.id))?.title).toBe("First Title");

    // Age the cache past its TTL, then change what the origin serves.
    const aged = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare("UPDATE link_cards SET fetched_at = ? WHERE url = ?")
      .bind(aged, url)
      .run();
    title = "Second Title";
    const second = await postStatus(email, `ttl link again ${url}`);
    await withFetchStub(stub, () => unfurl(second.id, url));
    expect((await statusCard(second.id))?.title).toBe("Second Title");

    // Within the TTL the cache is served: the origin would say something else.
    title = "Third Title";
    const third = await postStatus(email, `ttl link third ${url}`);
    await withFetchStub(stub, () => unfurl(third.id, url));
    expect((await statusCard(third.id))?.title).toBe("Second Title");
  });

  it("refreshes stale previews from cron and keeps the card when it fails", async () => {
    const url = "https://cron.example/story";
    const seeded = await cacheLinkCard(env.DB, url, {
      url,
      title: "Old Title",
      description: "",
      providerName: "cron.example",
      providerUrl: "https://cron.example",
      authorName: "",
      authorUrl: "",
      image: null,
      type: "link",
    });
    expect(seeded.isOk()).toBe(true);
    const aged = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare("UPDATE link_cards SET fetched_at = ? WHERE url = ?")
      .bind(aged, url)
      .run();

    const calls = await withFetchStub(
      (url) =>
        url.hostname === "cron.example"
          ? new Response('<meta property="og:title" content="Fresh Title" />', {
              headers: { "content-type": "text/html" },
            })
          : undefined,
      async () => {
        expect(await processOutboxJob(env, { kind: "RefreshLinkCards" })).toBe("ok");
      },
    );
    expect(calls).toBe(1);
    const refreshed = await env.DB.prepare("SELECT card_json FROM link_cards WHERE url = ?")
      .bind(url)
      .first<{ card_json: string }>();
    expect(refreshed?.card_json).toContain("Fresh Title");

    // A failing refresh leaves the (now stale again) card in place.
    await env.DB.prepare("UPDATE link_cards SET fetched_at = ? WHERE url = ?")
      .bind(aged, url)
      .run();
    await withFetchStub(
      (url) =>
        url.hostname === "cron.example"
          ? new Response("boom", { status: 503, headers: { "content-type": "text/html" } })
          : undefined,
      async () => {
        expect(await processOutboxJob(env, { kind: "RefreshLinkCards" })).toBe("ok");
      },
    );
    const kept = await env.DB.prepare("SELECT card_json FROM link_cards WHERE url = ?")
      .bind(url)
      .first<{ card_json: string }>();
    expect(kept?.card_json).toContain("Fresh Title");
  });

  it("distinguishes transient failures from settled ones", async () => {
    const email = "card-outcomes@example.com";
    const status = await postStatus(email, "outcome link https://outcome.example/page");

    // A 404 is settled: retrying would never help.
    await withFetchStub(
      (url) =>
        url.hostname === "outcome.example"
          ? new Response("gone", { status: 404, headers: { "content-type": "text/html" } })
          : undefined,
      async () => {
        expect(
          await processLinkCardJob(env, {
            kind: "ProcessLinkCard",
            target: "Status",
            id: status.id,
            url: "https://outcome.example/page",
          }),
        ).toBe("ok");
      },
    );

    // A 500 (or a thrown fetch) asks the queue to try again.
    await withFetchStub(
      (url) =>
        url.hostname === "outcome.example"
          ? new Response("boom", { status: 500, headers: { "content-type": "text/html" } })
          : undefined,
      async () => {
        expect(
          await processLinkCardJob(env, {
            kind: "ProcessLinkCard",
            target: "Status",
            id: status.id,
            url: "https://outcome.example/retry",
          }),
        ).toBe("retry");
      },
    );
    await withFetchStub(
      () => undefined,
      async () => {
        const original = globalThis.fetch;
        globalThis.fetch = (async () => {
          throw new Error("network down");
        }) as typeof fetch;
        try {
          expect(
            await processLinkCardJob(env, {
              kind: "ProcessLinkCard",
              target: "Status",
              id: status.id,
              url: "https://outcome.example/down",
            }),
          ).toBe("retry");
        } finally {
          globalThis.fetch = original;
        }
      },
    );
    // A refused host is settled rather than retried.
    expect(
      await processLinkCardJob(env, {
        kind: "ProcessLinkCard",
        target: "Status",
        id: status.id,
        url: "http://127.0.0.1:9/private",
      }),
    ).toBe("ok");
  });
});
