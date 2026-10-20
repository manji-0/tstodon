import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { generateAccountKeys } from "./keys";

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

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

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

describe("domain blocks", () => {
  it("blocks, lists, and unblocks a domain", async () => {
    const email = "domainblock-owner@example.com";
    expect((await json("/api/v1/domain_blocks")).status).toBe(401);

    const blocked = await json("/api/v1/domain_blocks", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ domain: "https://Spam.Example/@someone" }),
    });
    expect(blocked.status).toBe(200);

    const list = await json("/api/v1/domain_blocks", { headers: await auth(email) });
    expect(list.status).toBe(200);
    expect(read(z.array(z.string()), list.body)).toEqual(["spam.example"]);

    const own = await json("/api/v1/domain_blocks", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ domain: "example.com" }),
    });
    expect(own.status).toBe(422);

    const removed = await json("/api/v1/domain_blocks?domain=spam.example", {
      method: "DELETE",
      headers: await auth(email),
    });
    expect(removed.status).toBe(200);
    const after = await json("/api/v1/domain_blocks", { headers: await auth(email) });
    expect(read(z.array(z.string()), after.body)).toEqual([]);

    expect(
      (
        await json("/api/v1/domain_blocks?domain=nothing.example", {
          method: "DELETE",
          headers: await auth(email),
        })
      ).status,
    ).toBe(404);
  });

  it("reports domain_blocking for a remote account on a blocked domain", async () => {
    const email = "domainblock-viewer@example.com";
    const keys = await generateAccountKeys();
    const actorUri = "https://blocked.example/users/bob";
    let remoteId = "";

    await withFetchStub(
      (url) => {
        if (url.href.startsWith("https://blocked.example/.well-known/webfinger")) {
          return jsonResponse({
            subject: "acct:bob@blocked.example",
            links: [{ rel: "self", type: "application/activity+json", href: actorUri }],
          });
        }
        if (url.href === actorUri) {
          return jsonResponse({
            id: actorUri,
            type: "Person",
            preferredUsername: "bob",
            inbox: `${actorUri}/inbox`,
            publicKey: {
              id: `${actorUri}#main-key`,
              owner: actorUri,
              publicKeyPem: keys.publicKeyPem,
            },
            name: "Bob",
          });
        }
        return undefined;
      },
      async () => {
        const resolved = await json("/api/v2/search?q=@bob@blocked.example&resolve=true", {
          headers: await auth(email),
        });
        expect(resolved.status).toBe(200);
        remoteId =
          read(z.object({ accounts: z.array(z.object({ id: z.string().min(1) })) }), resolved.body)
            .accounts[0]?.id ?? "";
      },
    );
    expect(remoteId.startsWith("r_")).toBe(true);

    const relationship = async (): Promise<Record<string, unknown>> => {
      const response = await json(`/api/v1/accounts/relationships?id[]=${remoteId}`, {
        headers: await auth(email),
      });
      expect(response.status).toBe(200);
      return read(
        z
          .array(z.object({ id: z.string(), domain_blocking: z.boolean() }))
          .transform((rows) => rows[0] ?? {}),
        response.body,
      );
    };

    expect((await relationship()).domain_blocking).toBe(false);

    const blocked = await json("/api/v1/domain_blocks", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ domain: "blocked.example" }),
    });
    expect(blocked.status).toBe(200);
    expect((await relationship()).domain_blocking).toBe(true);
  });
});
