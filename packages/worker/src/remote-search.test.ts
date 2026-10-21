import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import type { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { generateAccountKeys } from "./keys";
import { MastodonSearchPreviewSchema } from "../test/mastodon-preview-schemas";

const json = async (path: string): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`);
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

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** Stub outbound fetch for the duration of `run`, tracking the URLs seen. */
const withFetchStub = async (
  handler: (url: URL) => Response | undefined,
  run: () => Promise<void>,
): Promise<void> => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const stubbed = handler(new URL(href));
    if (stubbed) {
      return stubbed;
    }
    return original(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
};

describe("remote search resolution", () => {
  it("resolves a remote handle with resolve=true and caches it", async () => {
    const keys = await generateAccountKeys();
    const actorUri = "https://remote.example/users/remote";
    let webfingerCalls = 0;

    await withFetchStub(
      (url) => {
        if (url.href.startsWith("https://remote.example/.well-known/webfinger")) {
          webfingerCalls += 1;
          return jsonResponse({
            subject: "acct:remote@remote.example",
            links: [{ rel: "self", type: "application/activity+json", href: actorUri }],
          });
        }
        if (url.href === actorUri) {
          return jsonResponse({
            id: actorUri,
            type: "Person",
            preferredUsername: "remote",
            inbox: `${actorUri}/inbox`,
            publicKey: {
              id: `${actorUri}#main-key`,
              owner: actorUri,
              publicKeyPem: keys.publicKeyPem,
            },
            name: "Remote Person",
          });
        }
        return undefined;
      },
      async () => {
        const resolved = await json("/api/v2/search?q=@remote@remote.example&resolve=true");
        expect(resolved.status).toBe(200);
        expect(
          read(MastodonSearchPreviewSchema, resolved.body).accounts.map((account) => account.acct),
        ).toContain("remote@remote.example");

        const cached = await json("/api/v2/search?q=remote@remote.example");
        expect(
          read(MastodonSearchPreviewSchema, cached.body).accounts.map((account) => account.acct),
        ).toContain("remote@remote.example");
      },
    );
    expect(webfingerCalls).toBe(1);
  });

  it("does not fetch for a plain query", async () => {
    let calls = 0;
    await withFetchStub(
      () => {
        calls += 1;
        return undefined;
      },
      async () => {
        const response = await json("/api/v2/search?q=plainqueryxyz");
        expect(response.status).toBe(200);
        expect(read(MastodonSearchPreviewSchema, response.body).accounts).toEqual([]);
      },
    );
    expect(calls).toBe(0);
  });
});
