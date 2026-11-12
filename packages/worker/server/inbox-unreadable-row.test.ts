import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";

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

    expect(
      await update(author, {
        ...original,
        content: "<p>edited</p>",
        to: [PUBLIC],
        cc: [],
        published: "2026-10-25T00:00:00.000Z",
        updated: "2026-10-26T00:00:00.000Z",
      }),
    ).toBe(202);

    expect(await status(id)).toMatchObject({
      content: "<p>edited</p>",
      visibility: "unlisted",
      created_at: "2026-10-20T00:00:00.000Z",
      edited_at: "2026-10-26T00:00:00.000Z",
    });
  });
});
