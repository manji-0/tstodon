import { env } from "cloudflare:test";
import { FollowersSynchronization } from "@tstodon/domain";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { signedInAccount } from "../test/auth-fixture";
import { testIdentity } from "../test/domain-fixture";
import { meter, meterWork, patchD1, resetMeter } from "../test/meter";
import { collectionSynchronizationHeader } from "./followers-synchronization";

beforeAll(() => {
  patchD1();
});

/** `count` accepted remote followers of `accountId` on `host`, stored in a few statements. */
const seedFollowers = async (accountId: string, host: string, count: number): Promise<void> => {
  const chunk = 5000;
  for (let start = 0; start < count; start += chunk) {
    const uris = JSON.stringify(
      Array.from(
        { length: Math.min(chunk, count - start) },
        (_, i) => `https://${host}/users/f${start + i}`,
      ),
    );
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO remote_actors (actor_uri, username, domain, inbox_uri, public_key_id, public_key_pem, fetched_at)
         SELECT value, 'f', ?, value || '/inbox', value || '#main-key', 'pem', '2026-01-01T00:00:00.000Z'
         FROM json_each(?)`,
      ).bind(host, uris),
      env.DB.prepare(
        `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind)
         SELECT 'sync-cost-' || ? || '-' || key, value, ?, 'Fulfilled', 'Accepted' FROM json_each(?)`,
      ).bind(`${host}-${start}`, accountId, uris),
    ]);
  }
};

describe("the Collection-Synchronization digest's cost", () => {
  // Mastodon caches the digest per host until a follow changes; tstodon reads
  // it at each POST. The largest account that sends one has 24,999 followers.
  it("reads one statement over the followers on the inbox's host only", async () => {
    const { id, username } = await signedInAccount("sync-cost@example.com");
    await seedFollowers(id, "sync-cost-big.example", 24_000);
    await seedFollowers(id, "sync-cost-small.example", 999);

    resetMeter();
    const header = await meterWork(() =>
      collectionSynchronizationHeader(
        env.DB,
        testIdentity(),
        { id, username },
        "https://sync-cost-big.example/inbox",
      ),
    );
    const digest = await FollowersSynchronization.digest(
      Array.from({ length: 24_000 }, (_, i) => `https://sync-cost-big.example/users/f${i}`),
    );
    expect(header._unsafeUnwrap()).toContain(`digest="${digest}"`);
    expect(meter.tally.statements).toBe(1);
    expect(meter.tally.rowsRead).toBeLessThanOrEqual(24_001);

    resetMeter();
    await meterWork(() =>
      collectionSynchronizationHeader(
        env.DB,
        testIdentity(),
        { id, username },
        "https://sync-cost-small.example/inbox",
      ),
    );
    expect(meter.tally.rowsRead).toBeLessThanOrEqual(1_000);
  });
});
