import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { ActivityId, IsoInstant } from "@tstodon/domain";
import { parseRows } from "./d1";
import { recordRemoteBoost } from "./remote-boost";
import { findRemoteStatusByObjectUri } from "./remote-status-store";
import { parseInstanceIdentity } from "./runtime-config";
import { setRemoteStatusCard } from "./status-card-store";
import { findThreadParent } from "./thread-context";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const note = (author: Remote, slug: string, extra: Record<string, unknown> = {}) => ({
  id: `https://remote.example/notes/${slug}`,
  type: "Note",
  attributedTo: author.actorUri,
  content: `<p>${slug}</p>`,
  published: "2026-10-20T00:00:00.000Z",
  to: [PUBLIC],
  ...extra,
});

const create = (author: Remote, object: Readonly<{ id: string }>) =>
  author.send({ id: `${object.id}/create`, type: "Create", object });

const rows = async <Row>(schema: z.ZodType<Row>, sql: string, ...values: string[]) =>
  parseRows(
    schema,
    (
      await env.DB.prepare(sql)
        .bind(...values)
        .all()
    ).results,
  );

const count = async (sql: string, ...values: string[]): Promise<number> =>
  (await rows(z.object({ n: z.number() }), sql, ...values))[0]?.n ?? 0;

const storedId = async (objectUri: string): Promise<string | undefined> =>
  (
    await rows(
      z.object({ id: z.string() }),
      "SELECT id FROM remote_statuses WHERE object_uri = ?",
      objectUri,
    )
  )[0]?.id;

const status = async (id: string, headers: Record<string, string> = {}) =>
  expectContract(
    ApiStatus,
    await (await SELF.fetch(`https://example.com/api/v1/statuses/${id}`, { headers })).json(),
  );

/** The ways a stored row stops reading as a status: by its values, or by its shape. */
const FAULTS = {
  value: "visibility = 'unreadable'",
  shape: "published_at = ''",
} as const;

/** A note stored from its `Create`, then made unreadable as a row written by older code could be. */
const unreadable = async (
  author: Remote,
  slug: string,
  fault: keyof typeof FAULTS = "value",
): Promise<Readonly<{ id: string; uri: string }>> => {
  const original = note(author, slug);
  expect(await create(author, original)).toBe(202);
  const id = (await storedId(original.id)) ?? "";
  await env.DB.prepare(`UPDATE remote_statuses SET ${FAULTS[fault]} WHERE id = ?`).bind(id).run();
  expect((await SELF.fetch(`https://example.com/api/v1/statuses/${id}`)).status).not.toBe(200);
  return { id, uri: original.id };
};

/** A local account and a public note of it, which anyone may quote unless `body` says otherwise. */
const localNote = async (email: string, body: Record<string, unknown> = {}) => {
  const account = await signedInAccount(email);
  const headers = await authHeaders(email);
  const posted = await SELF.fetch("https://example.com/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ status: "a local note", ...body }),
  });
  expect(posted.status).toBe(200);
  const { id } = expectContract(z.object({ id: z.string() }), await posted.json());
  const actorUri = `https://example.com/users/${account.username}`;
  return { account, headers, id, actorUri, uri: `${actorUri}/statuses/${id}` };
};

describe.each(["value", "shape"] as const)(
  "an inbox activity that refers to a remote note whose stored row does not read (%s)",
  (fault) => {
    it("drops an Announce of the note with 202", async () => {
      const author = await remoteActor(`unreadable-announced-${fault}`);
      const booster = await remoteActor(`unreadable-booster-${fault}`);
      const target = await unreadable(author, `unreadable-announced-${fault}`, fault);

      expect(
        await booster.send({
          id: `${booster.actorUri}/announces/${fault}`,
          type: "Announce",
          object: target.uri,
          published: "2026-10-21T00:00:00.000Z",
          to: [PUBLIC],
        }),
      ).toBe(202);

      expect(
        await count(
          "SELECT COUNT(*) AS n FROM remote_boosts WHERE actor_uri = ?",
          booster.actorUri,
        ),
      ).toBe(0);
    });

    it("stores a Create that quotes the note, with the quote left unresolved", async () => {
      const author = await remoteActor(`unreadable-quoted-${fault}`);
      const quoter = await remoteActor(`unreadable-quoter-${fault}`);
      const target = await unreadable(author, `unreadable-quoted-${fault}`, fault);
      const quoting = note(quoter, `unreadable-quoting-${fault}`, { quote: target.uri });

      expect(await create(quoter, quoting)).toBe(202);

      const id = (await storedId(quoting.id)) ?? "";
      expect(await status(id)).toMatchObject({ content: quoting.content });
      expect(
        await rows(
          z.object({ quoted_remote_status_id: z.string().nullable(), quoted_uri: z.string() }),
          "SELECT quoted_remote_status_id, quoted_uri FROM status_quotes WHERE remote_status_id = ?",
          id,
        ),
      ).toEqual([{ quoted_remote_status_id: null, quoted_uri: target.uri }]);
    });

    it("drops a QuoteRequest whose quoting note is the one, with 202 and no answer", async () => {
      const quoter = await remoteActor(`unreadable-instrument-${fault}`);
      const quoted = await localNote(`unreadable-instrument-${fault}@example.com`);
      await unreadable(quoter, `unreadable-instrument-${fault}`, fault);

      expect(
        await quoter.send({
          id: `${quoter.actorUri}/quote_requests/${fault}`,
          type: "QuoteRequest",
          object: quoted.uri,
          instrument: note(quoter, `unreadable-instrument-${fault}`, { quote: quoted.uri }),
        }),
      ).toBe(202);

      expect(
        await count(
          "SELECT COUNT(*) AS n FROM outbound_activities WHERE account_id = ? AND kind IN ('Accept', 'Reject')",
          quoted.account.id,
        ),
      ).toBe(0);
    });

    it("refuses a QuoteRequest the author's policy does not allow, although the quoting note does not read", async () => {
      const quoter = await remoteActor(`unreadable-refused-${fault}`);
      const quoted = await localNote(`unreadable-refused-${fault}@example.com`, {
        quote_approval_policy: "nobody",
      });
      const target = await unreadable(quoter, `unreadable-refused-${fault}`, fault);

      expect(
        await quoter.send({
          id: `${quoter.actorUri}/quote_requests/refused-${fault}`,
          type: "QuoteRequest",
          object: quoted.uri,
          instrument: target.uri,
        }),
      ).toBe(202);

      expect(
        await count(
          "SELECT COUNT(*) AS n FROM outbound_activities WHERE account_id = ? AND kind = 'Reject'",
          quoted.account.id,
        ),
      ).toBe(1);
    });

    it("stores a reply to the note and notifies the account it mentions", async () => {
      const author = await remoteActor(`unreadable-parent-${fault}`);
      const replier = await remoteActor(`unreadable-replier-${fault}`);
      const mentioned = await localNote(`unreadable-parent-${fault}@example.com`);
      const target = await unreadable(author, `unreadable-parent-${fault}`, fault);
      const reply = note(replier, `unreadable-reply-${fault}`, {
        inReplyTo: target.uri,
        cc: [mentioned.actorUri],
        tag: [{ type: "Mention", href: mentioned.actorUri }],
      });

      expect(await create(replier, reply)).toBe(202);

      const id = (await storedId(reply.id)) ?? "";
      expect(await status(id, mentioned.headers)).toMatchObject({ content: reply.content });
      const mentions = expectContract(
        z.array(z.object({ status: z.object({ id: z.string() }) })),
        await (
          await SELF.fetch("https://example.com/api/v1/notifications?types[]=mention", {
            headers: mentioned.headers,
          })
        ).json(),
      );
      expect(mentions.map((entry) => entry.status.id)).toEqual([id]);
    });

    it("drops the quoted author's answer to a local quote of the note with 202", async () => {
      const author = await remoteActor(`unreadable-answered-${fault}`);
      const quoter = await localNote(`unreadable-answered-${fault}@example.com`);
      const original = note(author, `unreadable-answered-${fault}`, {
        interactionPolicy: { canQuote: { manualApproval: [PUBLIC] } },
      });
      expect(await create(author, original)).toBe(202);
      const quotedId = (await storedId(original.id)) ?? "";
      const posted = await SELF.fetch("https://example.com/api/v1/statuses", {
        method: "POST",
        headers: { "content-type": "application/json", ...quoter.headers },
        body: JSON.stringify({ status: "quoting", quoted_status_id: quotedId }),
      });
      expect(posted.status).toBe(200);
      const quotingId = expectContract(z.object({ id: z.string() }), await posted.json()).id;
      const quote = async () =>
        (
          await rows(
            z.object({ state: z.string(), activity_uri: z.string() }),
            "SELECT state, activity_uri FROM status_quotes WHERE status_id = ?",
            quotingId,
          )
        )[0];
      const before = await quote();
      expect(before?.state).toBe("pending");
      await env.DB.prepare(`UPDATE remote_statuses SET ${FAULTS[fault]} WHERE id = ?`)
        .bind(quotedId)
        .run();

      expect(
        await author.send({
          id: `${author.actorUri}/rejects/${fault}`,
          type: "Reject",
          object: before?.activity_uri,
        }),
      ).toBe(202);

      expect(await quote()).toEqual(before);
    });
  },
);

describe("a remote note whose stored row has a shape that does not parse", () => {
  it("is replaced under its id by its author's Create, as a row whose values do not read", async () => {
    const author = await remoteActor("unreadable-shape-create");
    const target = await unreadable(author, "unreadable-shape-create", "shape");
    const again = note(author, "unreadable-shape-create", { content: "<p>sent again</p>" });

    expect(
      await author.send({ id: `${again.id}/create-again`, type: "Create", object: again }),
    ).toBe(202);

    expect(await storedId(again.id)).toBe(target.id);
    expect(await status(target.id)).toMatchObject({ content: "<p>sent again</p>" });
  });
});

describe("the author's delivery of a note whose stored row does not read, replacing the row", () => {
  const update = (
    author: Remote,
    object: Readonly<{ id: string; updated: string } & Record<string, unknown>>,
  ) => author.send({ id: `${object.id}/update/${object.updated}`, type: "Update", object });

  const storedRow = async (id: string) =>
    (
      await rows(
        z.object({ content_html: z.string(), visibility: z.string() }),
        "SELECT content_html, visibility FROM remote_statuses WHERE id = ?",
        id,
      )
    )[0];

  it("keeps the row when the document is older than the edit it still dates", async () => {
    const author = await remoteActor("unreadable-replayed");
    const original = note(author, "unreadable-replayed", { content: "<p>original</p>" });
    const edit = (content: string, updated: string) => ({ ...original, content, updated });
    expect(await create(author, original)).toBe(202);
    expect(await update(author, edit("<p>second edit</p>", "2026-10-22T00:00:00.000Z"))).toBe(202);
    const id = (await storedId(original.id)) ?? "";
    await env.DB.prepare(`UPDATE remote_statuses SET ${FAULTS.value} WHERE id = ?`).bind(id).run();
    const kept = { content_html: "<p>second edit</p>", visibility: "unreadable" };

    expect(await update(author, edit("<p>first edit</p>", "2026-10-21T00:00:00.000Z"))).toBe(202);
    expect(await storedRow(id)).toEqual(kept);
    expect(
      await author.send({ id: `${original.id}/create-again`, type: "Create", object: original }),
    ).toBe(202);
    expect(await storedRow(id)).toEqual(kept);

    expect(await update(author, edit("<p>third edit</p>", "2026-10-23T00:00:00.000Z"))).toBe(202);
    expect(await status(id)).toMatchObject({
      content: "<p>third edit</p>",
      edited_at: "2026-10-23T00:00:00.000Z",
    });
  });

  it("replaces the row with a document that changes nothing, although it is no newer", async () => {
    const author = await remoteActor("unreadable-refreshed");
    const original = note(author, "unreadable-refreshed", { content: "<p>original</p>" });
    const edited = { ...original, content: "<p>edited</p>", updated: "2026-10-22T00:00:00.000Z" };
    expect(await create(author, original)).toBe(202);
    expect(await update(author, edited)).toBe(202);
    const id = (await storedId(original.id)) ?? "";
    await env.DB.prepare(`UPDATE remote_statuses SET ${FAULTS.value} WHERE id = ?`).bind(id).run();

    expect(
      await author.send({ id: `${edited.id}/update-again`, type: "Update", object: edited }),
    ).toBe(202);

    expect(await status(id)).toMatchObject({
      content: "<p>edited</p>",
      visibility: "public",
      edited_at: "2026-10-22T00:00:00.000Z",
    });
  });

  it("keeps the visibility and the publication date an Update finds readable in the row", async () => {
    const author = await remoteActor("unreadable-kept-columns");
    const original = note(author, "unreadable-kept-columns", {
      to: [`${author.actorUri}/followers`],
      cc: [PUBLIC],
    });
    expect(await create(author, original)).toBe(202);
    const id = (await storedId(original.id)) ?? "";
    await env.DB.prepare("UPDATE remote_statuses SET edited_at = 'unreadable' WHERE id = ?")
      .bind(id)
      .run();
    expect((await SELF.fetch(`https://example.com/api/v1/statuses/${id}`)).status).not.toBe(200);
    const updated = new Date().toISOString();

    expect(
      await update(author, {
        ...original,
        content: "<p>edited</p>",
        to: [PUBLIC],
        cc: [],
        published: "2026-10-25T00:00:00.000Z",
        updated,
      }),
    ).toBe(202);

    expect(await status(id)).toMatchObject({
      content: "<p>edited</p>",
      visibility: "unlisted",
      created_at: "2026-10-20T00:00:00.000Z",
      edited_at: updated,
    });
  });

  /** A note edited at `EDITED`, whose row then lost the date of that edit. */
  const EDITED = "2026-10-22T00:00:00.000Z";
  const undatedEdit = async (author: Remote, slug: string) => {
    const original = note(author, slug, { content: "<p>original</p>" });
    const edit = (content: string, updated: string) => ({ ...original, content, updated });
    expect(await create(author, original)).toBe(202);
    expect(await update(author, edit("<p>second edit</p>", EDITED))).toBe(202);
    const id = (await storedId(original.id)) ?? "";
    await env.DB.prepare("UPDATE remote_statuses SET edited_at = 'unreadable' WHERE id = ?")
      .bind(id)
      .run();
    expect((await SELF.fetch(`https://example.com/api/v1/statuses/${id}`)).status).not.toBe(200);
    return { id, original, edit };
  };

  const editedAtColumn = async (id: string) =>
    (
      await rows(
        z.object({ content_html: z.string(), edited_at: z.string().nullable() }),
        "SELECT content_html, edited_at FROM remote_statuses WHERE id = ?",
        id,
      )
    )[0];

  it("keeps a row whose edit date does not read when a replayed Update or the Create would change its content", async () => {
    const author = await remoteActor("unreadable-edit-date");
    const { id, original, edit } = await undatedEdit(author, "unreadable-edit-date");
    const kept = { content_html: "<p>second edit</p>", edited_at: "unreadable" };

    expect(await update(author, edit("<p>first edit</p>", "2026-10-21T00:00:00.000Z"))).toBe(202);
    expect(await editedAtColumn(id)).toEqual(kept);
    expect(
      await author.send({ id: `${original.id}/create-again`, type: "Create", object: original }),
    ).toBe(202);
    expect(await editedAtColumn(id)).toEqual(kept);
    // An Update with no date would be dated now, and so would its replay.
    expect(
      await author.send({
        id: `${original.id}/update/undated`,
        type: "Update",
        object: { ...original, content: "<p>undated edit</p>" },
      }),
    ).toBe(202);
    expect(await editedAtColumn(id)).toEqual(kept);
  });

  it("replaces a row whose edit date does not read with an Update dated after the row was last written", async () => {
    const author = await remoteActor("unreadable-edit-date-current");
    const { id, edit } = await undatedEdit(author, "unreadable-edit-date-current");
    const updated = new Date().toISOString();

    expect(await update(author, edit("<p>third edit</p>", updated))).toBe(202);

    expect(await status(id)).toMatchObject({ content: "<p>third edit</p>", edited_at: updated });
  });

  it("reads the last write of such a row in SQLite's form, which older card writes left", async () => {
    const author = await remoteActor("unreadable-edit-date-sqlite");
    const { id, edit } = await undatedEdit(author, "unreadable-edit-date-sqlite");
    await env.DB.prepare(
      "UPDATE remote_statuses SET updated_at = datetime('now', '-1 minute') WHERE id = ?",
    )
      .bind(id)
      .run();
    const before = new Date(Date.now() - 3_600_000).toISOString();
    const updated = new Date().toISOString();

    expect(await update(author, edit("<p>older edit</p>", before))).toBe(202);
    expect(await editedAtColumn(id)).toEqual({
      content_html: "<p>second edit</p>",
      edited_at: "unreadable",
    });

    expect(await update(author, edit("<p>third edit</p>", updated))).toBe(202);
    expect(await status(id)).toMatchObject({ content: "<p>third edit</p>", edited_at: updated });
  });

  it("dates the row as an instant when a link card is stored for it", async () => {
    const author = await remoteActor("unreadable-card-date");
    const original = note(author, "unreadable-card-date");
    expect(await create(author, original)).toBe(202);
    const id = (await storedId(original.id)) ?? "";

    expect((await setRemoteStatusCard(env.DB, id, "{}", "https://x.example/")).isOk()).toBe(true);

    const [row] = await rows(
      z.object({ updated_at: z.string() }),
      "SELECT updated_at FROM remote_statuses WHERE id = ?",
      id,
    );
    expect(IsoInstant.parse(row?.updated_at ?? "").isOk()).toBe(true);
  });

  it("takes the edit date from a document that changes nothing in a row whose edit date does not read", async () => {
    const author = await remoteActor("unreadable-edit-date-same");
    const { id, edit } = await undatedEdit(author, "unreadable-edit-date-same");
    const same = edit("<p>second edit</p>", EDITED);

    expect(await author.send({ id: `${same.id}/update-again`, type: "Update", object: same })).toBe(
      202,
    );

    expect(await status(id)).toMatchObject({ content: "<p>second edit</p>", edited_at: EDITED });
  });
});

/** Answers the Worker's outbound GET of each URL in `documents` with its document while `run` runs. */
const serving = async <T>(
  documents: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return href in documents
      ? new Response(JSON.stringify(documents[href]), {
          headers: { "content-type": "application/activity+json" },
        })
      : original(input, init);
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
};

describe("a fetch of a remote note whose stored row does not read", () => {
  const announce = (booster: Remote, objectUri: string) =>
    booster.send({
      id: `${objectUri}/announced-by/${booster.actorUri.split("/").at(-1)}`,
      type: "Announce",
      object: objectUri,
      published: "2026-10-21T00:00:00.000Z",
      to: [PUBLIC],
    });

  const boosts = (booster: Remote) =>
    count("SELECT COUNT(*) AS n FROM remote_boosts WHERE actor_uri = ?", booster.actorUri);

  it.each(["value", "shape"] as const)(
    "replaces the row from the document its author's host serves, and stores the Announce (%s)",
    async (fault) => {
      const author = await remoteActor(`fetch-heal-author-${fault}`);
      const booster = await remoteActor(`fetch-heal-booster-${fault}`);
      const target = await unreadable(author, `fetch-heal-${fault}`, fault);
      const served = note(author, `fetch-heal-${fault}`);

      expect(await serving({ [target.uri]: served }, () => announce(booster, target.uri))).toBe(
        202,
      );

      expect(await status(target.id)).toMatchObject({
        content: served.content,
        visibility: "public",
        created_at: "2026-10-20T00:00:00.000Z",
        edited_at: null,
      });
      expect(await boosts(booster)).toBe(1);
      expect(
        await count("SELECT COUNT(*) AS n FROM remote_status_owed WHERE status_id = ?", target.id),
      ).toBe(0);
    },
  );

  it("replaces the row when a Create quotes the note, and resolves the quote", async () => {
    const author = await remoteActor("fetch-heal-quoted");
    const quoter = await remoteActor("fetch-heal-quoter");
    const target = await unreadable(author, "fetch-heal-quoted");
    const quoting = note(quoter, "fetch-heal-quoting", { quote: target.uri });

    expect(
      await serving({ [target.uri]: note(author, "fetch-heal-quoted") }, () =>
        create(quoter, quoting),
      ),
    ).toBe(202);

    expect(await status(target.id)).toMatchObject({ visibility: "public" });
    expect(
      await rows(
        z.object({ quoted_remote_status_id: z.string().nullable() }),
        "SELECT quoted_remote_status_id FROM status_quotes WHERE remote_status_id = ?",
        (await storedId(quoting.id)) ?? "",
      ),
    ).toEqual([{ quoted_remote_status_id: target.id }]);
  });

  it("keeps the row when the document is attributed to another actor", async () => {
    const author = await remoteActor("fetch-heal-not-author");
    const other = await remoteActor("fetch-heal-other-author");
    const booster = await remoteActor("fetch-heal-not-author-booster");
    const target = await unreadable(author, "fetch-heal-not-author");

    expect(
      await serving({ [target.uri]: note(other, "fetch-heal-not-author") }, () =>
        announce(booster, target.uri),
      ),
    ).toBe(202);

    expect((await SELF.fetch(`https://example.com/api/v1/statuses/${target.id}`)).status).not.toBe(
      200,
    );
    expect(await boosts(booster)).toBe(0);
  });

  it("keeps the row when the note is not on its author's host", async () => {
    const author = await remoteActor("fetch-heal-other-host");
    const booster = await remoteActor("fetch-heal-other-host-booster");
    const target = await unreadable(author, "fetch-heal-other-host");
    const elsewhere = "https://elsewhere.example/notes/fetch-heal-other-host";
    await env.DB.prepare("UPDATE remote_statuses SET object_uri = ? WHERE id = ?")
      .bind(elsewhere, target.id)
      .run();
    const served = { ...note(author, "fetch-heal-other-host"), id: elsewhere };

    expect(await serving({ [elsewhere]: served }, () => announce(booster, elsewhere))).toBe(202);

    expect((await SELF.fetch(`https://example.com/api/v1/statuses/${target.id}`)).status).not.toBe(
      200,
    );
    expect(await boosts(booster)).toBe(0);
  });
});

/** The ways a local status row stops reading as a status: by its values, or by its shape. */
const LOCAL_FAULTS = {
  value: "visibility = 'unreadable'",
  shape: "created_at = ''",
} as const;

const breakLocal = async (id: string, fault: keyof typeof LOCAL_FAULTS): Promise<void> => {
  await env.DB.prepare(`UPDATE statuses SET ${LOCAL_FAULTS[fault]} WHERE id = ?`).bind(id).run();
};

describe.each(["value", "shape"] as const)(
  "an inbox activity that refers to a local note whose stored row does not read (%s)",
  (fault) => {
    it("drops an Announce of the note with 202", async () => {
      const local = await localNote(`ul-announced-${fault}@example.com`);
      const booster = await remoteActor(`unreadable-local-booster-${fault}`);
      await breakLocal(local.id, fault);

      expect(
        await booster.send({
          id: `${booster.actorUri}/announces/local-${fault}`,
          type: "Announce",
          object: local.uri,
          published: "2026-10-21T00:00:00.000Z",
          to: [PUBLIC],
        }),
      ).toBe(202);

      expect(
        await count(
          "SELECT COUNT(*) AS n FROM remote_boosts WHERE actor_uri = ?",
          booster.actorUri,
        ),
      ).toBe(0);
    });

    it("stores a reply to the note with 202", async () => {
      const local = await localNote(`ul-parent-${fault}@example.com`);
      const replier = await remoteActor(`unreadable-local-replier-${fault}`);
      await breakLocal(local.id, fault);
      const reply = note(replier, `unreadable-local-reply-${fault}`, {
        inReplyTo: local.uri,
        cc: [local.actorUri],
        tag: [{ type: "Mention", href: local.actorUri }],
      });

      expect(await create(replier, reply)).toBe(202);

      const id = (await storedId(reply.id)) ?? "";
      expect(await status(id, local.headers)).toMatchObject({ content: reply.content });
    });

    it("reads the note as no parent of a remote reply, and as no target of a boost", async () => {
      const local = await localNote(`ul-read-${fault}@example.com`);
      const replier = await remoteActor(`unreadable-local-read-${fault}`);
      const reply = note(replier, `unreadable-local-read-${fault}`, { inReplyTo: local.uri });
      expect(await create(replier, reply)).toBe(202);
      const identity = parseInstanceIdentity(env)._unsafeUnwrap();
      const stored = (await findRemoteStatusByObjectUri(env.DB, reply.id))._unsafeUnwrap();
      const announceId = ActivityId.parse(`${replier.actorUri}/announces/read-${fault}`);
      if (stored === undefined || announceId.isErr()) {
        throw new Error("reply fixture rejected");
      }
      await breakLocal(local.id, fault);

      const parent = await findThreadParent(env.DB, identity, { kind: "Remote", status: stored });
      const boost = await recordRemoteBoost(
        env.DB,
        identity,
        replier.actorUri,
        { id: announceId.value, object: local.uri },
        {},
        undefined,
      );

      expect(parent.isOk() && parent.value).toBe(undefined);
      expect(boost.isOk() && boost.value).toBe(undefined);
    });

    it("stores a Create that quotes the note, without the quote", async () => {
      const local = await localNote(`ul-quoted-${fault}@example.com`);
      const quoter = await remoteActor(`unreadable-local-quoter-${fault}`);
      await breakLocal(local.id, fault);
      const quoting = note(quoter, `unreadable-local-quoting-${fault}`, { quote: local.uri });

      expect(await create(quoter, quoting)).toBe(202);

      const id = (await storedId(quoting.id)) ?? "";
      expect(await status(id)).toMatchObject({ content: quoting.content });
      expect(
        await count("SELECT COUNT(*) AS n FROM status_quotes WHERE remote_status_id = ?", id),
      ).toBe(0);
    });

    it("drops a QuoteRequest on the note with 202 and no answer", async () => {
      const local = await localNote(`ul-requested-${fault}@example.com`);
      const quoter = await remoteActor(`unreadable-local-requester-${fault}`);
      await breakLocal(local.id, fault);

      expect(
        await quoter.send({
          id: `${quoter.actorUri}/quote_requests/local-${fault}`,
          type: "QuoteRequest",
          object: local.uri,
          instrument: note(quoter, `unreadable-local-instrument-${fault}`, { quote: local.uri }),
        }),
      ).toBe(202);

      expect(
        await count(
          "SELECT COUNT(*) AS n FROM outbound_activities WHERE account_id = ? AND kind IN ('Accept', 'Reject')",
          local.account.id,
        ),
      ).toBe(0);
    });

    it("drops the quoted author's answer when the quoting local note is the one, with 202", async () => {
      const author = await remoteActor(`unreadable-local-answered-${fault}`);
      const quoter = await localNote(`ul-answered-${fault}@example.com`);
      const original = note(author, `unreadable-local-answered-${fault}`, {
        interactionPolicy: { canQuote: { manualApproval: [PUBLIC] } },
      });
      expect(await create(author, original)).toBe(202);
      const posted = await SELF.fetch("https://example.com/api/v1/statuses", {
        method: "POST",
        headers: { "content-type": "application/json", ...quoter.headers },
        body: JSON.stringify({ status: "quoting", quoted_status_id: await storedId(original.id) }),
      });
      expect(posted.status).toBe(200);
      const quotingId = expectContract(z.object({ id: z.string() }), await posted.json()).id;
      const quote = async () =>
        (
          await rows(
            z.object({ state: z.string(), activity_uri: z.string() }),
            "SELECT state, activity_uri FROM status_quotes WHERE status_id = ?",
            quotingId,
          )
        )[0];
      const before = await quote();
      expect(before?.state).toBe("pending");
      await breakLocal(quotingId, fault);

      expect(
        await author.send({
          id: `${author.actorUri}/rejects/local-${fault}`,
          type: "Reject",
          object: before?.activity_uri,
        }),
      ).toBe(202);

      expect(await quote()).toEqual(before);
    });
  },
);

describe("a stored row whose shape does not parse, read outside the inbox", () => {
  it("reads as no status: the REST API answers 404 for a local and for a remote one", async () => {
    const local = await localNote("unreadable-shape-rest@example.com");
    const author = await remoteActor("unreadable-shape-rest");
    const remote = await unreadable(author, "unreadable-shape-rest", "shape");
    await breakLocal(local.id, "shape");

    for (const id of [local.id, remote.id]) {
      expect((await SELF.fetch(`https://example.com/api/v1/statuses/${id}`)).status).toBe(404);
      expect((await SELF.fetch(`https://example.com/api/v1/statuses/${id}/context`)).status).toBe(
        404,
      );
    }
  });
});
