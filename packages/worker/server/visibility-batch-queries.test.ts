import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
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

type Audience = "public" | "private" | "direct";

const KINDS = { public: "Public", private: "FollowersOnly", direct: "Direct" } as const;

const posted = async (email: string, status: string, visibility: Audience): Promise<string> => {
  const response = await SELF.fetch("https://example.com/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ status, visibility }),
  });
  expect(response.status).toBe(200);
  const parsed = schemaResult(IdRow)(await response.json());
  if (parsed.isErr()) {
    throw new Error("status rejected");
  }
  return parsed.value.id;
};

/** Who a remote note with `visibility` is addressed to, mentioning `viewerUri` when restricted. */
const addressing = (actorUri: string, visibility: Audience, viewerUri: string) => {
  const mention = { tag: [{ type: "Mention", href: viewerUri }] };
  switch (visibility) {
    case "public":
      return { to: [PUBLIC] };
    case "private":
      return { to: [`${actorUri}/followers`], cc: [viewerUri], ...mention };
    case "direct":
      return { to: [viewerUri], ...mention };
  }
};

type Viewer = Readonly<{ id: string; username: string }>;

/**
 * `count` statuses with `visibility`, each by its own local author, and as
 * many remote ones; a restricted one mentions the viewer, so it is shown.
 */
const statuses = async (prefix: string, count: number, visibility: Audience, viewer: Viewer) => {
  const viewerUri = `https://example.com/users/${viewer.username}`;
  const text = visibility === "public" ? "note" : `@${viewer.username} note`;
  const localIds: string[] = [];
  const remoteIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    localIds.push(await posted(`${prefix}-${index}@example.com`, `${text} ${index}`, visibility));
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
          ...addressing(remote.actorUri, visibility, viewerUri),
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
const queriesFor = async (prefix: string, count: number, visibility: Audience, viewer: Viewer) => {
  const { locals, remotes } = await statuses(prefix, count, visibility, viewer);
  expect(new Set([...locals, ...remotes].map((status) => status.visibility.kind))).toEqual(
    new Set([KINDS[visibility]]),
  );
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
    viewable: await measure((db) => viewableStatusIds(db, locals, remotes, viewer.id)),
    quotes: await measure((db) => quotedStatusAccess(db, locals, remotes, viewer.id)),
    thread: await measure((db) => visibleThreadStatuses(db, nodes, viewer.id)),
    shown: (await viewableStatusIds(env.DB, locals, remotes, viewer.id)).size,
  };
};

/** D1 caps the queries one invocation may run, so a batch's checks must not grow with it. */
describe("visibility checks over many statuses", () => {
  it.each([
    ["public", 12],
    ["private", 6],
    ["direct", 6],
  ] as const)("run as many queries for %s statuses ×%i as for one", async (visibility, count) => {
    const viewer = await signedInAccount(`vbq-${visibility}-viewer@example.com`);
    const one = await queriesFor(`vbq-${visibility}-one`, 1, visibility, viewer);
    const many = await queriesFor(`vbq-${visibility}-many`, count, visibility, viewer);

    expect(many.viewable).toBe(one.viewable);
    expect(many.quotes).toBe(one.quotes);
    expect(many.thread).toBe(one.thread);
    expect([one.shown, many.shown]).toEqual([2, count * 2]);
  });
});

describe("a visibility lookup that fails", () => {
  it("hides the statuses it decides, and logs why", async () => {
    const viewer = await signedInAccount("vbq-failing-viewer@example.com");
    const open = await statuses("vbq-failing-open", 1, "public", viewer);
    const restricted = await statuses("vbq-failing-restricted", 1, "private", viewer);
    const failing = new Proxy(env.DB, {
      get: (target, key) => {
        if (key === "prepare") {
          return () => {
            throw new Error("D1 unavailable");
          };
        }
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const shown = await viewableStatusIds(
        failing,
        [...open.locals, ...restricted.locals],
        [...open.remotes, ...restricted.remotes],
        viewer.id,
      );
      expect([...shown]).toEqual([]);
      const kinds = logged.mock.calls.map(([line]) => JSON.parse(String(line)).kind);
      expect(new Set(kinds)).toEqual(new Set(["ViewerBlockersNotLoaded", "ViewerGrantsNotLoaded"]));
    } finally {
      logged.mockRestore();
    }
  });
});
