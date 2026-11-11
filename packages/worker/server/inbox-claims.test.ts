import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { claimInboxActivity, inboxActivityState, releaseStaleInboxClaims } from "./inbox-store";

const MINUTE_MS = 60_000;

const CountSchema = z.object({ count: z.number() });

/** How many times `remote`'s Block of the local account is recorded. */
const blocksRecorded = async (remote: Remote): Promise<number> => {
  const row = schemaResult(CountSchema)(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM remote_blocks WHERE actor_uri = ?")
      .bind(remote.actorUri)
      .first(),
  );
  if (row.isErr()) {
    throw new Error("count row rejected");
  }
  return row.value.count;
};

/** A remote actor and a Block of a new local account, sent as `remote.send(block)`. */
const blockScenario = async (name: string) => {
  const remote = await remoteActor(`claim-${name}`);
  const { username } = await signedInAccount(`claim-${name}@example.com`);
  const block = {
    id: `${remote.actorUri}#blocks/${name}`,
    type: "Block",
    object: `https://example.com/users/${username}`,
  };
  return { remote, block };
};

/** Make recording `remote`'s blocks fail until the returned function is called. */
const failBlocksFrom = async (remote: Remote): Promise<() => Promise<void>> => {
  const trigger = `fail_blocks_${remote.actorUri.replace(/\W/g, "_")}`;
  await env.DB.prepare(
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON remote_blocks
     WHEN NEW.actor_uri = '${remote.actorUri}'
     BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
  ).run();
  return async () => {
    await env.DB.prepare(`DROP TRIGGER ${trigger}`).run();
  };
};

const state = async (activityId: string) =>
  (await inboxActivityState(env.DB, activityId))._unsafeUnwrap();

describe("inbox claims", () => {
  it("applies an activity on the retry after its first apply failed", async () => {
    const { remote, block } = await blockScenario("retry");
    const restore = await failBlocksFrom(remote);
    expect(await remote.send(block)).toBe(500);
    await restore();
    expect(await blocksRecorded(remote)).toBe(0);
    expect(await state(block.id)).toBeUndefined();

    expect(await remote.send(block)).toBe(202);
    expect(await blocksRecorded(remote)).toBe(1);
    expect(await state(block.id)).toBe("Processed");
  });

  it("answers a redelivery of an applied activity with 202 and does not apply it again", async () => {
    const { remote, block } = await blockScenario("redelivery");
    expect(await remote.send(block)).toBe(202);
    expect(await blocksRecorded(remote)).toBe(1);
    await env.DB.prepare("DELETE FROM remote_blocks WHERE actor_uri = ?")
      .bind(remote.actorUri)
      .run();

    expect(await remote.send(block)).toBe(202);
    expect(await blocksRecorded(remote)).toBe(0);
  });

  it("answers 503 while another delivery holds the claim, and takes over a stale one", async () => {
    const { remote, block } = await blockScenario("in-flight");
    expect(
      (await claimInboxActivity(env.DB, { activityId: block.id, payload: block }))._unsafeUnwrap(),
    ).toEqual({ kind: "Acquired" });

    const response = await SELF.fetch(await remote.delivery(block));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await blocksRecorded(remote)).toBe(0);

    await env.DB.prepare("UPDATE inbox_activities SET created_at = ? WHERE activity_id = ?")
      .bind(new Date(Date.now() - 16 * MINUTE_MS).toISOString(), block.id)
      .run();
    expect(await remote.send(block)).toBe(202);
    expect(await blocksRecorded(remote)).toBe(1);
    expect(await state(block.id)).toBe("Processed");
  });

  it("lets one of two claims on an id take it", async () => {
    const activityId = "https://remote.example/activities/claim-race";
    const claim = () => claimInboxActivity(env.DB, { activityId, payload: {} });
    const claims = await Promise.all([claim(), claim()]);
    expect(claims.map((c) => c._unsafeUnwrap().kind).toSorted()).toEqual(["Acquired", "InFlight"]);
  });

  it("records a rejected activity as handled and answers its redelivery as a duplicate", async () => {
    const { remote } = await blockScenario("rejected");
    const unknown = { id: `${remote.actorUri}#reacts/1`, type: "EmojiReact", object: "x" };
    expect(await remote.send(unknown)).toBe(400);
    expect(await state(unknown.id)).toBe("Processed");
    expect(await remote.send(unknown)).toBe(202);
  });

  it("releases the claims left unfinished for over 15 minutes", async () => {
    const nowMs = Date.parse("2001-06-01T12:00:00.000Z");
    const insert = (id: string, minutesAgo: number, rowState: string) =>
      env.DB.prepare(
        "INSERT INTO inbox_activities (activity_id, kind, payload_json, created_at, state) VALUES (?, 'Received', '{}', ?, ?)",
      ).bind(id, new Date(nowMs - minutesAgo * MINUTE_MS).toISOString(), rowState);
    const base = "https://remote.example/activities/claim-release";
    await env.DB.batch([
      insert(`${base}/stale`, 16, "Processing"),
      insert(`${base}/fresh`, 14, "Processing"),
      insert(`${base}/handled`, 60, "Processed"),
    ]);
    expect((await releaseStaleInboxClaims(env.DB, nowMs))._unsafeUnwrap()).toBe(1);
    expect(await state(`${base}/stale`)).toBeUndefined();
    expect(await state(`${base}/fresh`)).toBe("Processing");
    expect(await state(`${base}/handled`)).toBe("Processed");
  });
});
