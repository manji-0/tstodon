import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus } from "@tstodon/api";
import { schemaResult } from "@tstodon/core";
import { accessTokenFor, authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const request = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://example.com${path}`, init);

const act = async (email: string, path: string, body: unknown = {}): Promise<void> => {
  const response = await request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status, path).toBe(200);
};

const post = async (email: string, body: Record<string, unknown>): Promise<string> => {
  const response = await request("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return read(ApiStatus, await response.json()).id;
};

const quote = (email: string, quotedId: string, visibility = "public") =>
  post(email, { status: `quoting from ${email}`, quoted_status_id: quotedId, visibility });

/** The id of the quote row of the quoting status `statusId`: what Mastodon pages by. */
const quoteIdOf = async (statusId: string): Promise<string> =>
  read(
    z.object({ id: z.string() }),
    await env.DB.prepare("SELECT id FROM status_quotes WHERE status_id = ? OR remote_status_id = ?")
      .bind(statusId, statusId)
      .first(),
  ).id;

/**
 * A remote note by `slug`'s actor on `host` that quotes `quotedId`, accepted:
 * public, followers-only, or direct to the local account `direct` names.
 */
const remoteQuote = async (
  slug: string,
  host: string,
  quotedId: string,
  audience: "public" | "followers" | Readonly<{ direct: string }> = "public",
) => {
  const actor = await remoteActor(slug, host);
  const uri = `https://${host}/notes/${slug}`;
  expect(
    await actor.send({
      id: `${uri}#create`,
      type: "Create",
      object: {
        id: uri,
        type: "Note",
        attributedTo: actor.actorUri,
        content: `<p>${slug}</p>`,
        published: new Date().toISOString(),
        ...(audience === "public"
          ? { to: [PUBLIC] }
          : audience === "followers"
            ? { to: [`${actor.actorUri}/followers`] }
            : {
                to: [`https://example.com/users/${audience.direct}`],
                tag: [{ type: "Mention", href: `https://example.com/users/${audience.direct}` }],
              }),
      },
    }),
  ).toBe(202);
  const statusId = read(
    z.object({ id: z.string() }),
    await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?").bind(uri).first(),
  ).id;
  await env.DB.prepare(
    `INSERT INTO status_quotes (id, remote_status_id, quoted_status_id, state, created_at, updated_at)
     VALUES (?, ?, ?, 'accepted', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
  )
    .bind(`${statusId}0`, statusId, quotedId)
    .run();
  return { statusId, accountId: RemoteAccountId.encode(actor.actorUri) };
};

/** The quotes `email` lists, with the response's `Link` header. */
const quotes = async (email: string, statusId: string, query = "") => {
  const response = await request(`/api/v1/statuses/${statusId}/quotes${query}`, {
    headers: await authHeaders(email),
  });
  expect(response.status).toBe(200);
  return {
    ids: read(z.array(ApiStatus), await response.json()).map((status) => status.id),
    link: response.headers.get("Link"),
  };
};

const silence = async (accountId: string): Promise<void> => {
  const response = await request(`/api/v1/admin/accounts/${accountId}/silence`, {
    method: "POST",
    headers: await authHeaders("quotes-list-admin@example.com", { admin: true }),
  });
  expect(response.status).toBe(200);
};

// Mastodon v4.7.5's `Api::V1::Statuses::QuotesController#index`.
describe("the quotes of a status", () => {
  it("needs a token with a read scope, for an account or only an app", async () => {
    const author = "quotes-list-scope@example.com";
    const original = await post(author, { status: "quote me" });
    const path = `/api/v1/statuses/${original}/quotes`;
    expect((await request(path)).status).toBe(401);
    // The status is sought first, so one the reader may not see is not found.
    const hidden = await post(author, { status: "followers only", visibility: "private" });
    expect((await request(`/api/v1/statuses/${hidden}/quotes`)).status).toBe(404);
    const writeOnly = await accessTokenFor((await signedInAccount(author)).id, ["write"]);
    expect(
      (await request(path, { headers: { Authorization: `Bearer ${writeOnly}` } })).status,
    ).toBe(403);
    for (const scopes of [["read"], ["read:statuses"]]) {
      const app = await accessTokenFor(undefined, scopes);
      expect((await request(path, { headers: { Authorization: `Bearer ${app}` } })).status).toBe(
        200,
      );
    }
  });

  it("leaves out authors the reader blocks, mutes, or is blocked by before the limit", async () => {
    const author = "quotes-list-excl-author@example.com";
    const reader = "quotes-list-excl-reader@example.com";
    const kept = "quotes-list-excl-kept@example.com";
    const blocked = "quotes-list-excl-blocked@example.com";
    const muted = "quotes-list-excl-muted@example.com";
    const blocker = "quotes-list-excl-blocker@example.com";
    const readerAccount = await signedInAccount(reader);
    const original = await post(author, { status: "quote me" });
    const keptQuote = await quote(kept, original);
    await quote(blocked, original);
    await quote(muted, original);
    await quote(blocker, original);
    const remote = await remoteQuote("quotes-list-excl-remote", "remote.example", original);
    await act(reader, `/api/v1/accounts/${(await signedInAccount(blocked)).id}/block`);
    await act(reader, `/api/v1/accounts/${(await signedInAccount(muted)).id}/mute`);
    await act(reader, `/api/v1/accounts/${remote.accountId}/block`);
    await act(blocker, `/api/v1/accounts/${readerAccount.id}/block`);

    expect((await quotes(reader, original)).ids).toEqual([keptQuote]);
    // The excluded quotes do not count toward the page, so one row fills it.
    const page = await quotes(reader, original, "?limit=1");
    expect(page.ids).toEqual([keptQuote]);
    expect(page.link).toContain('rel="next"');
    expect((await quotes(author, original)).ids).toHaveLength(5);
  });

  it("runs Mastodon's StatusFilter unless the reader wrote the quoted status", async () => {
    const author = "quotes-list-filter-author@example.com";
    const fan = "quotes-list-filter-fan@example.com";
    const stranger = "quotes-list-filter-other@example.com";
    const silenced = "quotes-list-filter-silenced@example.com";
    const silencedAccount = await signedInAccount(silenced);
    await signedInAccount(stranger);
    await act(fan, `/api/v1/accounts/${silencedAccount.id}/follow`);
    const original = await post(author, { status: "quote me" });
    const fromSilenced = await quote(silenced, original);
    const fromBlockedDomain = (
      await remoteQuote("quotes-list-filter-remote", "quote-blocked.example", original)
    ).statusId;
    await silence(silencedAccount.id);
    for (const reader of [author, stranger]) {
      await act(reader, "/api/v1/domain_blocks", { domain: "quote-blocked.example" });
    }

    // The quoted author skips the filter, its own domain block included.
    expect((await quotes(author, original)).ids.toSorted()).toEqual(
      [fromSilenced, fromBlockedDomain].toSorted(),
    );
    expect((await quotes(fan, original)).ids.toSorted()).toEqual(
      [fromSilenced, fromBlockedDomain].toSorted(),
    );
    expect((await quotes(stranger, original)).ids).toEqual([]);
  });

  // Mastodon's quoted author passes `StatusPolicy#show?` through the silent
  // mention each quote gives it (`Quote#ensure_quoted_access`); tstodon gives
  // none, so the quoted author sees only the quotes it may open (DM-11).
  it("leaves out for the quoted author a quote it may not see", async () => {
    const author = "quotes-list-hidden-author@example.com";
    const bob = "quotes-list-hidden-bob@example.com";
    const bobAccount = await signedInAccount(bob);
    const original = await post(author, { status: "quote me" });
    const shown = await quote("quotes-list-hidden-public@example.com", original);
    const hidden = [
      await quote("quotes-list-hidden-private@example.com", original, "private"),
      (await remoteQuote("quotes-list-hidden-followers", "remote.example", original, "followers"))
        .statusId,
      (
        await remoteQuote("quotes-list-hidden-direct", "remote.example", original, {
          direct: bobAccount.username,
        })
      ).statusId,
    ];

    expect((await quotes(author, original)).ids).toEqual([shown]);
    for (const id of hidden) {
      const response = await request(`/api/v1/statuses/${id}`, {
        headers: await authHeaders(author),
      });
      expect(response.status, id).toBe(404);
    }
    // Bob, whom the direct note addresses, may see it.
    expect((await quotes(bob, original)).ids).toContain(hidden[2]);
  });

  it("pages by quote id, with the next link from the page before the filter", async () => {
    const author = "quotes-list-page-author@example.com";
    const stranger = "quotes-list-page-other@example.com";
    const silenced = "quotes-list-page-silenced@example.com";
    const silencedAccount = await signedInAccount(silenced);
    const original = await post(author, { status: "quote me" });
    const older = await quote("quotes-list-page-quoter@example.com", original);
    const newer = await quote(silenced, original);
    await silence(silencedAccount.id);
    const [olderQuote, newerQuote] = [await quoteIdOf(older), await quoteIdOf(newer)];
    const base = `https://example.com/api/v1/statuses/${original}/quotes`;

    // The stranger's first page is filtered empty: a next link, no prev link.
    const first = await quotes(stranger, original, "?limit=1");
    expect(first).toEqual({
      ids: [],
      link: `<${base}?limit=1&max_id=${newerQuote}>; rel="next"`,
    });
    const second = await quotes(stranger, original, `?limit=1&max_id=${newerQuote}`);
    expect(second).toEqual({
      ids: [older],
      link: `<${base}?limit=1&max_id=${olderQuote}>; rel="next", <${base}?limit=1&since_id=${olderQuote}>; rel="prev"`,
    });
    expect((await quotes(author, original, `?since_id=${olderQuote}`)).ids).toEqual([newer]);
    // Mastodon pages this list by `max_id` and `since_id` only.
    expect((await quotes(author, original, `?min_id=${olderQuote}`)).ids).toEqual([newer, older]);
    // `limit_param`: `"-1".to_i.abs` is 1, and `"none".to_i` is an empty page.
    expect((await quotes(author, original, "?limit=-1")).ids).toEqual([newer]);
    expect(await quotes(author, original, "?limit=none")).toEqual({ ids: [], link: null });
  });
});
