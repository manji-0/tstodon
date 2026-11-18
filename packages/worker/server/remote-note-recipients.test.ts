import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { ApiConversation, ApiNotification, ApiStatus } from "@tstodon/api";
import type { LocalAccount } from "@tstodon/domain";
import { expectContract } from "../test/api-contract";
import { accessTokenFor, signedInAccount } from "../test/auth-fixture";
import { meter, patchD1, resetMeter, settle } from "../test/meter";
import { remoteActor } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";
import { handleQueue } from "./queue-handler";

/**
 * A remote note may name any number of local accounts, as in Mastodon: each
 * one can read it and finds it in its conversations, and each one it
 * mentions is notified. The inbox request notifies a fixed number of them;
 * the rest are notified by queued jobs, so the request's D1 statements do not
 * grow with the recipients, and neither does one queue invocation's.
 */

/** D1's queries per Worker invocation (Workers Paid). */
const QUERIES_PER_INVOCATION = 1000;
/** The outbox queue's `maxBatchSize` (`app/queues/tstodon-outbox-process.ts`). */
const QUEUE_BATCH = 10;

const get = async (token: string, path: string) => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() };
};

/** Queue messages the Worker sends from now on, held here instead of sent. */
const holdQueue = (): Readonly<{ bodies: unknown[] }> => {
  const bodies: unknown[] = [];
  const proto = Object.getPrototypeOf(env.OUTBOX_PROCESS_QUEUE);
  vi.spyOn(proto, "send").mockImplementation((body: unknown) => {
    bodies.push(body);
  });
  vi.spyOn(proto, "sendBatch").mockImplementation((messages: unknown) => {
    for (const message of Array.isArray(messages) ? messages : []) {
      bodies.push(
        typeof message === "object" && message !== null ? Reflect.get(message, "body") : undefined,
      );
    }
  });
  return { bodies };
};

const kindOf = (body: unknown): unknown =>
  typeof body === "object" && body !== null ? Reflect.get(body, "kind") : undefined;

/** Run `bodies` through the queue handler, `QUEUE_BATCH` per invocation; the most statements one took. */
const drain = async (bodies: ReadonlyArray<unknown>): Promise<number> => {
  let most = 0;
  for (let start = 0; start < bodies.length; start += QUEUE_BATCH) {
    resetMeter();
    await handleQueue(
      {
        messages: bodies.slice(start, start + QUEUE_BATCH).map((body) => ({
          body,
          attempts: 1,
          ack: () => undefined,
          retry: () => {
            throw new Error(`job retried: ${JSON.stringify(body)}`);
          },
        })),
      },
      env,
    );
    most = Math.max(most, meter.tally.statements);
  }
  return most;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a remote direct note to many local accounts", () => {
  it(
    "lets each one read it, lists it in each one's conversations, and notifies each one",
    { timeout: 120_000 },
    async () => {
      const author = await remoteActor("crowddm", "crowd-dm.example");
      // Each accepts private mentions from strangers, so each mention is
      // delivered: the costlier path, which the budget below is for.
      const accounts = async (prefix: string, count: number): Promise<LocalAccount[]> =>
        Promise.all(
          Array.from({ length: count }, async (_, n) => {
            const account = await signedInAccount(`${prefix}-${n}@example.com`);
            const response = await SELF.fetch("https://example.com/api/v2/notifications/policy", {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${await accessTokenFor(account.id)}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ for_private_mentions: "accept" }),
            });
            expect(response.status).toBe(200);
            await response.body?.cancel();
            return account;
          }),
        );
      const deliver = async (name: string, recipients: ReadonlyArray<LocalAccount>) => {
        const noteUri = `https://crowd-dm.example/notes/${name}`;
        const actors = recipients.map((account) => `https://example.com/users/${account.username}`);
        const delivery = await author.delivery({
          id: `${noteUri}/create`,
          type: "Create",
          object: {
            id: noteUri,
            type: "Note",
            attributedTo: author.actorUri,
            content: "<p>hello all of you</p>",
            published: new Date().toISOString(),
            to: actors,
            tag: actors.map((href) => ({ type: "Mention", href })),
          },
        });
        await settle();
        resetMeter();
        const response = await SELF.fetch(delivery);
        expect(response.status).toBe(202);
        await settle();
        const statements = meter.tally.statements;
        const [row] = parseRows(
          z.object({ id: z.string() }),
          (
            await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
              .bind(noteUri)
              .all()
          ).results,
        );
        if (!row) throw new Error(`${noteUri} was not stored`);
        return { id: row.id, statements };
      };

      const thirty = await accounts("crowd-dm-a", 30);
      const sixty = await accounts("crowd-dm-b", 60);
      patchD1();
      const queued = holdQueue();
      await deliver("warm", thirty.slice(0, 1));
      queued.bodies.length = 0;
      const toThirty = await deliver("thirty", thirty);
      const thirtyJobs = queued.bodies.filter((body) => kindOf(body) !== "ProcessLinkCard");
      queued.bodies.length = 0;
      const toSixty = await deliver("sixty", sixty);
      const sixtyJobs = queued.bodies.filter((body) => kindOf(body) !== "ProcessLinkCard");

      expect(
        toSixty.statements,
        `the inbox request made ${toThirty.statements} statements for 30 recipients, ${toSixty.statements} for 60`,
      ).toBe(toThirty.statements);
      expect(toThirty.statements).toBeLessThan(QUERIES_PER_INVOCATION);
      const mostPerInvocation = await drain([...thirtyJobs, ...sixtyJobs]);
      expect(
        mostPerInvocation,
        `one queue invocation of ${QUEUE_BATCH} jobs made ${mostPerInvocation} statements`,
      ).toBeLessThan(QUERIES_PER_INVOCATION);

      for (const account of thirty) {
        const token = await accessTokenFor(account.id);
        const status = await get(token, `/api/v1/statuses/${toThirty.id}`);
        expect(status.status, account.username).toBe(200);
        expectContract(ApiStatus, status.body);
        const conversations = expectContract(
          z.array(ApiConversation),
          (await get(token, "/api/v1/conversations")).body,
        );
        expect(
          conversations.map((conversation) => conversation.last_status?.id),
          account.username,
        ).toContain(toThirty.id);
        const notifications = expectContract(
          z.array(ApiNotification),
          (await get(token, "/api/v1/notifications?types[]=mention")).body,
        );
        expect(
          notifications.filter(
            (notification) =>
              notification.type === "mention" && notification.status?.id === toThirty.id,
          ),
          account.username,
        ).toHaveLength(1);
      }
    },
  );
});
