import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const NOW = "2026-11-01T00:00:00.000Z";

const localStatus = async (email: string): Promise<string> => {
  const response = await SELF.fetch("https://example.com/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ status: "quoting" }),
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "string") {
    throw new Error("status has no id");
  }
  return body.id;
};

const remoteStatus = async (slug: string): Promise<string> => {
  const author = await remoteActor(`quote-targets-${slug}`);
  const uri = `https://remote.example/notes/quote-targets-${slug}`;
  const object = {
    id: uri,
    type: "Note",
    attributedTo: author.actorUri,
    content: "<p>quoted</p>",
    published: NOW,
    to: [PUBLIC],
  };
  expect(await author.send({ id: `${uri}/activity`, type: "Create", object })).toBe(202);
  const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
    .bind(uri)
    .first<{ id: string }>();
  if (!row) {
    throw new Error("remote note was not stored");
  }
  return row.id;
};

type QuoteColumns = Readonly<{
  statusId?: string;
  remoteStatusId?: string;
  quotedStatusId?: string;
  quotedRemoteStatusId?: string;
  state?: string;
  approvalUri?: string;
}>;

const insertQuote = (id: string, columns: QuoteColumns) =>
  env.DB.prepare(
    `INSERT INTO status_quotes (id, status_id, remote_status_id, quoted_status_id,
       quoted_remote_status_id, state, approval_uri, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      columns.statusId ?? null,
      columns.remoteStatusId ?? null,
      columns.quotedStatusId ?? null,
      columns.quotedRemoteStatusId ?? null,
      columns.state ?? "accepted",
      columns.approvalUri ?? null,
      NOW,
      NOW,
    )
    .run();

describe("status_quotes targets", () => {
  it("refuses a row that does not name exactly one status at each end", async () => {
    const local = await localStatus("quote-targets-checks@example.com");
    const quoting = await localStatus("quote-targets-checks@example.com");
    const remote = await remoteStatus("checks");
    const refused: ReadonlyArray<QuoteColumns> = [
      { quotedStatusId: local },
      { statusId: quoting, remoteStatusId: remote, quotedStatusId: local },
      { statusId: quoting },
      { statusId: quoting, quotedStatusId: local, quotedRemoteStatusId: remote },
      { statusId: quoting, quotedStatusId: local, approvalUri: "https://remote.example/stamp" },
      { statusId: quoting, quotedStatusId: local, state: "approved" },
    ];
    for (const [index, columns] of refused.entries()) {
      await expect(
        insertQuote(`refused-${index}`, columns),
        JSON.stringify(columns),
      ).rejects.toThrow(/constraint/i);
    }
  });

  it("counts accepted local quotes of a remote status in its quotes_count", async () => {
    const email = "quote-targets-count@example.com";
    const remote = await remoteStatus("count");
    await insertQuote("count-accepted", {
      statusId: await localStatus(email),
      quotedRemoteStatusId: remote,
      approvalUri: "https://remote.example/quote_authorizations/1",
    });
    await insertQuote("count-revoked", {
      statusId: await localStatus(email),
      quotedRemoteStatusId: remote,
      state: "revoked",
    });
    const response = await SELF.fetch(`https://example.com/api/v1/statuses/${remote}`, {
      headers: await authHeaders(email),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: remote, quotes_count: 1 });
  });
});
