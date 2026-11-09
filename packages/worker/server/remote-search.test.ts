import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiSearchResults } from "@tstodon/api";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { generateAccountKeys } from "./keys";

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

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** Stub outbound fetch for the duration of `run`, tracking the URLs seen. */
const withFetchStub = async (
  handler: (url: URL) => Response | undefined,
  run: () => Promise<void>,
): Promise<void> => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const stubbed = handler(new URL(href));
    if (stubbed) {
      return stubbed;
    }
    return original(input, init);
  };
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
        const resolved = await json("/api/v2/search?q=@remote@remote.example&resolve=true", {
          headers: await authHeaders("remote-search-resolver@example.com"),
        });
        expect(resolved.status).toBe(200);
        expect(
          read(ApiSearchResults, resolved.body).accounts.map((account) => account.acct),
        ).toContain("remote@remote.example");
        // The handle lookup confirms the handle; the actor fetch does not repeat it.
        expect(webfingerCalls).toBe(1);

        const cached = await json("/api/v2/search?q=remote@remote.example");
        expect(
          read(ApiSearchResults, cached.body).accounts.map((account) => account.acct),
        ).toContain("remote@remote.example");
      },
    );
    expect(webfingerCalls).toBe(1);
  });

  it("refuses to resolve without sign-in", async () => {
    let calls = 0;
    await withFetchStub(
      () => {
        calls += 1;
        return undefined;
      },
      async () => {
        for (const path of [
          "/api/v2/search?q=@anon@anon-resolve.example&resolve=true",
          "/api/v2/search?q=https://anon-resolve.example/users/anon&resolve=1&type=accounts",
        ]) {
          const refused = await json(path);
          expect(refused.status).toBe(401);
          expect(read(z.object({ error: z.string() }), refused.body).error).toBe(
            "Search queries that resolve remote resources are not supported without authentication",
          );
        }
        const v1 = await json("/api/v1/accounts/search?q=anon@anon-resolve.example&resolve=true");
        expect(v1.status).toBe(401);
        expect(
          (await json("/api/v2/search?q=@anon@anon-resolve.example&resolve=false")).status,
        ).toBe(200);
      },
    );
    expect(calls).toBe(0);
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
        expect(read(ApiSearchResults, response.body).accounts).toEqual([]);
      },
    );
    expect(calls).toBe(0);
  });
});
