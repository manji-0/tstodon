import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus } from "@tstodon/api";
import { Quote } from "@tstodon/domain";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";
import { insertStatusQuote } from "./quote-store";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const QuoteRow = z.object({ id: z.string(), state: z.string() });

describe("insertStatusQuote", () => {
  it("keeps one row per quoting remote note, decided over pending whichever is written first", async () => {
    const headers = await authHeaders("quote-store-upsert@example.com");
    const posted = await SELF.fetch("https://example.com/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ status: "quote me" }),
    });
    const quotedId = expectContract(ApiStatus, await posted.json()).id;
    const author = await remoteActor("quote-store-upsert");
    const object = {
      id: "https://remote.example/notes/quote-store-upsert",
      type: "Note",
      attributedTo: author.actorUri,
      published: "2026-11-20T00:00:00.000Z",
      to: [PUBLIC],
      content: "<p>no quote yet</p>",
    };
    expect(await author.send({ id: `${object.id}/create`, type: "Create", object })).toBe(202);
    const quotingId =
      parseRows(
        z.object({ id: z.string() }),
        (
          await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
            .bind(object.id)
            .all()
        ).results,
      )[0]?.id ?? "";
    /** Whether a quote of the stored note, parsed as `toQuote` reads a row, was recorded. */
    const write = async (id: string, state: Readonly<Record<string, unknown>>) => {
      const quote = Quote.parse({
        id,
        quoting: { kind: "RemoteStatus", statusId: quotingId },
        quoted: { kind: "LocalStatus", statusId: quotedId },
        state,
        legacy: false,
        createdAt: "2026-11-20T00:00:00.000Z",
      });
      return quote.isOk() && (await insertStatusQuote(env.DB, quote.value)).isOk();
    };
    const rows = async () =>
      parseRows(
        QuoteRow,
        (
          await env.DB.prepare("SELECT id, state FROM status_quotes WHERE remote_status_id = ?")
            .bind(quotingId)
            .all()
        ).results,
      );
    const accepted = { kind: "Accepted", approval: { kind: "Implicit" } };

    expect(await write("quote-store-upsert-1", { kind: "Pending" })).toBe(true);
    expect(await write("quote-store-upsert-2", accepted)).toBe(true);
    expect(await rows()).toEqual([{ id: "quote-store-upsert-1", state: "accepted" }]);

    expect(await write("quote-store-upsert-3", { kind: "Pending" })).toBe(true);
    expect(await rows()).toEqual([{ id: "quote-store-upsert-1", state: "accepted" }]);
  });
});
