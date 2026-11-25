import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { ApiAccount, ApiSearchResults, ApiStatus } from "@tstodon/api";
import { IsoInstant, RemoteStatus, StatusId } from "@tstodon/domain";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { entityIdAt } from "./ids";
import { processOutboxJob } from "./outbox-job";
import { upsertRemoteStatus } from "./remote-status-store";
import { reindexStaleAuthors } from "./status-search-documents";

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
};

const accountOf = async (email: string) => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await authHeaders(email),
  });
  expect(response.status).toBe(200);
  return expectContract(ApiAccount, response.body);
};

const send = async (
  email: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> => {
  const response = await json(path, {
    method,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status, `${method} ${path}`).toBe(200);
  return response.body;
};

const post = async (
  email: string,
  status: string,
  visibility: "public" | "unlisted" | "private" | "direct" = "public",
  extra: Record<string, unknown> = {},
): Promise<string> =>
  expectContract(
    ApiStatus,
    await send(email, "POST", "/api/v1/statuses", { status, visibility, ...extra }),
  ).id;

const act = async (email: string, path: string): Promise<void> => {
  await send(email, "POST", path);
};

/** The ids of the statuses `/api/v2/search` finds for `email`, its response checked against the contract. */
const found = async (email: string | undefined, query: string): Promise<string[]> => {
  const limit = query.includes("limit=") ? "" : "limit=40&";
  const response = await json(`/api/v2/search?type=statuses&${limit}${query}`, {
    headers: email === undefined ? {} : await authHeaders(email),
  });
  expect(response.status).toBe(200);
  return expectContract(ApiSearchResults, response.body).statuses.map((status) => status.id);
};

const q = (text: string): string => `q=${encodeURIComponent(text)}`;

const remoteNote = (actorUri: string, path: string, contentHtml: string, at: string) => {
  const status = RemoteStatus.fromFetched({
    id: StatusId.parse(entityIdAt(Date.parse(at)))._unsafeUnwrap(),
    actorUri,
    objectUri: `${actorUri}/statuses/${path}`,
    contentHtml,
    spoilerText: "",
    visibility: { kind: "Public" },
    sensitive: false,
    language: { kind: "None" },
    publishedAt: IsoInstant.parse(at)._unsafeUnwrap(),
  });
  return status._unsafeUnwrap();
};

const setRemoteIndexable = async (actorUri: string, indexable: boolean): Promise<void> => {
  await env.DB.prepare(
    "UPDATE remote_actors SET profile_json = json_set(profile_json, '$.indexable', json(?)) WHERE actor_uri = ?",
  )
    .bind(indexable ? "true" : "false", actorUri)
    .run();
};

/** Run the search index's job until no author whose `indexable` changed waits. */
const reindex = async (): Promise<void> => {
  for (let page = 0; page < 50; page += 1) {
    expect(await processOutboxJob(env, { kind: "BackfillStatusSearch" })).toBe("ok");
    const waiting = await env.DB.prepare(
      "SELECT count(*) AS n FROM status_search_stale_authors",
    ).first("n");
    if (waiting === 0) {
      return;
    }
  }
  throw new Error("the stale authors were not reindexed");
};

describe("status search", () => {
  it("pages statuses with offset, counting only the ones the viewer may see", async () => {
    const viewer = "status-search-pager@example.com";
    const author = "status-search-author@example.com";
    const stranger = "status-search-stranger@example.com";
    const blocked = "status-search-blocked@example.com";
    await accountOf(viewer);
    const blockedAccount = await accountOf(blocked);
    await act(viewer, `/api/v1/accounts/${blockedAccount.id}/block`);
    // Hidden matches sit between the visible ones, newest first.
    const visible: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      visible.push(await post(author, `pagedstatusq visible ${index}`));
      await post(stranger, `pagedstatusq followers only ${index}`, "private");
      await post(blocked, `pagedstatusq blocked ${index}`);
    }
    await post(stranger, "pagedstatusq direct to nobody", "direct");

    const pages = [];
    for (const offset of [0, 2, 4, 6]) {
      pages.push(await found(viewer, `q=pagedstatusq&limit=2&offset=${offset}`));
    }
    expect(pages).toEqual([[visible[4], visible[3]], [visible[2], visible[1]], [visible[0]], []]);
  });

  // `StatusesIndex` holds a note for its local author and the local accounts
  // it mentions or that favourite, boost, bookmark it or vote in its poll;
  // `PublicStatusesIndex` holds public notes. A followers-only note the
  // viewer may read but never touched is in neither.
  it("finds the viewer's library and public notes, not every note it may read", async () => {
    const viewer = "status-search-insider@example.com";
    const friend = "status-search-friend@example.com";
    const viewerAccount = await accountOf(viewer);
    const friendAccount = await accountOf(friend);
    await act(viewer, `/api/v1/accounts/${friendAccount.id}/follow`);
    const untouched = await post(friend, "insiderstatusq followers only", "private");
    const unlisted = await post(friend, "insiderstatusq unlisted", "unlisted");
    const bookmarked = await post(friend, "insiderstatusq bookmarked", "private");
    const favourited = await post(friend, "insiderstatusq favourited", "unlisted");
    await act(viewer, `/api/v1/statuses/${bookmarked}/bookmark`);
    await act(viewer, `/api/v1/statuses/${favourited}/favourite`);
    const library = [
      bookmarked,
      favourited,
      await post(friend, `insiderstatusq @${viewerAccount.username} direct`, "direct"),
      await post(viewer, "insiderstatusq my own followers only", "private"),
    ];
    const results = await found(viewer, q("insiderstatusq"));
    expect(results.toSorted()).toEqual(library.toSorted());
    expect(results).not.toContain(untouched);
    expect(results).not.toContain(unlisted);

    expect(await found(viewer, q("insiderstatusq in:public"))).toEqual([]);
    await act(viewer, `/api/v1/statuses/${favourited}/unfavourite`);
    expect(await found(viewer, q("insiderstatusq favourited"))).toEqual([]);
    expect(await found("status-search-outsider@example.com", q("insiderstatusq"))).toEqual([]);
  });

  // `status_searchable?` requires a signed-in account.
  it("finds no status for an anonymous caller", async () => {
    const id = await post("status-search-anon-author@example.com", "anonymousstatusq public");
    expect(await found("status-search-anon-reader@example.com", q("anonymousstatusq"))).toEqual([
      id,
    ]);
    expect(await found(undefined, q("anonymousstatusq"))).toEqual([]);
  });

  it("leaves out the public notes of an author that is not indexable, but not from its library", async () => {
    const author = "status-search-unindexed@example.com";
    const fan = "status-search-unindexed-fan@example.com";
    const reader = "status-search-unindexed-reader@example.com";
    const kept = await post(author, "unindexedstatusq before");
    const faved = await post(author, "unindexedstatusq faved");
    await act(fan, `/api/v1/statuses/${faved}/favourite`);
    await send(author, "PATCH", "/api/v1/accounts/update_credentials", { indexable: false });
    const later = await post(author, "unindexedstatusq after");

    expect(await found(reader, q("unindexedstatusq"))).toEqual([]);
    expect(await found(author, q("unindexedstatusq"))).toEqual([later, faved, kept]);
    expect(await found(fan, q("unindexedstatusq"))).toEqual([faved]);

    // The flag is read as it stands now: the notes indexed as public before
    // it changed show again at once, and the job indexes the later one.
    await send(author, "PATCH", "/api/v1/accounts/update_credentials", { indexable: true });
    expect(await found(reader, q("unindexedstatusq"))).toEqual([faved, kept]);
    await reindex();
    expect(await found(reader, q("unindexedstatusq"))).toEqual([later, faved, kept]);
    await send(author, "PATCH", "/api/v1/accounts/update_credentials", { indexable: false });
    await reindex();
    expect(await found(reader, q("unindexedstatusq in:public"))).toEqual([]);
    expect(await found(fan, q("unindexedstatusq in:library"))).toEqual([faved]);
  });

  // An author's flag is written to its notes' index rows by a job, a page at
  // a time; until then the query reads the flag itself.
  it("reindexes an author's notes in pages after its flag changes", async () => {
    const author = "status-search-pages@example.com";
    const reader = "status-search-pages-reader@example.com";
    const account = await accountOf(author);
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      ids.push(await post(author, `pagedreindexq ${index}`));
    }
    await send(author, "PATCH", "/api/v1/accounts/update_credentials", { indexable: false });
    expect(await found(reader, q("pagedreindexq"))).toEqual([]);
    const pages = [];
    for (;;) {
      const page = await reindexStaleAuthors(env.DB, 2);
      expect(page.isOk()).toBe(true);
      if (page._unsafeUnwrap().scanned === 0) {
        break;
      }
      pages.push(page._unsafeUnwrap().scanned);
    }
    expect(pages.length).toBeGreaterThanOrEqual(2);
    const stale = await env.DB.prepare(
      "SELECT count(*) AS n FROM status_search_stale_authors WHERE author = ?",
    )
      .bind(account.id)
      .first("n");
    expect(stale).toBe(0);
    await send(author, "PATCH", "/api/v1/accounts/update_credentials", { indexable: true });
    await reindex();
    expect(await found(reader, q("pagedreindexq"))).toEqual(ids.toReversed());
  });

  // Inputs Mastodon answers with no status rather than an error.
  it("answers odd queries and pages with no status, not an error", async () => {
    const reader = "status-search-odd-reader@example.com";
    const id = await post("status-search-odd@example.com", "oddq note");
    for (const property of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(await found(reader, q(`oddq has:${property}`)), property).toEqual([]);
      expect(await found(reader, q(`oddq -has:${property}`)), property).toEqual([id]);
    }
    expect(await found(reader, q(`oddq after:${"9".repeat(310)}`))).toEqual([]);
    expect(await found(reader, q(`oddq before:${"9".repeat(17)}`))).toEqual([]);
    expect(await found(reader, `${q("oddq")}&limit=20&offset=9990`)).toEqual([]);
    expect(await found(reader, `${q("oddq")}&limit=20&offset=9979`)).toEqual([]);
    const many = Array.from({ length: 90 }, (_, index) => `from:nobody${index}`).join(" ");
    expect(await found(reader, q(`oddq ${many}`))).toEqual([]);
    expect(await found(reader, q(`oddq ${"language:en ".repeat(90)}`))).toEqual([]);
  });

  it("matches words and their stems, accents folded, not parts of words", async () => {
    const reader = "status-search-words-reader@example.com";
    const author = "status-search-words@example.com";
    const cats = await post(author, "wordsq Running with the Cats at the café");
    await post(author, "wordsq a category of concatenation");

    expect(await found(reader, q("wordsq cat"))).toEqual([cats]);
    expect(await found(reader, q("wordsq runs cafe"))).toEqual([cats]);
    expect(await found(reader, q('"wordsq category"'))).toHaveLength(0);
    expect(await found(reader, q('wordsq "with the cats"'))).toEqual([cats]);
    expect(await found(reader, q('wordsq "the with cats"'))).toEqual([]);
  });

  it("finds part of an unspaced CJK run", async () => {
    const reader = "status-search-cjk-reader@example.com";
    const id = await post("status-search-cjk@example.com", "東京タワーに行ったcjkq");
    expect(await found(reader, q("東京"))).toContain(id);
    expect(await found(reader, q("タワー"))).toContain(id);
    expect(await found(reader, q("京東"))).not.toContain(id);
  });

  it("applies Mastodon's operators", async () => {
    const reader = "status-search-ops-reader@example.com";
    const alice = "status-search-ops-alice@example.com";
    const bob = "status-search-ops-bob@example.com";
    const aliceAccount = await accountOf(alice);
    const tagged = await post(alice, "operatorsq with a #Kettle tag");
    const poll = await post(alice, "operatorsq poll", "public", {
      poll: { options: ["teapot", "mug"], expires_in: 3600 },
    });
    const reply = await post(bob, "operatorsq reply", "public", { in_reply_to_id: tagged });
    const spoiled = await post(bob, "operatorsq hidden", "public", {
      spoiler_text: "spoilerword",
      sensitive: true,
      language: "fr",
    });

    expect(await found(reader, q("operatorsq"))).toEqual([spoiled, reply, poll, tagged]);
    expect(await found(reader, q(`operatorsq from:${aliceAccount.username}`))).toEqual([
      poll,
      tagged,
    ]);
    expect(await found(reader, q(`operatorsq from:@${aliceAccount.username}@example.com`))).toEqual(
      [poll, tagged],
    );
    expect(await found(reader, q("operatorsq from:nobody_here"))).toEqual([]);
    expect(await found(alice, q("operatorsq from:me"))).toEqual([poll, tagged]);
    expect(await found(reader, q(`operatorsq -from:${aliceAccount.username}`))).toEqual([
      spoiled,
      reply,
    ]);
    expect(await found(reader, q("operatorsq -hidden -poll"))).toEqual([reply, tagged]);
    expect(await found(reader, q("#kettle"))).toEqual([tagged]);
    expect(await found(reader, q("teapot"))).toEqual([poll]);
    expect(await found(reader, q("spoilerword"))).toEqual([spoiled]);
    expect(await found(reader, q("operatorsq has:poll"))).toEqual([poll]);
    expect(await found(reader, q("operatorsq is:reply"))).toEqual([reply]);
    expect(await found(reader, q("operatorsq is:sensitive language:fr"))).toEqual([spoiled]);
    expect(await found(reader, q("operatorsq -is:reply -has:poll"))).toEqual([spoiled, tagged]);
    expect(await found(reader, q("operatorsq has:nothing"))).toEqual([]);
    const today = new Date().toISOString().slice(0, 10);
    expect(await found(reader, q(`operatorsq during:${today}`))).toHaveLength(4);
    expect(await found(reader, q(`operatorsq before:${today}`))).toEqual([]);
    expect(await found(reader, q(`operatorsq after:${today}`))).toEqual([]);
    expect(await found(reader, q("operatorsq after:2000-01-01"))).toHaveLength(4);
    // Parslet refuses a lone colon, and Mastodon then answers no status.
    expect(await found(reader, q("operatorsq :"))).toEqual([]);
  });

  it("follows a note's edits and deletion", async () => {
    const reader = "status-search-edit-reader@example.com";
    const author = "status-search-edit@example.com";
    const id = await post(author, "editedq before");
    await send(author, "PUT", `/api/v1/statuses/${id}`, { status: "editedq after" });
    expect(await found(reader, q("editedq before"))).toEqual([]);
    expect(await found(reader, q("editedq after"))).toEqual([id]);
    const response = await json(`/api/v1/statuses/${id}`, {
      method: "DELETE",
      headers: await authHeaders(author),
    });
    expect(response.status).toBe(200);
    expect(await found(reader, q("editedq"))).toEqual([]);
  });

  it("finds cached remote notes by indexable actors, and the viewer's own interactions", async () => {
    const reader = "status-search-remote-reader@example.com";
    const fan = "status-search-remote-fan@example.com";
    const open = await remoteActor("searchable", "search-remote.example");
    const closed = await remoteActor("unsearchable", "search-remote.example");
    await setRemoteIndexable(open.actorUri, true);
    const shown = remoteNote(
      open.actorUri,
      "1",
      "<p>remoteq <b>shown</b></p>",
      "2024-05-01T00:00:00.000Z",
    );
    const hidden = remoteNote(
      closed.actorUri,
      "2",
      "<p>remoteq hidden</p>",
      "2024-05-02T00:00:00.000Z",
    );
    expect((await upsertRemoteStatus(env.DB, shown, [])).isOk()).toBe(true);
    expect((await upsertRemoteStatus(env.DB, hidden, [])).isOk()).toBe(true);
    await act(fan, `/api/v1/statuses/${hidden.id}/favourite`);

    expect(await found(reader, q("remoteq"))).toEqual([shown.id]);
    expect(await found(fan, q("remoteq"))).toEqual([hidden.id, shown.id]);
    expect(await found(reader, q("remoteq span"))).toEqual([]);

    await setRemoteIndexable(open.actorUri, false);
    await setRemoteIndexable(closed.actorUri, true);
    // The actor that is no longer indexable is left out at once.
    expect(await found(reader, q("remoteq"))).toEqual([]);
    await reindex();
    expect(await found(reader, q("remoteq"))).toEqual([hidden.id]);

    const edited = { ...hidden, contentHtml: "<p>remoteq rewritten</p>" };
    expect((await upsertRemoteStatus(env.DB, edited, [])).isOk()).toBe(true);
    expect(await found(reader, q("rewritten"))).toEqual([hidden.id]);
    expect(await found(reader, q("remoteq hidden"))).toEqual([]);
  });

  it("indexes the remote notes cached before the index", async () => {
    const reader = "status-search-backfill-reader@example.com";
    const actor = await remoteActor("backfilled", "search-backfill.example");
    await setRemoteIndexable(actor.actorUri, true);
    const note = remoteNote(
      actor.actorUri,
      "1",
      "<p>backfilledq note</p>",
      "2024-06-01T00:00:00.000Z",
    );
    expect((await upsertRemoteStatus(env.DB, note, [])).isOk()).toBe(true);
    // As a note stored before migration 0015, with the walk not yet past it.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM status_search_documents WHERE remote_status_id = ?").bind(
        note.id,
      ),
      env.DB.prepare("UPDATE backfill_cursors SET after_id = '' WHERE name = 'status_search'"),
    ]);
    expect(await found(reader, q("backfilledq"))).toEqual([]);

    for (let page = 0; page < 100; page += 1) {
      expect(await processOutboxJob(env, { kind: "BackfillStatusSearch" })).toBe("ok");
      const cursor = await env.DB.prepare(
        "SELECT after_id FROM backfill_cursors WHERE name = 'status_search'",
      ).first("after_id");
      if (cursor === "~") {
        break;
      }
    }
    expect(await found(reader, q("backfilledq"))).toEqual([note.id]);
  });

  // Mastodon's `StatusFilter`: a silenced account's status is left out only
  // for a reader who neither follows nor is that account; a suspended
  // account's status is left out for every reader (`StatusPolicy#show?`).
  it("shows a silenced account's statuses only to the account and its followers", async () => {
    const silenced = "search-silenced@example.com";
    const follower = "search-silenced-fan@example.com";
    const stranger = "search-silenced-other@example.com";
    const suspended = "search-suspended@example.com";
    const other = "search-silenced-third@example.com";
    const silencedAccount = await accountOf(silenced);
    const suspendedAccount = await accountOf(suspended);
    await accountOf(stranger);
    await act(follower, `/api/v1/accounts/${silencedAccount.id}/follow`);
    const kept = await post(other, "silencedstatusq from someone else");
    const hidden = [
      await post(silenced, "silencedstatusq silenced one"),
      await post(silenced, "silencedstatusq silenced two"),
    ];
    await post(suspended, "silencedstatusq suspended");
    const admin = await authHeaders("search-silence-admin@example.com", { admin: true });
    for (const path of [
      `/api/v1/admin/accounts/${silencedAccount.id}/silence`,
      `/api/v1/admin/accounts/${suspendedAccount.id}/suspend`,
    ]) {
      const response = await json(path, { method: "POST", headers: admin });
      expect(response.status, path).toBe(200);
    }

    const page = (email: string, offset = 0, limit = 10) =>
      found(email, `q=silencedstatusq&limit=${limit}&offset=${offset}`);
    for (const reader of [silenced, follower]) {
      expect(await page(reader), reader).toEqual([hidden[1], hidden[0], kept]);
    }
    expect(await page(stranger)).toEqual([kept]);
    // The filter runs before `offset`, so a page skips only what its reader sees.
    expect(await page(stranger, 0, 1)).toEqual([kept]);
    expect(await page(stranger, 1, 1)).toEqual([]);
    expect(await page(follower, 2, 1)).toEqual([kept]);
  });
});
