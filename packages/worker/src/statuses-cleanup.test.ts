import { schemaResult } from "@tstodon/core";
import { AccountId, StatusesCleanupPolicy, type StatusesCleanupPolicyValue } from "@tstodon/domain";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { authHeaders } from "../test/auth-fixture";
import { entityIdAt } from "./ids";
import { processOutboxJob } from "./outbox-job";
import { listOutboundActivities } from "./outbox-store";
import {
  CLEANUP_DELETE_BATCH,
  CLEANUP_SCAN_BATCH,
  cleanUpAccountStatuses,
} from "./statuses-cleanup";
import { saveStatusesCleanupPolicy } from "./statuses-cleanup-store";

const DAY_MS = 24 * 60 * 60 * 1000;

const AccountSchema = z.object({ id: z.string() });

const accountId = async (email: string): Promise<string> => {
  const response = await SELF.fetch("https://example.com/api/v1/accounts/verify_credentials", {
    headers: await authHeaders(email),
  });
  expect(response.status).toBe(200);
  const parsed = schemaResult(AccountSchema)(await response.json());
  if (parsed.isErr()) {
    throw new Error("account schema rejected");
  }
  return parsed.value.id;
};

const policyWith = (
  rules: Partial<StatusesCleanupPolicyValue["rules"]> = {},
  kind: "Enabled" | "Disabled" = "Enabled",
): StatusesCleanupPolicyValue => ({
  kind,
  rules: { ...StatusesCleanupPolicy.default.rules, ...rules },
});

const saveCleanupPolicy = async (id: string, policy: StatusesCleanupPolicyValue) => {
  const saved = await saveStatusesCleanupPolicy(env.DB, id, policy);
  expect(saved.isOk()).toBe(true);
};

/** Insert a note published `ageDays` ago, with the id a note of that age has. */
const seedNote = async (
  owner: string,
  ageDays: number,
  visibility: "public" | "direct" = "public",
): Promise<string> => {
  const at = Date.now() - ageDays * DAY_MS;
  const id = entityIdAt(at);
  const stamp = new Date(at).toISOString();
  await env.DB.prepare(
    `INSERT INTO statuses (id, account_id, kind, content_text, content_html, visibility, created_at, updated_at)
     VALUES (?, ?, 'LocalNote', 'old post', '<p>old post</p>', ?, ?, ?)`,
  )
    .bind(id, owner, visibility, stamp, stamp)
    .run();
  return id;
};

const remaining = async (owner: string): Promise<string[]> => {
  const rows = await env.DB.prepare("SELECT id FROM statuses WHERE account_id = ? ORDER BY id")
    .bind(owner)
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
};

const run = (id: string) => {
  const accountId = AccountId.parse(id);
  if (accountId.isErr()) {
    throw new Error("invalid account id");
  }
  return processOutboxJob(env, { kind: "CleanUpAccountStatuses", accountId: accountId.value });
};

describe("automated post deletion job", () => {
  it("deletes old posts and keeps young ones and the ones a keep rule protects", async () => {
    const owner = await accountId("cleanup-rules@example.com");
    const other = await accountId("cleanup-rules-other@example.com");
    const doomed = await seedNote(owner, 30);
    const young = await seedNote(owner, 2);
    const pinned = await seedNote(owner, 31);
    const direct = await seedNote(owner, 32, "direct");
    const selfFavourited = await seedNote(owner, 33);
    const bookmarked = await seedNote(owner, 34);
    const poll = await seedNote(owner, 35);
    const media = await seedNote(owner, 36);
    const popular = await seedNote(owner, 37);
    const boosted = await seedNote(owner, 38);

    await env.DB.batch([
      env.DB.prepare("INSERT INTO status_pins (account_id, status_id) VALUES (?, ?)").bind(
        owner,
        pinned,
      ),
      env.DB.prepare("INSERT INTO favourites (account_id, status_id) VALUES (?, ?)").bind(
        owner,
        selfFavourited,
      ),
      env.DB.prepare("INSERT INTO bookmarks (account_id, status_id) VALUES (?, ?)").bind(
        owner,
        bookmarked,
      ),
      env.DB.prepare("UPDATE statuses SET poll_id = 'poll-1' WHERE id = ?").bind(poll),
      env.DB.prepare(
        "INSERT INTO polls (id, status_id, expires_at, options_json) VALUES ('poll-1', ?, ?, '[]')",
      ).bind(poll, new Date(Date.now() + DAY_MS).toISOString()),
      env.DB.prepare(
        "INSERT INTO media_attachments (id, account_id, status_id, object_key, content_type) VALUES ('media-1', ?, ?, 'cleanup/media-1', 'image/png')",
      ).bind(owner, media),
      env.DB.prepare("INSERT INTO favourites (account_id, status_id) VALUES (?, ?)").bind(
        other,
        popular,
      ),
      env.DB.prepare(
        "INSERT INTO statuses (id, account_id, kind, reblog_of_id, visibility) VALUES (?, ?, 'LocalReblog', ?, 'public')",
      ).bind(entityIdAt(Date.now() - 1000), other, boosted),
    ]);
    await saveCleanupPolicy(
      owner,
      policyWith({
        keepPolls: true,
        keepMedia: true,
        keepFavourites: { kind: "AtLeast", count: 1 },
        keepBoosts: { kind: "AtLeast", count: 1 },
      }),
    );

    expect(await run(owner)).toBe("ok");

    expect(await remaining(owner)).toEqual(
      [young, pinned, direct, selfFavourited, bookmarked, poll, media, popular, boosted].toSorted(),
    );
    expect(await remaining(owner)).not.toContain(doomed);
  });

  it("deletes nothing while the policy is disabled, and nothing for another account", async () => {
    const owner = await accountId("cleanup-off@example.com");
    const bystander = await accountId("cleanup-bystander@example.com");
    const mine = await seedNote(owner, 60);
    const theirs = await seedNote(bystander, 60);
    await saveCleanupPolicy(owner, policyWith({}, "Disabled"));

    await run(owner);
    expect(await remaining(owner)).toEqual([mine]);

    // The bystander never saved a policy; the owner's enabled one does not reach them.
    await saveCleanupPolicy(owner, policyWith());
    await run(owner);
    await run(bystander);
    expect(await remaining(owner)).toEqual([]);
    expect(await remaining(bystander)).toEqual([theirs]);
  });

  it("deletes at most one batch per run and finishes on the next", async () => {
    const owner = await accountId("cleanup-batch@example.com");
    const extra = 5;
    for (let index = 0; index < CLEANUP_DELETE_BATCH + extra; index += 1) {
      await seedNote(owner, 30 + index);
    }
    await saveCleanupPolicy(owner, policyWith());

    await run(owner);
    expect(await remaining(owner)).toHaveLength(extra);
    await run(owner);
    expect(await remaining(owner)).toHaveLength(0);
  });

  it("reaches old posts behind a long run of kept ones", async () => {
    const owner = await accountId("cleanup-behind@example.com");
    for (let index = 0; index < CLEANUP_SCAN_BATCH + 1; index += 1) {
      await seedNote(owner, 400 - index * 0.001, "direct");
    }
    const doomed = await seedNote(owner, 20);
    await saveCleanupPolicy(owner, policyWith());

    await run(owner);
    expect(await remaining(owner)).toContain(doomed);
    await run(owner);
    expect(await remaining(owner)).not.toContain(doomed);
    expect(await remaining(owner)).toHaveLength(CLEANUP_SCAN_BATCH + 1);
  });

  it("federates a Delete for each deleted public post and none for kept ones", async () => {
    const owner = await accountId("cleanup-federate@example.com");
    const doomed = await seedNote(owner, 30);
    const kept = await seedNote(owner, 31, "direct");
    await saveCleanupPolicy(owner, policyWith());

    await run(owner);

    const activities = await listOutboundActivities(env.DB, owner, 50);
    if (activities.isErr()) {
      throw new Error(activities.error.message);
    }
    const deletes = activities.value.filter((row) => row.kind === "Delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.payload_json).toContain(doomed);
    expect(deletes[0]?.payload_json).not.toContain(kept);
  });

  it("does not run for a policy that was never saved", async () => {
    const owner = await accountId("cleanup-default@example.com");
    const mine = await seedNote(owner, 90);
    await cleanUpAccountStatuses(env, owner);
    expect(await remaining(owner)).toEqual([mine]);
  });

  it("queues one run per account with the policy on", async () => {
    const on = await accountId("cleanup-queue-on@example.com");
    const off = await accountId("cleanup-queue-off@example.com");
    await saveCleanupPolicy(on, policyWith());
    await saveCleanupPolicy(off, policyWith({}, "Disabled"));
    const send = vi.spyOn(env.OUTBOX_PROCESS_QUEUE, "sendBatch").mockResolvedValue({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    });
    try {
      expect(await processOutboxJob(env, { kind: "CleanUpStatuses" })).toBe("ok");
      const bodies = send.mock.calls.flatMap(([messages]) =>
        [...messages].map((message) => message.body),
      );
      expect(bodies).toContainEqual({ kind: "CleanUpAccountStatuses", accountId: on });
      expect(bodies).not.toContainEqual({ kind: "CleanUpAccountStatuses", accountId: off });
    } finally {
      send.mockRestore();
    }
  });
});
