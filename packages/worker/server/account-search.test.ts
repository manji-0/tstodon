import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiAccount } from "@tstodon/api";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { localAccountPresentations, remoteAccountPresentations } from "./account-presentation";
import { searchAccountsPage } from "./account-search";
import { generateAccountKeys } from "./keys";
import { findRemoteActorsByUris } from "./remote-actor-store";

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

const AccountListSchema = z.array(ApiAccount);

const credentials = async (email: string): Promise<z.infer<typeof ApiAccount>> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  return read(ApiAccount, response.body);
};

const search = async (email: string, query: string): Promise<z.infer<typeof ApiAccount>[]> => {
  const response = await json(`/api/v1/accounts/search?${query}`, {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  return read(AccountListSchema, response.body);
};

const cacheRemoteActor = async (username: string, domain: string): Promise<void> => {
  const actorUri = `https://${domain}/users/${username}`;
  await env.DB.prepare(
    `INSERT INTO remote_actors (actor_uri, username, domain, inbox_uri, public_key_id, public_key_pem, display_name, fetched_at)
     VALUES (?, ?, ?, ?, ?, 'pem', ?, '2026-01-01T00:00:00.000Z')`,
  )
    .bind(actorUri, username, domain, `${actorUri}/inbox`, `${actorUri}#main-key`, username)
    .run();
};

const cacheRemoteActors = async (
  actors: ReadonlyArray<Readonly<{ username: string; domain: string; uriHost?: string }>>,
): Promise<void> => {
  await env.DB.batch(
    actors.map(({ username, domain, uriHost }) => {
      const actorUri = `https://${uriHost ?? domain}/users/${username}`;
      return env.DB.prepare(
        `INSERT INTO remote_actors (actor_uri, username, domain, inbox_uri, public_key_id, public_key_pem, display_name, fetched_at)
         VALUES (?, ?, ?, ?, ?, 'pem', ?, '2026-01-01T00:00:00.000Z')`,
      ).bind(actorUri, username, domain, `${actorUri}/inbox`, `${actorUri}#main-key`, username);
    }),
  );
};

/** The test `Env` with a D1 binding that counts the statements it prepares. */
const countingEnv = (): Readonly<{ env: Env; prepared: () => number }> => {
  let prepared = 0;
  const db: D1Database = {
    prepare: (query) => {
      prepared += 1;
      return env.DB.prepare(query);
    },
    batch: (statements) => env.DB.batch(statements),
    exec: (query) => env.DB.exec(query),
    withSession: (constraint) => env.DB.withSession(constraint),
    dump: () => env.DB.dump(),
  };
  return { env: { ...env, DB: db }, prepared: () => prepared };
};

const suspendDomain = async (domain: string): Promise<void> => {
  const blocked = await json("/api/v1/admin/domain_blocks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(await authHeaders("account-search-admin@example.com", { admin: true })),
    },
    body: JSON.stringify({ domain, severity: "suspend" }),
  });
  expect(blocked.status).toBe(200);
};

/**
 * Two local accounts and five cached remote actors match `prefix`; the two on
 * `<prefix>-b.example` sit between the others in the remote order and are
 * hidden by a domain suspension.
 */
const seedMixedResults = async (prefix: string): Promise<void> => {
  await credentials(`${prefix}-a@example.com`);
  await credentials(`${prefix}-b@example.com`);
  await cacheRemoteActor(`${prefix}_r1`, `${prefix}-c.example`);
  await cacheRemoteActor(`${prefix}_r2`, `${prefix}-c.example`);
  await cacheRemoteActor(`${prefix}_h1`, `${prefix}-b.example`);
  await cacheRemoteActor(`${prefix}_h2`, `${prefix}-b.example`);
  await cacheRemoteActor(`${prefix}_r3`, `${prefix}-a.example`);
  await suspendDomain(`${prefix}-b.example`);
};

/** The ids of pages of two fetched at offsets 0, 2, 4 and 6. */
const pagesOfTwo = async (
  fetchPage: (offset: number) => Promise<ReadonlyArray<{ id: string }>>,
): Promise<string[][]> => {
  const pages: string[][] = [];
  for (const offset of [0, 2, 4, 6]) {
    pages.push((await fetchPage(offset)).map((account) => account.id));
  }
  return pages;
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

  it("pages local accounts then cached remote actors without repeats or gaps", async () => {
    const viewer = "account-search-mixed-pager@example.com";
    await seedMixedResults("mixpage");

    const all = (await search(viewer, "q=mixpage&limit=40")).map((account) => account.id);
    expect(all.length).toBe(5);
    const pages = await pagesOfTwo(async (offset) =>
      search(viewer, `q=mixpage&limit=2&offset=${offset}`),
    );
    expect(pages.map((page) => page.length)).toEqual([2, 2, 1, 0]);
    expect(pages.flat()).toEqual(all);
  });

  it("fills a page past more hidden actors than one query reads", async () => {
    const viewer = "account-search-deep-pager@example.com";
    for (let index = 0; index < 45; index += 1) {
      await cacheRemoteActor(`deeppage_h${index}`, "deeppage-b.example");
    }
    for (const name of ["deeppage_r1", "deeppage_r2", "deeppage_r3"]) {
      await cacheRemoteActor(name, "deeppage-a.example");
    }
    await suspendDomain("deeppage-b.example");

    const first = await search(viewer, "q=deeppage&limit=2");
    const second = await search(viewer, "q=deeppage&limit=2&offset=2");
    expect([...first, ...second].map((account) => account.acct).sort()).toEqual([
      "deeppage_r1@deeppage-a.example",
      "deeppage_r2@deeppage-a.example",
      "deeppage_r3@deeppage-a.example",
    ]);
    expect(first.length).toBe(2);
  });

  it("answers an empty page for an offset past what SQLite can bind", async () => {
    const viewer = "account-search-huge-offset@example.com";
    await credentials("hugeoffset-a@example.com");
    const huge = "100000000000000000000";
    expect(await search(viewer, `q=hugeoffset&offset=${huge}`)).toEqual([]);
    const v2 = await json(`/api/v2/search?q=hugeoffset&type=accounts&offset=${huge}`, {
      headers: await auth(viewer),
    });
    expect(v2.status).toBe(200);
    expect(read(z.object({ accounts: AccountListSchema }), v2.body).accounts).toEqual([]);
  });

  it("pages accounts in /api/v2/search with type=accounts", async () => {
    const viewer = "account-search-v2-pager@example.com";
    await seedMixedResults("v2page");
    const v2 = async (query: string): Promise<{ id: string }[]> => {
      const response = await json(`/api/v2/search?${query}`, { headers: await auth(viewer) });
      expect(response.status).toBe(200);
      return read(z.object({ accounts: AccountListSchema }), response.body).accounts;
    };

    const all = (await v2("q=v2page&type=accounts&limit=40")).map((account) => account.id);
    expect(all.length).toBe(5);
    const pages = await pagesOfTwo(async (offset) =>
      v2(`q=v2page&type=accounts&limit=2&offset=${offset}`),
    );
    expect(pages.map((page) => page.length)).toEqual([2, 2, 1, 0]);
    expect(pages.flat()).toEqual(all);
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
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (href.includes("webfinger") || href.includes("unreachable.example")) {
        return new Response("nope", { status: 503 });
      }
      return original(input, init);
    };
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
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
      return original(input, init);
    };
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
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls += 1;
      return original(input, init);
    };
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

  it("reads a bounded number of D1 statements however many hidden actors match", async () => {
    await cacheRemoteActors(
      Array.from({ length: 300 }, (_, index) => ({
        username: `boundpage_h${index}`,
        domain: "boundpage-b.example",
      })),
    );
    await cacheRemoteActors(
      ["boundpage_r1", "boundpage_r2", "boundpage_r3"].map((username) => ({
        username,
        domain: "boundpage-a.example",
      })),
    );
    await suspendDomain("boundpage-b.example");
    const query = {
      localTerms: "boundpage",
      remoteTerms: "boundpage",
      scope: { kind: "Everyone" },
    } as const;

    const pages: string[] = [];
    for (const offset of [0, 2, 1_000_000_000]) {
      const counted = countingEnv();
      const page = await searchAccountsPage(counted.env, query, 2, offset);
      expect(page.isOk()).toBe(true);
      pages.push(...page._unsafeUnwrap().remote.map((actor) => actor.username));
      expect(counted.prepared()).toBeLessThanOrEqual(10);
    }
    expect(pages.sort()).toEqual(["boundpage_r1", "boundpage_r2", "boundpage_r3"]);
  });

  it("hides in its query exactly the accounts the presenter hides", async () => {
    const good = await credentials("pinsearch-good@example.com");
    const silenced = await credentials("pinsearch-silenced@example.com");
    const suspended = await credentials("pinsearch-suspended@example.com");
    const pending = await credentials("pinsearch-pending@example.com");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO account_moderation (account_id, moderation) VALUES (?, 'Silenced'), (?, 'Suspended')",
      ).bind(silenced.id, suspended.id),
      env.DB.prepare("INSERT INTO account_flags (account_id, pending) VALUES (?, 1)").bind(
        pending.id,
      ),
    ]);
    const remotes: ReadonlyArray<Readonly<{ username: string; domain: string; uriHost?: string }>> =
      [
        { username: "pinsearch_good", domain: "pinsearch-allowed.example" },
        { username: "pinsearch_port", domain: "pinsearch-allowed.example:8443" },
        { username: "pinsearch_silenced", domain: "pinsearch-allowed.example" },
        { username: "pinsearch_suspended", domain: "pinsearch-allowed.example" },
        { username: "pinsearch_blocked", domain: "pinsearch-blocked.example" },
        { username: "pinsearch_blockedport", domain: "PinSearch-Blocked.example:8443" },
        { username: "pinsearch_ipv6", domain: "[fd00::47]:8443" },
        { username: "pinsearch_stranger", domain: "pinsearch-stranger.example" },
        { username: "pinsearch_lookalike", domain: "pinsearch-allowed.example.evil" },
        {
          username: "pinsearch_splitsuspended",
          domain: "pinsearch-allowed.example",
          uriHost: "pinsearch-blocked.example",
        },
        {
          username: "pinsearch_splitstranger",
          domain: "pinsearch-allowed.example",
          uriHost: "pinsearch-stranger.example",
        },
      ];
    await cacheRemoteActors(remotes);
    const uriOf = (username: string): string => {
      const remote = remotes.find((candidate) => candidate.username === username);
      return `https://${remote?.uriHost ?? remote?.domain ?? ""}/users/${username}`;
    };
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO remote_actor_moderation (actor_uri, moderation) VALUES (?, 'Silenced'), (?, 'Suspended')",
      ).bind(uriOf("pinsearch_silenced"), uriOf("pinsearch_suspended")),
      env.DB.prepare(
        "INSERT INTO domain_blocks (id, domain, severity) VALUES ('pinsearch-1', 'pinsearch-blocked.example', 'suspend'), ('pinsearch-2', '[fd00::47]', 'suspend')",
      ),
    ]);
    // Allow-list mode: only these domains federate.
    const allowDomains = ["pinsearch-allowed.example", "pinsearch-blocked.example", "[fd00::47]"];
    await env.DB.batch(
      allowDomains.map((domain) =>
        env.DB.prepare(
          "INSERT INTO domain_allows (id, domain, created_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')",
        ).bind(`pinsearch-allow-${domain}`, domain),
      ),
    );
    try {
      const query = {
        localTerms: "pinsearch",
        remoteTerms: "pinsearch",
        scope: { kind: "Everyone" },
      } as const;
      // One account per page: a row the query keeps but the presenter drops
      // leaves a page empty before the end.
      const local: string[] = [];
      const remote: string[] = [];
      for (let offset = 0; offset < 20; offset += 1) {
        const page = (await searchAccountsPage(env, query, 1, offset))._unsafeUnwrap();
        local.push(...page.local.map((account) => account.id));
        remote.push(...page.remote.map((actor) => actor.actorUri));
        if (page.local.length + page.remote.length === 0) {
          break;
        }
      }

      const localPresented = (
        await localAccountPresentations(env.DB, [good.id, silenced.id, suspended.id])
      )._unsafeUnwrap();
      expect(local).toEqual(
        [good.id, silenced.id, suspended.id].filter(
          (id) => localPresented.get(id)?.kind === "Shown",
        ),
      );
      expect(local).not.toContain(pending.id);

      const actors = (
        await findRemoteActorsByUris(
          env.DB,
          remotes.map((candidate) => uriOf(candidate.username)),
        )
      )._unsafeUnwrap();
      const remotePresented = (
        await remoteAccountPresentations(env, [...actors.values()])
      )._unsafeUnwrap();
      const shownRemote = [...remotePresented]
        .filter(([, presentation]) => presentation.kind === "Shown")
        .map(([actorUri]) => actorUri);
      expect([...remote].sort()).toEqual([...shownRemote].sort());
      expect([...remote].sort()).toEqual(
        [uriOf("pinsearch_good"), uriOf("pinsearch_port"), uriOf("pinsearch_silenced")].sort(),
      );
      expect(remote.length).toBe(new Set(remote).size);
    } finally {
      await env.DB.prepare("DELETE FROM domain_allows WHERE id LIKE 'pinsearch-allow-%'").run();
    }
  });

  it("refuses offset without sign-in in /api/v2/search", async () => {
    const anonymous = await json("/api/v2/search?q=anything&type=accounts&offset=1000000000");
    expect(anonymous.status).toBe(401);
    expect(read(z.object({ error: z.string() }), anonymous.body).error).toBe(
      "Search queries pagination is not supported without authentication",
    );
    // A blank offset is no pagination, as Mastodon's `present?`.
    expect((await json("/api/v2/search?q=anything&type=accounts&offset=")).status).toBe(200);
  });

  it("ignores offset in /api/v2/search when type is blank", async () => {
    const viewer = "account-search-blank-type@example.com";
    await seedMixedResults("blanktype");
    const v2 = async (query: string): Promise<string[]> => {
      const response = await json(`/api/v2/search?${query}`, { headers: await auth(viewer) });
      expect(response.status).toBe(200);
      return read(z.object({ accounts: AccountListSchema }), response.body).accounts.map(
        (account) => account.id,
      );
    };
    expect(await v2("q=blanktype&type=&limit=2&offset=2")).toEqual(await v2("q=blanktype&limit=2"));
  });

  it("counts the resolved account inside limit and lists it first in /api/v2/search", async () => {
    const viewer = "account-search-v2-resolver@example.com";
    await cacheRemoteActor("l2a_pick", "l2res.example");
    await cacheRemoteActor("l2b_pick", "l2res.example");
    const actor = "https://l2res.example/users/pick";
    const { publicKeyPem } = await generateAccountKeys();
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (href.startsWith("https://l2res.example/.well-known/webfinger")) {
        return Response.json({
          subject: "acct:pick@l2res.example",
          links: [{ rel: "self", type: "application/activity+json", href: actor }],
        });
      }
      if (href === actor) {
        return Response.json({
          id: actor,
          type: "Person",
          preferredUsername: "pick",
          inbox: `${actor}/inbox`,
          publicKey: { id: `${actor}#main-key`, owner: actor, publicKeyPem },
        });
      }
      return original(input, init);
    };
    try {
      const response = await json(
        "/api/v2/search?q=pick%40l2res.example&type=accounts&resolve=true&limit=2",
        { headers: await auth(viewer) },
      );
      expect(response.status).toBe(200);
      const accounts = read(z.object({ accounts: AccountListSchema }), response.body).accounts;
      expect(accounts[0]?.acct).toBe("pick@l2res.example");
      expect(accounts.length).toBeLessThanOrEqual(2);
    } finally {
      globalThis.fetch = original;
    }
  });
});
