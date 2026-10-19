import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";

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

describe("link cards", () => {
  it("unfurls the first link, caches it, and renders the card", async () => {
    const email = "card-author@example.com";
    const calls = await withFetchStub(
      (url) =>
        url.hostname === "news.example"
          ? new Response(OG_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
          : undefined,
      async () => {
        const created = await postStatus(
          email,
          "please read https://news.example/story-one it is good",
        );
        expect(created.card?.title).toBe("A Fine Article");
        expect(created.card?.description).toBe("Plenty to say & more");
        expect(created.card?.provider_name).toBe("Example News");
        expect(created.card?.image).toBe("https://news.example/cover.jpg");

        // The card is stored on the status and served from the cache next time.
        const fetched = await json(`/api/v1/statuses/${created.id}`);
        expect(read(StatusSchema, fetched.body).card?.title).toBe("A Fine Article");

        const second = await postStatus(email, "same link again https://news.example/story-one");
        expect(second.card?.title).toBe("A Fine Article");
      },
    );
    // Once for the first post; the second and the refetch come from the cache.
    expect(calls).toBe(1);
  });

  it("does not reach into private hosts and leaves the card empty", async () => {
    const email = "card-private@example.com";
    const calls = await withFetchStub(
      () => new Response("nope", { status: 500 }),
      async () => {
        const status = await postStatus(email, "local link http://127.0.0.1:8080/secret");
        expect(status.card).toBeNull();
      },
    );
    expect(calls).toBe(0);
  });

  it("keeps the status when the link cannot be fetched", async () => {
    const email = "card-broken@example.com";
    await withFetchStub(
      () => new Response("nope", { status: 404, headers: { "content-type": "text/html" } }),
      async () => {
        const status = await postStatus(email, "dead link https://missing.example/gone");
        expect(status.card).toBeNull();
      },
    );
  });
});
