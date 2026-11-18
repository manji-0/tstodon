import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import type { OutboxJob } from "@tstodon/domain";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { meter, patchD1, resetMeter } from "../test/meter";
import { postForm, signUp } from "../test/passkey-browser";
import { drainJobs, queueCapturingEnv } from "../test/queue-capture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { AUTHORIZE_PAGE_SIZE, changeAccountLocked } from "./follow-request-approval";
import { parseInstanceIdentity } from "./runtime-config";

vi.setConfig({ testTimeout: 45_000 });

const ORIGIN = "https://example.com";
/** Half of D1's 1,000 statements per invocation: a page must leave room for the rest. */
const PAGE_STATEMENT_BUDGET = 500;

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const ActorUpdateSchema = z.object({
  type: z.literal("Update"),
  object: z.object({
    type: z.string(),
    manuallyApprovesFollowers: z.boolean(),
    discoverable: z.boolean(),
    indexable: z.boolean(),
  }),
});

/** The actor `Update`s the account queued, oldest first. */
const actorUpdates = async (accountId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT payload_json FROM outbound_activities WHERE account_id = ? AND kind = 'Update' ORDER BY rowid",
  )
    .bind(accountId)
    .all<{ payload_json: string }>();
  return results.map((row) => read(ActorUpdateSchema, JSON.parse(row.payload_json)).object);
};

/** The `Accept`s the account queued, with the inbox each goes to. */
const accepts = async (accountId: string) => {
  const { results } = await env.DB.prepare(
    `SELECT a.payload_json, d.inbox_url FROM outbound_activities a
     JOIN outbox_deliveries d ON d.activity_id = a.id AND d.inbox_url IS NOT NULL
     WHERE a.account_id = ? AND a.kind = 'Accept' ORDER BY a.rowid`,
  )
    .bind(accountId)
    .all<{ payload_json: string; inbox_url: string }>();
  return results.map((row) => ({
    inbox: row.inbox_url,
    follow: read(
      z.object({ type: z.literal("Accept"), object: z.object({ id: z.string() }) }),
      JSON.parse(row.payload_json),
    ).object.id,
  }));
};

const lock = async (accountId: string) =>
  env.DB.prepare("UPDATE accounts SET locked = 1 WHERE id = ?").bind(accountId).run();

const remoteRequestState = async (accountId: string, actorUri: string) =>
  (
    await env.DB.prepare(
      "SELECT remote_request_kind, follow_kind FROM remote_follows WHERE target_account_id = ? AND remote_actor_uri = ?",
    )
      .bind(accountId, actorUri)
      .first<{ remote_request_kind: string; follow_kind: string }>()
  )?.follow_kind;

const localFollowKind = async (followerId: string, targetId: string) =>
  (
    await env.DB.prepare(
      "SELECT kind FROM follows WHERE follower_account_id = ? AND target_account_id = ?",
    )
      .bind(followerId, targetId)
      .first<{ kind: string }>()
  )?.kind;

/** `remote` asks to follow the account; resolves to the `Follow`'s id. */
const requestFollow = async (remote: Remote, username: string): Promise<string> => {
  const id = `${remote.actorUri}/follows/unlock`;
  expect(await remote.send({ id, type: "Follow", object: `${ORIGIN}/users/${username}` })).toBe(
    202,
  );
  return id;
};

const unlockPaths = {
  "the privacy page": async (username: string) => {
    const { fetcher } = await signUp(username);
    const response = await postForm(fetcher, "/settings/privacy", {
      account_unlocked: "1",
      account_discoverable: "1",
      account_indexable: "1",
      account_show_collections: "1",
    });
    expect(response.status).toBe(200);
  },
  update_credentials: async (username: string) => {
    const response = await SELF.fetch(`${ORIGIN}/api/v1/accounts/update_credentials`, {
      method: "PATCH",
      headers: {
        ...(await authHeaders(`${username}@mail.example`)),
        "content-type": "application/json",
      },
      body: JSON.stringify({ locked: false }),
    });
    expect(response.status).toBe(200);
  },
} as const;

describe("saving the privacy page", () => {
  it("sends the actor Update with the flags it saved", async () => {
    const { fetcher, email } = await signUp("privacy_update");
    const account = await signedInAccount(email);

    await postForm(fetcher, "/settings/privacy", {
      account_unlocked: "1",
      account_indexable: "1",
    });
    await postForm(fetcher, "/settings/privacy", { account_discoverable: "1" });

    expect(await actorUpdates(account.id)).toEqual([
      expect.objectContaining({
        manuallyApprovesFollowers: false,
        discoverable: false,
        indexable: true,
      }),
      expect.objectContaining({
        manuallyApprovesFollowers: true,
        discoverable: true,
        indexable: false,
      }),
    ]);
  });
});

describe("unlocking an account", () => {
  for (const [path, unlock] of Object.entries(unlockPaths)) {
    it(`through ${path} accepts its pending requests, local and remote`, async () => {
      const username = `unlock_${path.replace(/\W/g, "_")}`;
      const email = `${username}@mail.example`;
      await signUp(username);
      const account = await signedInAccount(email);
      await lock(account.id);
      const local = await signedInAccount(`${username}_fan@example.com`);
      const followed = await SELF.fetch(`${ORIGIN}/api/v1/accounts/${account.id}/follow`, {
        method: "POST",
        headers: await authHeaders(`${username}_fan@example.com`),
      });
      expect(followed.status).toBe(200);
      const remote = await remoteActor(`${username}_remote`, "unlock.example");
      const followId = await requestFollow(remote, account.username);
      const silenced = await remoteActor(`${username}_silenced`, "unlock.example");
      await requestFollow(silenced, account.username);
      await env.DB.prepare(
        "INSERT INTO remote_actor_moderation (actor_uri, moderation) VALUES (?, 'Silenced')",
      )
        .bind(silenced.actorUri)
        .run();
      expect(await localFollowKind(local.id, account.id)).toBe("Pending");

      await unlock(username);

      expect(await localFollowKind(local.id, account.id)).toBe("Accepted");
      expect(await remoteRequestState(account.id, remote.actorUri)).toBe("Accepted");
      // As Mastodon's `authorize_all_follow_requests`, a silenced requester waits.
      expect(await remoteRequestState(account.id, silenced.actorUri)).not.toBe("Accepted");
      expect(await accepts(account.id)).toEqual([
        { inbox: `${remote.actorUri}/inbox`, follow: followId },
      ]);
      expect(await actorUpdates(account.id)).toEqual([
        expect.objectContaining({ manuallyApprovesFollowers: false }),
      ]);
    });
  }

  it("accepts more requests than a page holds in queued pages, each within its budget", async () => {
    const email = "unlock-many@example.com";
    await lock((await signedInAccount(email)).id);
    const account = await signedInAccount(email);
    const total = AUTHORIZE_PAGE_SIZE * 2 + 3;
    const fans = await Promise.all(
      Array.from({ length: total }, (_, index) => remoteActor(`fan${index}`, "unlock-many.test")),
    );
    await env.DB.batch(
      fans.map((fan, index) =>
        env.DB.prepare(
          `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, follow_activity_id, remote_request_kind, follow_kind, created_at)
           VALUES (?, ?, ?, ?, 'Queued', 'Pending', '2026-10-21T00:00:00.000Z')`,
        ).bind(`unlock-many-${index}`, fan.actorUri, account.id, `${fan.actorUri}/follows/1`),
      ),
    );
    const sent: OutboxJob[] = [];
    const target = queueCapturingEnv(sent);
    patchD1();
    const statements: number[] = [];
    const metered = async <T>(run: () => Promise<T>): Promise<T> => {
      resetMeter();
      const result = await run();
      statements.push(meter.tally.statements);
      return result;
    };

    const changed = await metered(() =>
      changeAccountLocked(target, parseInstanceIdentity(env)._unsafeUnwrap(), account, false),
    );
    expect(changed.isOk()).toBe(true);
    const outcomes = await drainJobs(target, sent, "AuthorizeFollowRequests", metered);

    expect(outcomes).toEqual(["ok", "ok"]);
    expect(statements).toHaveLength(3);
    for (const count of statements) {
      expect(count).toBeLessThan(PAGE_STATEMENT_BUDGET);
    }
    expect(await accepts(account.id)).toHaveLength(total);
  });
});
