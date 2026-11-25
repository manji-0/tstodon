import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import type { LocalAccount } from "@tstodon/domain";
import { accessTokenFor, signedInAccount } from "../test/auth-fixture";
import { meter, patchD1, resetMeter, settle } from "../test/meter";
import { drainHeld, holdQueue, QUEUE_BATCH, QUEUE_INVOCATION_BUDGET } from "../test/queue-hold";
import { remoteActor } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";
import { BOOSTER_PAGE_SIZE } from "./note-booster-updates";

/**
 * As Mastodon's `UpdateStatusService`, every local account that boosted a
 * remote note gets one `update` notification when the note is edited. A
 * note may have any number of local boosters: the inbox request that
 * applies the edit does not notify them itself, and neither the request nor
 * one queue invocation grows with them.
 */

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

afterEach(() => {
  vi.restoreAllMocks();
});

const updateCount = async (statusId: string): Promise<Map<string, number>> =>
  new Map(
    parseRows(
      z.object({ account_id: z.string(), n: z.number() }),
      (
        await env.DB.prepare(
          `SELECT account_id, COUNT(*) AS n FROM notifications
           WHERE status_id = ? AND kind = 'update' GROUP BY account_id`,
        )
          .bind(statusId)
          .all()
      ).results,
    ).map((row) => [row.account_id, row.n]),
  );

describe("update notifications of an edited remote note", () => {
  it(
    "reach every local booster once, from queued pages whose cost does not grow with the boosters",
    { timeout: 120_000 },
    async () => {
      const author = await remoteActor("many-boosters", "many-boosters.example");
      const boosters = async (prefix: string, count: number): Promise<LocalAccount[]> =>
        Promise.all(
          Array.from({ length: count }, (_, n) => signedInAccount(`${prefix}-${n}@example.com`)),
        );
      const noteOf = (name: string, content: string, updated?: string) => ({
        id: `https://many-boosters.example/notes/${name}`,
        type: "Note",
        attributedTo: author.actorUri,
        content,
        published: new Date().toISOString(),
        to: [PUBLIC],
        ...(updated ? { updated } : {}),
      });
      const boosted = async (name: string, accounts: ReadonlyArray<LocalAccount>) => {
        const object = noteOf(name, "<p>v1</p>");
        expect(await author.send({ id: `${object.id}/create`, type: "Create", object })).toBe(202);
        const [row] = parseRows(
          z.object({ id: z.string() }),
          (
            await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
              .bind(object.id)
              .all()
          ).results,
        );
        if (!row) throw new Error(`${object.id} was not stored`);
        for (const account of accounts) {
          const response = await SELF.fetch(
            `https://example.com/api/v1/statuses/${row.id}/reblog`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${await accessTokenFor(account.id)}` },
            },
          );
          expect(response.status).toBe(200);
          await response.body?.cancel();
        }
        return row.id;
      };
      /** The D1 statements of the inbox request that applies an edit. */
      const edit = async (name: string, revision: string): Promise<number> => {
        const delivery = await author.delivery({
          id: `https://many-boosters.example/notes/${name}/update-${revision}`,
          type: "Update",
          object: noteOf(name, `<p>${revision}</p>`, new Date().toISOString()),
        });
        await settle();
        resetMeter();
        const response = await SELF.fetch(delivery);
        expect(response.status).toBe(202);
        await settle();
        return meter.tally.statements;
      };

      const few = await boosters("few-boosters", 2);
      const many = await boosters("many-boosters", BOOSTER_PAGE_SIZE + 10);
      const fewId = await boosted("few", few);
      const manyId = await boosted("many", many);
      patchD1();
      const queued = holdQueue();
      await edit("warm", "v2");
      queued.bodies.length = 0;

      const toFew = await edit("few", "v2");
      const toMany = await edit("many", "v2");
      expect(
        Math.abs(toMany - toFew),
        `the inbox Update made ${toFew} statements for ${few.length} boosters, ${toMany} for ${many.length}`,
      ).toBeLessThan(10);
      const mostPerInvocation = await drainHeld(queued, ["NotifyRemoteNoteBoosters"]);
      expect(
        mostPerInvocation,
        `one queue invocation of ${QUEUE_BATCH} jobs made ${mostPerInvocation} statements`,
      ).toBeLessThan(QUEUE_INVOCATION_BUDGET);

      const notified = await updateCount(manyId);
      expect(notified.size).toBe(many.length);
      for (const account of many) {
        expect(notified.get(account.id), account.username).toBe(1);
      }
      expect([...(await updateCount(fewId)).values()]).toEqual([1, 1]);

      // The same edit again owes nothing: nobody hears of it twice.
      await edit("many", "v2");
      await drainHeld(queued, ["NotifyRemoteNoteBoosters"]);
      expect([...(await updateCount(manyId)).values()].every((n) => n === 1)).toBe(true);
    },
  );

  it("notifies a booster once when a page job is run twice", async () => {
    const author = await remoteActor("twice-booster", "twice-booster.example");
    const object = {
      id: "https://twice-booster.example/notes/twice",
      type: "Note",
      attributedTo: author.actorUri,
      content: "<p>v1</p>",
      published: new Date().toISOString(),
      to: [PUBLIC],
    };
    expect(await author.send({ id: `${object.id}/create`, type: "Create", object })).toBe(202);
    const [row] = parseRows(
      z.object({ id: z.string() }),
      (
        await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
          .bind(object.id)
          .all()
      ).results,
    );
    if (!row) throw new Error("not stored");
    const booster = await signedInAccount("twice-booster@example.com");
    const reblog = await SELF.fetch(`https://example.com/api/v1/statuses/${row.id}/reblog`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await accessTokenFor(booster.id)}` },
    });
    expect(reblog.status).toBe(200);
    const page = {
      kind: "NotifyRemoteNoteBoosters",
      statusId: row.id,
      actorUri: author.actorUri,
      since: new Date(Date.now() - 1000).toISOString(),
      step: { kind: "Page", afterAccountId: "" },
    };
    const queued = holdQueue();
    queued.bodies.push(page, page);
    await drainHeld(queued, ["NotifyRemoteNoteBoosters"]);
    expect(await updateCount(row.id)).toEqual(new Map([[booster.id, 1]]));
  });
});
