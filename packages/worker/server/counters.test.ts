import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { accessTokenFor, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";
import { purgeAccount } from "./admin-actions";
import { RemoteAccountId } from "./remote-account-id";

/**
 * The counters migration 0140 keeps in `account_stats` and `status_stats`
 * must equal counting the rows they summarize. A seeded random run sends
 * local API requests and signed remote activities (posts, replies, deletes,
 * favourites, boosts, quotes, follows, requests, answers, undos), deletes an
 * account and a remote actor, then compares every counter with its count.
 */

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const ORIGIN = "https://example.com";

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const IdBody = z.object({ id: z.string() });

const api = async (token: string, method: string, path: string, body?: unknown) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: unknown = await response.json().catch(() => undefined);
  return { status: response.status, json };
};

const rows = async <T>(schema: z.ZodType<T>, sql: string): Promise<T[]> =>
  parseRows(schema, (await env.DB.prepare(sql).all()).results);

const AccountCountsRow = z.object({
  id: z.string(),
  statuses: z.number(),
  followers: z.number(),
  following: z.number(),
});
const StatusCountsRow = z.object({
  id: z.string(),
  favourites: z.number(),
  reblogs: z.number(),
  quotes: z.number(),
  replies: z.number(),
});

/** What the counters must hold, counted from the rows themselves. */
const countedAccounts = () =>
  rows(
    AccountCountsRow,
    `SELECT a.id,
       (SELECT COUNT(*) FROM statuses WHERE account_id = a.id) AS statuses,
       (SELECT COUNT(*) FROM follows WHERE target_account_id = a.id AND kind = 'Accepted')
         + (SELECT COUNT(*) FROM remote_follows WHERE target_account_id = a.id AND follow_kind = 'Accepted')
         AS followers,
       (SELECT COUNT(*) FROM follows WHERE follower_account_id = a.id AND kind = 'Accepted')
         + (SELECT COUNT(*) FROM outbound_follows WHERE account_id = a.id AND state = 'Accepted')
         AS following
     FROM accounts a`,
  );

const DISTRIBUTED = "('public', 'unlisted')";

const countedStatuses = () =>
  rows(
    StatusCountsRow,
    `WITH targets(id, uri) AS (
       SELECT s.id, '${ORIGIN}/users/' || a.username || '/statuses/' || s.id
       FROM statuses s JOIN accounts a ON a.id = s.account_id
       UNION ALL
       SELECT id, object_uri FROM remote_statuses
     )
     SELECT t.id,
       (SELECT COUNT(*) FROM favourites WHERE local_status_id = t.id OR remote_status_id = t.id)
         + (SELECT COUNT(*) FROM remote_favourites WHERE status_id = t.id) AS favourites,
       (SELECT COUNT(*) FROM statuses
        WHERE kind = 'LocalReblog' AND (reblog_of_id = t.id OR reblog_of_remote_id = t.id))
         + (SELECT COUNT(*) FROM remote_announces WHERE status_id = t.id) AS reblogs,
       (SELECT COUNT(*) FROM status_quotes
        WHERE state = 'accepted' AND (quoted_status_id = t.id OR quoted_remote_status_id = t.id))
         AS quotes,
       (SELECT COUNT(*) FROM statuses
        WHERE kind = 'LocalNote' AND visibility IN ${DISTRIBUTED}
          AND (in_reply_to_id = t.id OR (in_reply_to_id IS NULL AND in_reply_to_uri = t.uri)))
         + (SELECT COUNT(*) FROM remote_statuses
            WHERE visibility IN ${DISTRIBUTED} AND in_reply_to_uri = t.uri AND id <> t.id)
         AS replies
     FROM targets t`,
  );

const keptAccounts = () =>
  rows(
    AccountCountsRow,
    `SELECT account_id AS id, statuses_count AS statuses, followers_count AS followers,
       following_count AS following FROM account_stats`,
  );

const keptStatuses = () =>
  rows(
    StatusCountsRow,
    `SELECT status_id AS id, favourites_count AS favourites, reblogs_count AS reblogs,
       quotes_count AS quotes, replies_count AS replies FROM status_stats`,
  );

/** Counted and kept values side by side, leaving out ids where both are zero. */
const compare = async () => {
  const nonZero = <T extends { id: string }>(list: T[], zero: (row: T) => boolean) =>
    Object.fromEntries(list.filter((row) => !zero(row)).map((row) => [row.id, row]));
  const zeroAccount = (row: z.infer<typeof AccountCountsRow>) =>
    row.statuses === 0 && row.followers === 0 && row.following === 0;
  const zeroStatus = (row: z.infer<typeof StatusCountsRow>) =>
    row.favourites === 0 && row.reblogs === 0 && row.quotes === 0 && row.replies === 0;
  const statusIds = new Set((await countedStatuses()).map((row) => row.id));
  const orphans = (await keptStatuses()).filter((row) => !statusIds.has(row.id));
  return {
    accounts: {
      kept: nonZero(await keptAccounts(), zeroAccount),
      counted: nonZero(await countedAccounts(), zeroAccount),
    },
    statuses: {
      kept: nonZero(await keptStatuses(), zeroStatus),
      counted: nonZero(await countedStatuses(), zeroStatus),
    },
    orphans,
  };
};

const expectConsistent = async () => {
  const state = await compare();
  expect(state.accounts.kept).toEqual(state.accounts.counted);
  expect(state.statuses.kept).toEqual(state.statuses.counted);
  expect(state.orphans).toEqual([]);
  return state;
};

type LocalUser = Readonly<{ id: string; username: string; token: string }>;
type Posted = Readonly<{ id: string; uri: string; local: boolean }>;

describe("trigger-kept counters", () => {
  it("equal counting the rows after a random run of writes", { timeout: 120_000 }, async () => {
    const random = mulberry32(140);
    const pick = <T>(list: ReadonlyArray<T>): T | undefined =>
      list[Math.floor(random() * list.length)];
    const chance = (p: number) => random() < p;

    const locals: LocalUser[] = [];
    for (const name of ["ctr-ann", "ctr-ben", "ctr-cat", "ctr-dan"]) {
      const account = await signedInAccount(`${name}@example.com`);
      locals.push({
        id: account.id,
        username: account.username,
        token: await accessTokenFor(account.id),
      });
    }
    const [ann, , , dan] = locals;
    if (!ann || !dan) throw new Error("accounts");
    await env.DB.prepare("UPDATE accounts SET locked = 1 WHERE id = ?").bind(ann.id).run();
    const remotes: Remote[] = [];
    for (const name of ["ctr-rx", "ctr-ry", "ctr-rz"]) {
      remotes.push(await remoteActor(name, "counters.example"));
    }
    const [, , rz] = remotes;
    if (!rz) throw new Error("remotes");

    const posted: Posted[] = [];
    const localPosts = new Map<string, LocalUser>();
    const remotePosts = new Map<string, Remote>();
    const pendingParents: string[] = [];
    let serial = 0;
    const next = () => (serial += 1);
    const tally = new Map<string, number>();
    const done = (kind: string, ok: boolean) => {
      if (ok) tally.set(kind, (tally.get(kind) ?? 0) + 1);
    };
    const actorUriOf = (user: LocalUser) => `${ORIGIN}/users/${user.username}`;
    const remoteAddressing = (author: Remote) => {
      const followers = `${author.actorUri}/followers`;
      const roll = random();
      return roll < 0.5
        ? { to: [PUBLIC], cc: [followers] }
        : roll < 0.8
          ? { to: [followers], cc: [PUBLIC] }
          : { to: [followers], cc: [] };
    };
    const remoteNote = (author: Remote, uri: string, inReplyTo: string | undefined) => ({
      id: uri,
      type: "Note",
      attributedTo: author.actorUri,
      content: `<p>${uri}</p>`,
      published: new Date(Date.UTC(2026, 10, 1, 0, 0, serial)).toISOString(),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...remoteAddressing(author),
    });
    const storeRemote = async (author: Remote, uri: string, inReplyTo: string | undefined) => {
      const status = await author.send({
        id: `${uri}/activity`,
        type: "Create",
        object: remoteNote(author, uri, inReplyTo),
      });
      const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
        .bind(uri)
        .first<{ id: string }>();
      if (status === 202 && row) {
        posted.push({ id: row.id, uri, local: false });
        remotePosts.set(uri, author);
      }
      return status === 202;
    };

    const localPost = async (user: LocalUser) => {
      const parent = chance(0.6) ? pick(posted) : undefined;
      const quoted = chance(0.25) ? pick(posted.filter((post) => post.local)) : undefined;
      const visibility = pick(["public", "public", "public", "unlisted", "private", "direct"]);
      const result = await api(user.token, "POST", "/api/v1/statuses", {
        status: `post ${next()} @${pick(locals)?.username ?? ""}`,
        visibility,
        ...(parent ? { in_reply_to_id: parent.id } : {}),
        ...(quoted ? { quoted_status_id: quoted.id } : {}),
      });
      const created = IdBody.safeParse(result.json);
      if (result.status === 200 && created.success) {
        const id = created.data.id;
        posted.push({ id, uri: `${actorUriOf(user)}/statuses/${id}`, local: true });
        localPosts.set(id, user);
      }
      done(parent ? "local reply" : quoted ? "local quote" : "local post", result.status === 200);
    };
    const localOps: Array<(user: LocalUser) => Promise<void>> = [
      localPost,
      localPost,
      localPost,
      async (user) => {
        const own = posted.filter((post) => localPosts.get(post.id) === user);
        const target = pick(own);
        if (!target) return;
        const result = await api(user.token, "DELETE", `/api/v1/statuses/${target.id}`);
        done("local delete", result.status === 200);
      },
      async (user) => {
        const target = pick(posted);
        if (!target) return;
        const action = chance(0.5) ? "favourite" : "reblog";
        const result = await api(user.token, "POST", `/api/v1/statuses/${target.id}/${action}`);
        done(`local ${action}`, result.status === 200);
        if (result.status === 200 && chance(0.4)) {
          const undone = await api(user.token, "POST", `/api/v1/statuses/${target.id}/un${action}`);
          done(`local un${action}`, undone.status === 200);
        }
      },
      async (user) => {
        const other = pick(locals.filter((candidate) => candidate !== user));
        if (!other) return;
        const action = chance(0.7) ? "follow" : "unfollow";
        const result = await api(user.token, "POST", `/api/v1/accounts/${other.id}/${action}`);
        done(`local ${action}`, result.status === 200);
      },
      async (user) => {
        const remote = pick(remotes);
        if (!remote) return;
        const remoteId = RemoteAccountId.encode(remote.actorUri);
        const action = chance(0.7) ? "follow" : "unfollow";
        const result = await api(user.token, "POST", `/api/v1/accounts/${remoteId}/${action}`);
        done(`outbound ${action}`, result.status === 200);
        if (action === "follow" && chance(0.7)) {
          const row = await env.DB.prepare(
            "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
          )
            .bind(user.id, remote.actorUri)
            .first<{ follow_activity_id: string }>();
          if (row) {
            const answer = chance(0.8) ? "Accept" : "Reject";
            const status = await remote.send({
              id: `${remote.actorUri}#answers/${next()}`,
              type: answer,
              object: row.follow_activity_id,
            });
            done(`outbound ${answer}`, status === 202);
          }
        }
      },
      async (user) => {
        if (user !== ann) return;
        const requests = await api(user.token, "GET", "/api/v1/follow_requests");
        const requester = pick(z.array(IdBody).catch([]).parse(requests.json));
        if (!requester) return;
        const action = chance(0.75) ? "authorize" : "reject";
        const result = await api(
          user.token,
          "POST",
          `/api/v1/follow_requests/${requester.id}/${action}`,
        );
        done(`request ${action}`, result.status === 200);
      },
      async (user) => {
        const quote = await env.DB.prepare(
          `SELECT q.id, q.quoted_status_id, q.status_id, q.remote_status_id FROM status_quotes q
           JOIN statuses s ON s.id = q.quoted_status_id
           WHERE s.account_id = ? AND q.state = 'accepted' LIMIT 1`,
        )
          .bind(user.id)
          .first<{
            quoted_status_id: string;
            status_id: string | null;
            remote_status_id: string;
          }>();
        if (!quote) return;
        const result = await api(
          user.token,
          "POST",
          `/api/v1/statuses/${quote.quoted_status_id}/quotes/${quote.status_id ?? quote.remote_status_id}/revoke`,
        );
        done("quote revoke", result.status === 200);
      },
    ];

    const remoteOps: Array<(remote: Remote) => Promise<void>> = [
      async (remote) => {
        const parent = chance(0.6) ? pick(posted) : undefined;
        if (chance(0.15)) {
          // A reply that arrives before its parent, which is cached later.
          const parentUri = `https://counters.example/notes/late-${next()}`;
          pendingParents.push(parentUri);
          done(
            "remote early reply",
            await storeRemote(remote, `https://counters.example/notes/${next()}`, parentUri),
          );
          return;
        }
        const late = chance(0.3) ? pendingParents.shift() : undefined;
        const uri = late ?? `https://counters.example/notes/${next()}`;
        done(
          late ? "remote late parent" : "remote note",
          await storeRemote(remote, uri, parent?.uri),
        );
      },
      async (remote) => {
        const own = posted.filter((post) => remotePosts.get(post.uri) === remote);
        const target = pick(own);
        if (!target) return;
        const roll = random();
        if (roll < 0.3) {
          // A Create the actor sends again, addressed anew, refreshes the cached note.
          const row = await env.DB.prepare(
            "SELECT in_reply_to_uri FROM remote_statuses WHERE id = ?",
          )
            .bind(target.id)
            .first<{ in_reply_to_uri: string | null }>();
          const status = await remote.send({
            id: `${target.uri}#create-${next()}`,
            type: "Create",
            object: remoteNote(remote, target.uri, row?.in_reply_to_uri ?? undefined),
          });
          done("remote recreate", status === 202);
        } else if (roll < 0.6) {
          const status = await remote.send({
            id: `${target.uri}#delete-${next()}`,
            type: "Delete",
            object: { id: target.uri, type: "Tombstone" },
          });
          done("remote delete", status === 202);
        } else {
          const row = await env.DB.prepare(
            "SELECT in_reply_to_uri FROM remote_statuses WHERE id = ?",
          )
            .bind(target.id)
            .first<{ in_reply_to_uri: string | null }>();
          const status = await remote.send({
            id: `${target.uri}#update-${next()}`,
            type: "Update",
            object: {
              ...remoteNote(remote, target.uri, row?.in_reply_to_uri ?? undefined),
              updated: new Date(Date.UTC(2026, 10, 2, 0, 0, next())).toISOString(),
            },
          });
          done("remote update", status === 202);
        }
      },
      async (remote) => {
        const target = pick(posted.filter((post) => post.local));
        if (!target) return;
        const type = chance(0.5) ? "Like" : "Announce";
        const activity = {
          id: `${remote.actorUri}#${type}-${next()}`,
          type,
          object: target.uri,
          ...(type === "Announce" ? { to: [PUBLIC], published: new Date().toISOString() } : {}),
        };
        const status = await remote.send(activity);
        done(`remote ${type}`, status === 202);
        if (chance(0.35)) {
          const undo = await remote.send({
            id: `${activity.id}/undo`,
            type: "Undo",
            object: { ...activity, actor: remote.actorUri },
          });
          done(`remote undo ${type}`, undo === 202);
        }
      },
      async (remote) => {
        const target = pick(locals);
        if (!target) return;
        const follow = {
          id: `${remote.actorUri}#follows/${next()}`,
          type: "Follow",
          object: actorUriOf(target),
        };
        const status = await remote.send(follow);
        done("remote follow", status === 202);
        if (chance(0.3)) {
          const undo = await remote.send({
            id: `${follow.id}/undo`,
            type: "Undo",
            object: { ...follow, actor: remote.actorUri },
          });
          done("remote unfollow", undo === 202);
        }
      },
      async (remote) => {
        const target = pick(posted.filter((post) => post.local));
        if (!target) return;
        const uri = `https://counters.example/notes/quote-${next()}`;
        const status = await remote.send({
          id: `${remote.actorUri}/quote_requests/${next()}`,
          type: "QuoteRequest",
          object: target.uri,
          instrument: {
            ...remoteNote(remote, uri, undefined),
            to: [PUBLIC],
            quote: target.uri,
          },
        });
        const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
          .bind(uri)
          .first<{ id: string }>();
        if (row) {
          posted.push({ id: row.id, uri, local: false });
          remotePosts.set(uri, remote);
        }
        done("remote quote", status === 202);
      },
    ];

    // Counters each checkpoint saw above zero, so the comparisons cover every trigger.
    const seen = { favourites: 0, reblogs: 0, quotes: 0, replies: 0 };
    const checkpoint = async () => {
      const state = await expectConsistent();
      for (const row of Object.values(state.statuses.counted)) {
        seen.favourites += row.favourites;
        seen.reblogs += row.reblogs;
        seen.quotes += row.quotes;
        seen.replies += row.replies;
      }
    };
    for (let step = 1; step <= 260; step += 1) {
      if (chance(0.6)) {
        const user = pick(locals);
        const op = pick(localOps);
        if (user && op) await op(user);
      } else {
        const remote = pick(remotes);
        const op = pick(remoteOps);
        if (remote && op) await op(remote);
      }
      if (step % 5 === 0) {
        await checkpoint();
      }
    }
    for (const parentUri of pendingParents) {
      done("remote late parent", await storeRemote(rz, parentUri, undefined));
    }
    await checkpoint();
    expect(seen.favourites).toBeGreaterThan(0);
    expect(seen.reblogs).toBeGreaterThan(0);
    expect(seen.quotes).toBeGreaterThan(0);
    expect(seen.replies).toBeGreaterThan(0);
    expect(Object.fromEntries(tally)).toMatchObject({
      "local delete": expect.any(Number),
      "local unfavourite": expect.any(Number),
      "local unreblog": expect.any(Number),
      "local unfollow": expect.any(Number),
      "outbound Accept": expect.any(Number),
      "request authorize": expect.any(Number),
      "quote revoke": expect.any(Number),
      "remote early reply": expect.any(Number),
      "remote late parent": expect.any(Number),
      "remote delete": expect.any(Number),
      "remote update": expect.any(Number),
      "remote undo Like": expect.any(Number),
      "remote undo Announce": expect.any(Number),
      "remote unfollow": expect.any(Number),
      "remote quote": expect.any(Number),
    });

    // Deleting an account and a remote actor cascades through every table.
    expect((await purgeAccount(env, dan.id)).isOk()).toBe(true);
    expect(
      await rz.send({ id: `${rz.actorUri}#delete-self`, type: "Delete", object: rz.actorUri }),
    ).toBe(202);
    await expectConsistent();

    // The migration's backfill computes the same counters from scratch.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM account_stats"),
      env.DB.prepare("DELETE FROM status_stats"),
    ]);
    const migrations = z
      .array(z.object({ name: z.string(), queries: z.array(z.string()) }))
      .parse(Reflect.get(env, "TEST_MIGRATIONS"));
    const migration = migrations.find((entry) => entry.name.startsWith("0140_"));
    const backfill = (migration?.queries ?? []).filter((query) =>
      /^(?:\s*--[^\n]*\n)*\s*INSERT INTO (account|status)_stats/.test(query),
    );
    expect(backfill.length).toBeGreaterThan(0);
    await env.DB.batch(backfill.map((query) => env.DB.prepare(query)));
    await expectConsistent();
  });

  it("follow writes to the counted columns that no request makes today", async () => {
    // Statements the app does not send, run on rows it did write: a later
    // write that moves a row to another owner, or inserts it accepted, stays counted.
    const [eve, fay] = await Promise.all(
      ["ctr-eve", "ctr-fay"].map(async (name) => {
        const account = await signedInAccount(`${name}@example.com`);
        return { ...account, token: await accessTokenFor(account.id) };
      }),
    );
    if (!eve || !fay) throw new Error("accounts");
    const remote = await remoteActor("ctr-rw", "counters.example");
    const post = async (token: string) =>
      IdBody.parse((await api(token, "POST", "/api/v1/statuses", { status: "row" })).json).id;
    const first = await post(eve.token);
    const second = await post(fay.token);
    const eveUri = `${ORIGIN}/users/${eve.username}`;
    const firstUri = `${eveUri}/statuses/${first}`;
    await api(fay.token, "POST", `/api/v1/statuses/${first}/favourite`);
    await api(fay.token, "POST", `/api/v1/statuses/${first}/reblog`);
    await api(eve.token, "POST", `/api/v1/accounts/${fay.id}/follow`);
    await api(eve.token, "POST", "/api/v1/statuses", {
      status: "quoting",
      quoted_status_id: first,
    });
    for (const activity of [
      { type: "Like", object: firstUri },
      { type: "Announce", object: firstUri, to: [PUBLIC] },
      { type: "Follow", object: eveUri },
      {
        type: "Create",
        object: {
          id: "https://counters.example/notes/rw-reply",
          type: "Note",
          attributedTo: remote.actorUri,
          content: "<p>reply</p>",
          published: "2026-11-01T00:00:00.000Z",
          inReplyTo: firstUri,
          to: [PUBLIC],
        },
      },
    ]) {
      expect(await remote.send({ id: `${remote.actorUri}#${activity.type}`, ...activity })).toBe(
        202,
      );
    }
    await expectConsistent();
    expect((await keptStatuses()).find((row) => row.id === first)).toEqual({
      id: first,
      favourites: 2,
      reblogs: 2,
      quotes: 1,
      replies: 1,
    });

    for (const sql of [
      `UPDATE favourites SET local_status_id = '${second}' WHERE local_status_id = '${first}'`,
      `UPDATE remote_favourites SET status_id = '${second}' WHERE status_id = '${first}'`,
      `UPDATE remote_announces SET status_id = '${second}' WHERE status_id = '${first}'`,
      `UPDATE statuses SET reblog_of_id = '${second}' WHERE reblog_of_id = '${first}'`,
      `UPDATE statuses SET kind = 'LocalNote' WHERE reblog_of_id = '${second}'`,
      `UPDATE status_quotes SET quoted_status_id = '${second}' WHERE quoted_status_id = '${first}'`,
      `UPDATE remote_statuses SET visibility = 'private' WHERE actor_uri = '${remote.actorUri}'`,
      `UPDATE remote_statuses SET visibility = 'public' WHERE actor_uri = '${remote.actorUri}'`,
      `UPDATE remote_statuses SET in_reply_to_uri = '${ORIGIN}/users/${fay.username}/statuses/${second}'
       WHERE actor_uri = '${remote.actorUri}'`,
      `UPDATE follows SET target_account_id = '${eve.id}', follower_account_id = '${fay.id}'
       WHERE follower_account_id = '${eve.id}'`,
      `UPDATE remote_follows SET target_account_id = '${fay.id}' WHERE target_account_id = '${eve.id}'`,
      `INSERT INTO outbound_follows (id, account_id, actor_uri, follow_activity_id, state)
       VALUES ('ctr-rw-out', '${eve.id}', '${remote.actorUri}', '${eveUri}#follows/rw', 'Accepted')`,
      `UPDATE outbound_follows SET account_id = '${fay.id}' WHERE id = 'ctr-rw-out'`,
    ]) {
      await env.DB.prepare(sql).run();
      await expectConsistent();
    }
  });
});
