import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { signedInAccount } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { listOutboundActivities } from "./outbox-store";

const HOUR_MS = 60 * 60 * 1000;

/**
 * A remote actor, a new local account, and the actor's Follow of it and that
 * Follow's Undo, as Mastodon sends them: two deliveries that Sidekiq runs at
 * once, so the Undo can be handled first.
 */
const scenario = async (name: string) => {
  const remote = await remoteActor(`undo-first-${name}`);
  const { id, username } = await signedInAccount(`undo-first-${name}@example.com`);
  const follow = (n: number) => ({
    id: `https://remote.example/follows/${name}-${n}`,
    type: "Follow",
    actor: remote.actorUri,
    object: `https://example.com/users/${username}`,
  });
  const undo = (n: number) => ({
    id: `${remote.actorUri}#follows/${n}/undo`,
    type: "Undo",
    actor: remote.actorUri,
    object: follow(n),
  });
  const followersCount = async (): Promise<number> => {
    const response = await SELF.fetch(`https://example.com/api/v1/accounts/${id}`);
    return schemaResult(z.object({ followers_count: z.number() }))(
      await response.json(),
    )._unsafeUnwrap().followers_count;
  };
  const accepts = async (): Promise<number> =>
    (await listOutboundActivities(env.DB, id, 50))
      ._unsafeUnwrap()
      .filter((activity) => activity.kind === "Accept").length;
  return { remote, follow, undo, followersCount, accepts };
};

describe("an Undo(Follow) handled before its Follow", () => {
  it("drops the Follow when it comes: no follower, no Accept", async () => {
    const { remote, follow, undo, followersCount, accepts } = await scenario("dropped");
    expect(await remote.send(undo(1))).toBe(202);
    expect(await remote.send(follow(1))).toBe(202);
    expect(await followersCount()).toBe(0);
    expect(await accepts()).toBe(0);
  });

  it("does not drop a later Follow with another id", async () => {
    const { remote, follow, undo, followersCount, accepts } = await scenario("refollow");
    expect(await remote.send(undo(1))).toBe(202);
    expect(await remote.send(follow(1))).toBe(202);
    expect(await remote.send(follow(2))).toBe(202);
    expect(await followersCount()).toBe(1);
    expect(await accepts()).toBe(1);
  });

  it("forgets the Undo after six hours, as Mastodon does", async () => {
    const { remote, follow, undo, followersCount } = await scenario("forgotten");
    expect(await remote.send(undo(1))).toBe(202);
    await env.DB.prepare("UPDATE undone_before_arrival SET created_at = ? WHERE actor_uri = ?")
      .bind(new Date(Date.now() - 6 * HOUR_MS - 1000).toISOString(), remote.actorUri)
      .run();
    expect(await remote.send(follow(1))).toBe(202);
    expect(await followersCount()).toBe(1);
  });
});
