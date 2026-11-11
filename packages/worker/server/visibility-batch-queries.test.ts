import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import type { ThreadStatus } from "@tstodon/domain";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { quotedStatusAccess } from "./quoted-status-access";
import { findRemoteStatusesByIds } from "./remote-status-store";
import { findStatusesByIds } from "./status-store";
import { visibleThreadStatuses } from "./thread-context";
import { viewableStatusIds } from "./visibility-guard";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const IdRow = z.object({ id: z.string() });

/** `env.DB` that counts the statements prepared on it. */
const countingDb = (): Readonly<{ db: D1Database; prepared: () => number }> => {
  let count = 0;
  const db = new Proxy(env.DB, {
    get: (target, key) => {
      if (key === "prepare") {
        return (sql: string) => {
          count += 1;
          return target.prepare(sql);
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, prepared: () => count };
};

const posted = async (email: string, status: string): Promise<string> => {
  const response = await SELF.fetch("https://example.com/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ status, visibility: "public" }),
  });
  expect(response.status).toBe(200);
  const parsed = schemaResult(IdRow)(await response.json());
  if (parsed.isErr()) {
    throw new Error("status rejected");
  }
  return parsed.value.id;
};

/** `count` public statuses, each by its own local author, and as many remote ones. */
const statuses = async (prefix: string, count: number) => {
  const localIds: string[] = [];
  const remoteIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    localIds.push(await posted(`${prefix}-${index}@example.com`, `note ${index}`));
    const remote = await remoteActor(`${prefix}-remote-${index}`);
    const uri = `${remote.actorUri}/statuses/1`;
    expect(
      await remote.send({
        id: `${uri}/activity`,
        type: "Create",
        object: {
          id: uri,
          type: "Note",
          attributedTo: remote.actorUri,
          content: "<p>remote</p>",
          published: new Date().toISOString(),
          to: [PUBLIC],
        },
      }),
    ).toBe(202);
    const row = schemaResult(IdRow)(
      await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?").bind(uri).first(),
    );
    if (row.isErr()) {
      throw new Error("remote status missing");
    }
    remoteIds.push(row.value.id);
  }
  const locals = (await findStatusesByIds(env.DB, localIds))._unsafeUnwrap();
  const remotes = (await findRemoteStatusesByIds(env.DB, remoteIds))._unsafeUnwrap();
  return {
    locals: [...locals.values()],
    remotes: [...remotes.values()],
  };
};

/** Statements each check prepares for `count` statuses of each kind. */
const queriesFor = async (prefix: string, count: number, viewerId: string) => {
  const { locals, remotes } = await statuses(prefix, count);
  const nodes: ThreadStatus[] = [
    ...locals.map((status): ThreadStatus => ({ kind: "Local", status })),
    ...remotes.map((status): ThreadStatus => ({ kind: "Remote", status })),
  ];
  const measure = async (check: (db: D1Database) => Promise<unknown>) => {
    const { db, prepared } = countingDb();
    await check(db);
    return prepared();
  };
  return {
    viewable: await measure((db) => viewableStatusIds(db, locals, remotes, viewerId)),
    quotes: await measure((db) => quotedStatusAccess(db, locals, remotes, viewerId)),
    thread: await measure((db) => visibleThreadStatuses(db, nodes, viewerId)),
    shown: (await viewableStatusIds(env.DB, locals, remotes, viewerId)).size,
  };
};

/** D1 caps the queries one invocation may run, so a batch's checks must not grow with it. */
describe("visibility checks over many public statuses", () => {
  it("run as many queries for twelve statuses as for one", async () => {
    const viewerId = (await signedInAccount("vbq-viewer@example.com")).id;
    const one = await queriesFor("vbq-one", 1, viewerId);
    const twelve = await queriesFor("vbq-twelve", 12, viewerId);

    expect(twelve.viewable).toBe(one.viewable);
    expect(twelve.quotes).toBe(one.quotes);
    expect(twelve.thread).toBe(one.thread);
    expect([one.shown, twelve.shown]).toEqual([2, 24]);
  });
});
