import { SELF, env } from "cloudflare:test";
import { IsoInstant, RemoteActor } from "@tstodon/domain";
import { nowIso } from "./clock";
import { generateAccountKeys } from "./keys";
import { parseInstanceIdentity } from "./runtime-config";
import { upsertRemoteActor } from "./remote-actor-store";
import { persistRemoteObject } from "./remote-status-persist";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { processLinkCardJob } from "./link-card";

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

const withFetchStub = async (
  handler: (url: URL) => Response | undefined,
  run: () => Promise<void>,
): Promise<number> => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls += 1;
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const stubbed = handler(new URL(href));
    return stubbed ?? original(input as RequestInfo, init);
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
        // The request only queues the unfurl, so the card is not there yet.
        const created = await postStatus(
          email,
          "please read https://news.example/story-one it is good",
        );
        expect(created.card).toBeNull();

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
      () => new Response("nope", { status: 500 }),
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
      () => new Response("nope", { status: 404, headers: { "content-type": "text/html" } }),
      async () => {
        const status = await postStatus(email, "dead link https://missing.example/gone");
        await unfurl(status.id, "https://missing.example/gone");
        expect(await statusCard(status.id)).toBeNull();
      },
    );
  });
});
