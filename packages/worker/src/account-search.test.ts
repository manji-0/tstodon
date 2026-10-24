import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { MastodonAccountPreviewSchema } from "../test/mastodon-preview-schemas";

const auth = (email: string): Promise<Record<string, string>> => authHeaders(email);

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

const AccountListSchema = z.array(MastodonAccountPreviewSchema);

const credentials = async (
  email: string,
): Promise<z.infer<typeof MastodonAccountPreviewSchema>> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  return read(MastodonAccountPreviewSchema, response.body);
};

const search = async (
  email: string,
  query: string,
): Promise<z.infer<typeof MastodonAccountPreviewSchema>[]> => {
  const response = await json(`/api/v1/accounts/search?${query}`, {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  return read(AccountListSchema, response.body);
};

describe("account search", () => {
  it("finds a local account by username or display name", async () => {
    const viewer = "account-search-viewer@example.com";
    const target = await credentials("account-search-target@example.com");
    const display = "Searchable Person";

    const renamed = await json("/api/v1/accounts/update_credentials", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...(await auth("account-search-target@example.com")),
      },
      body: JSON.stringify({ display_name: display }),
    });
    expect(renamed.status).toBe(200);

    expect((await search(viewer, `q=${target.username}`)).map((account) => account.id)).toContain(
      target.id,
    );
    expect(
      (await search(viewer, `q=${encodeURIComponent("Searchable Person")}`)).map(
        (account) => account.id,
      ),
    ).toContain(target.id);
    // The endpoint requires a user token.
    expect((await json("/api/v1/accounts/search?q=any")).status).toBe(401);
  });

  it("pages results with limit and offset", async () => {
    const viewer = "account-search-pager@example.com";
    for (const name of ["pager-a", "pager-b", "pager-c"]) {
      await credentials(`${name}@example.com`);
    }

    const all = await search(viewer, "q=pager_");
    expect(all.length).toBe(3);
    const first = await search(viewer, "q=pager_&limit=1");
    expect(first.map((account) => account.id)).toEqual([all[0]?.id]);
    const second = await search(viewer, "q=pager_&limit=1&offset=1");
    expect(second.map((account) => account.id)).toEqual([all[1]?.id]);
  });

  it("keeps only followed accounts with following=true", async () => {
    const viewerEmail = "account-search-follower@example.com";
    const viewer = await credentials(viewerEmail);
    const followed = await credentials("account-search-followed@example.com");
    await credentials("account-search-not-followed@example.com");

    const follow = await json(`/api/v1/accounts/${followed.id}/follow`, {
      method: "POST",
      headers: await auth(viewerEmail),
    });
    expect(follow.status).toBe(200);

    const results = await search(viewerEmail, "q=account_search_&following=true");
    expect(results.map((account) => account.id)).toEqual([followed.id]);
    expect(viewer.id).not.toBe(followed.id);
    // Without the flag both matches come back.
    expect((await search(viewerEmail, "q=account_search_")).length).toBeGreaterThan(1);
  });

  it("answers 503 when a resolved address cannot be fetched", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (href.includes("webfinger") || href.includes("unreachable.example")) {
        return new Response("nope", { status: 503 });
      }
      return original(input as RequestInfo, init);
    }) as typeof fetch;
    try {
      const failed = await json(
        "/api/v1/accounts/search?q=%40someone%40unreachable.example&resolve=true",
        { headers: await auth("account-search-resolver@example.com") },
      );
      expect(failed.status).toBe(503);
      expect(read(z.object({ error: z.string() }), failed.body).error).toBe(
        "Remote data could not be fetched",
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("resolves a remote address through fetch options Workers accepts", async () => {
    const original = globalThis.fetch;
    const actor = "https://resolvable.example/users/far_away";
    const { publicKey } = await crypto.subtle
      .generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      )
      .then((pair) => ("publicKey" in pair ? pair : { publicKey: undefined }));
    if (!publicKey) {
      throw new Error("no key pair");
    }
    const spki = await crypto.subtle.exportKey("spki", publicKey);
    if (!(spki instanceof ArrayBuffer)) {
      throw new Error("no spki");
    }
    const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(spki)))}\n-----END PUBLIC KEY-----\n`;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      // Workers' fetch throws on `redirect: "error"`; mirror that here.
      if (init?.redirect === "error") {
        throw new TypeError("Invalid redirect value");
      }
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (href.startsWith("https://resolvable.example/.well-known/webfinger")) {
        return Response.json({
          subject: "acct:far_away@resolvable.example",
          links: [{ rel: "self", type: "application/activity+json", href: actor }],
        });
      }
      if (href === actor) {
        return Response.json({
          "@context": ["https://www.w3.org/ns/activitystreams"],
          id: actor,
          type: "Person",
          preferredUsername: "far_away",
          name: "Far Away",
          summary: "<p>Lives far &amp; away.</p><p>Second <b>line</b><script>x()</script></p>",
          url: "https://resolvable.example/@far_away",
          icon: { type: "Image", url: "https://resolvable.example/avatar.png" },
          manuallyApprovesFollowers: true,
          published: "2026-01-02T03:04:05.000Z",
          inbox: `${actor}/inbox`,
          outbox: `${actor}/outbox`,
          publicKey: { id: `${actor}#main-key`, owner: actor, publicKeyPem: pem },
        });
      }
      return original(input as RequestInfo, init);
    }) as typeof fetch;
    try {
      const results = await search(
        "account-search-remote-resolver@example.com",
        "q=%40far_away%40resolvable.example&resolve=true",
      );
      expect(results.map((account) => account.acct)).toEqual(["far_away@resolvable.example"]);
      const raw = await json("/api/v1/accounts/search?q=%40far_away%40resolvable.example", {
        headers: await auth("account-search-remote-resolver@example.com"),
      });
      const [profile] = read(
        z.array(
          z.object({
            note: z.string(),
            avatar: z.string(),
            url: z.string(),
            locked: z.boolean(),
            created_at: z.string(),
          }),
        ),
        raw.body,
      );
      // The bio is reduced to text, so the remote markup (and script) never renders.
      expect(profile?.note).toBe("<p>Lives far &amp; away.<br><br>Second linex()</p>");
      expect(profile?.avatar).toBe("https://resolvable.example/avatar.png");
      expect(profile?.url).toBe("https://resolvable.example/@far_away");
      expect(profile?.locked).toBe(true);
      expect(profile?.created_at).toBe("2026-01-02T03:04:05.000Z");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not resolve without resolve=true", async () => {
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls += 1;
      return original(input as RequestInfo, init);
    }) as typeof fetch;
    try {
      const results = await search(
        "account-search-no-resolve@example.com",
        "q=%40someone%40unknown.example",
      );
      expect(results).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toBe(0);
  });
});
