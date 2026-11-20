import { SELF, env } from "cloudflare:test";
import { FollowersSynchronization, type OutboxJob } from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { signedInAccount } from "../test/auth-fixture";
import { queueCapturingEnv } from "../test/queue-capture";
import { type Remote, remoteActor } from "../test/remote-actor-fixture";
import {
  acceptOutboundFollow,
  findOutboundFollow,
  insertOutboundFollow,
} from "./outbound-follow-store";
import { listOutboundActivities } from "./outbox-store";
import { findRemoteActorByUri } from "./remote-actor-store";
import { parseInstanceIdentity } from "./runtime-config";
import {
  prepareFollowersSynchronization,
  processSynchronizeFollowersJob,
} from "./remote-followers-synchronization";

const identity = parseInstanceIdentity(env)._unsafeUnwrap();

const local = (username: string): string => `https://example.com/users/${username}`;

const follow = async (
  accountId: string,
  remote: Remote,
  state: "Accepted" | "Requested",
): Promise<string> => {
  const followActivityId = `${local(accountId)}/follows/${crypto.randomUUID()}`;
  expect(
    (
      await insertOutboundFollow(env.DB, {
        id: crypto.randomUUID(),
        accountId,
        actorUri: remote.actorUri,
        followActivityId,
      })
    )._unsafeUnwrap(),
  ).toBe(true);
  if (state === "Accepted") {
    await acceptOutboundFollow(env.DB, {
      actorUri: remote.actorUri,
      followActivityId,
      accountId,
    });
  }
  return followActivityId;
};

const followState = async (accountId: string, remote: Remote) =>
  (await findOutboundFollow(env.DB, accountId, remote.actorUri))._unsafeUnwrap()?.state.kind;

const UndoSchema = z.object({ id: z.string(), type: z.literal("Undo") });

const undos = async (accountId: string): Promise<string[]> =>
  (await listOutboundActivities(env.DB, accountId, 50))
    ._unsafeUnwrap()
    .filter((activity) => activity.kind === "Undo")
    .map(
      (activity) => schemaResult(UndoSchema)(JSON.parse(activity.payload_json))._unsafeUnwrap().id,
    );

/** A remote actor with a followers collection, followed by local accounts. */
const scenario = async (name: string) => {
  const host = `sync-receive-${name}.example`;
  const remote = await remoteActor(`${name}-bob`, host, {
    followersUri: `https://${host}/users/${name}-bob/followers`,
  });
  const actor = (await findRemoteActorByUri(env.DB, remote.actorUri))._unsafeUnwrap();
  if (actor === undefined) {
    throw new Error("remote actor not cached");
  }
  const account = (suffix: string) => signedInAccount(`sync-receive-${name}-${suffix}@example.com`);
  const url = `https://${host}/users/${name}-bob/followers_synchronization`;
  const header = async (uris: ReadonlyArray<string>, overrides: Record<string, string> = {}) =>
    FollowersSynchronization.header({
      collectionId: `https://${host}/users/${name}-bob/followers`,
      digest: await FollowersSynchronization.digest(uris),
      url,
      ...overrides,
    });
  return { host, remote, actor, account, url, header };
};

describe("a Collection-Synchronization header received", () => {
  it("queues nothing when the digest matches the local followers", async () => {
    const { remote, actor, account, header } = await scenario("match");
    const alice = await account("alice");
    await follow(alice.id, remote, "Accepted");
    const sent: OutboxJob[] = [];
    await prepareFollowersSynchronization(
      queueCapturingEnv(sent),
      identity,
      actor,
      await header([local(alice.username)]),
    );
    expect(sent).toEqual([]);
  });

  it("queues one job when it differs, and not again while it is queued", async () => {
    const { remote, actor, account, header, url } = await scenario("differ");
    const alice = await account("alice");
    await follow(alice.id, remote, "Accepted");
    const sent: OutboxJob[] = [];
    const digest = await FollowersSynchronization.digest([]);
    for (let i = 0; i < 2; i += 1) {
      await prepareFollowersSynchronization(
        queueCapturingEnv(sent),
        identity,
        actor,
        await header([]),
      );
    }
    expect(sent).toEqual([
      { kind: "SynchronizeFollowers", actorUri: remote.actorUri, url, digest },
    ]);
  });

  it("ignores a header for another collection, a URL on another host, or one that does not parse", async () => {
    const { actor, header, host } = await scenario("ignored");
    const sent: OutboxJob[] = [];
    const capturing = queueCapturingEnv(sent);
    await prepareFollowersSynchronization(
      capturing,
      identity,
      actor,
      await header([], { collectionId: `https://${host}/users/other/followers` }),
    );
    await prepareFollowersSynchronization(
      capturing,
      identity,
      actor,
      await header([], { url: "https://elsewhere.example/followers_synchronization" }),
    );
    await prepareFollowersSynchronization(capturing, identity, actor, 'collectionId="a" url="b"');
    expect(sent).toEqual([]);
  });

  it("is read from a verified inbox POST", async () => {
    const { remote, header } = await scenario("inbox");
    const delivery = await remote.delivery({
      id: `${remote.actorUri}#likes/1`,
      type: "Like",
      object: "https://example.com/users/nobody/statuses/1",
    });
    delivery.headers.set("Collection-Synchronization", await header([remote.actorUri]));
    const response = await SELF.fetch(delivery);
    expect(response.status).toBe(202);
    const lock = await env.DB.prepare(
      "SELECT 1 AS held FROM followers_synchronization_locks WHERE actor_uri = ?",
    )
      .bind(remote.actorUri)
      .first();
    expect(lock).not.toBeNull();
  });
});

/** Run `body` while `fetch` serves `documents` by URL and 404s anything else. */
const serving = async <T>(
  documents: ReadonlyMap<string, unknown>,
  body: () => Promise<T>,
): Promise<{ result: T; fetched: string[] }> => {
  const original = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = async (input) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetched.push(href);
    const document = documents.get(href);
    return document === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(document), {
          headers: { "content-type": "application/activity+json" },
        });
  };
  try {
    return { result: await body(), fetched };
  } finally {
    globalThis.fetch = original;
  }
};

const collection = (id: string, orderedItems: ReadonlyArray<string>) => ({
  "@context": "https://www.w3.org/ns/activitystreams",
  id,
  type: "OrderedCollection",
  orderedItems,
});

describe("the SynchronizeFollowers job", () => {
  it("unfollows for each local account no longer listed, and keeps the listed ones", async () => {
    const { remote, account, url } = await scenario("remove");
    const alice = await account("alice");
    const carol = await account("carol");
    await follow(alice.id, remote, "Accepted");
    const carolFollow = await follow(carol.id, remote, "Accepted");
    const listed = [local(alice.username), "https://sync-receive-remove.example/users/x"];
    const digest = await FollowersSynchronization.digest(listed);
    const { result } = await serving(new Map([[url, collection(url, listed)]]), () =>
      processSynchronizeFollowersJob(env, {
        kind: "SynchronizeFollowers",
        actorUri: remote.actorUri,
        url,
        digest,
      }),
    );
    expect(result).toBe("ok");
    expect(await followState(alice.id, remote)).toBe("Accepted");
    expect(await followState(carol.id, remote)).toBeUndefined();
    expect(await undos(carol.id)).toEqual([`${carolFollow}/undo`]);
    expect(await undos(alice.id)).toEqual([]);
  });

  it("accepts a listed request and tells the actor to drop a follow this server does not hold", async () => {
    const { remote, account, url } = await scenario("listed");
    const erin = await account("erin");
    const dave = await account("dave");
    await follow(erin.id, remote, "Requested");
    const listed = [local(erin.username), local(dave.username)];
    await serving(new Map([[url, collection(url, listed)]]), () =>
      processSynchronizeFollowersJob(env, {
        kind: "SynchronizeFollowers",
        actorUri: remote.actorUri,
        url,
        digest: "0".repeat(64),
      }),
    );
    expect(await followState(erin.id, remote)).toBe("Accepted");
    expect(await followState(dave.id, remote)).toBeUndefined();
    expect(await undos(dave.id)).toEqual([`${local(dave.username)}#follows//undo`]);
    expect(await undos(erin.id)).toEqual([]);
  });

  it("removes nothing when the list does not add up to the digest", async () => {
    const { remote, account, url } = await scenario("mismatch");
    const carol = await account("carol");
    await follow(carol.id, remote, "Accepted");
    const digest = await FollowersSynchronization.digest([local(carol.username)]);
    await serving(new Map([[url, collection(url, [])]]), () =>
      processSynchronizeFollowersJob(env, {
        kind: "SynchronizeFollowers",
        actorUri: remote.actorUri,
        url,
        digest,
      }),
    );
    expect(await followState(carol.id, remote)).toBe("Accepted");
  });

  it("reads the `first` page and the pages after it, and removes nothing past ten", async () => {
    const { remote, account, url, host } = await scenario("pages");
    const alice = await account("alice");
    const carol = await account("carol");
    await follow(alice.id, remote, "Accepted");
    await follow(carol.id, remote, "Accepted");
    const page = (n: number) => `https://${host}/sync?page=${n}`;
    const pages = (last: number) =>
      new Map<string, unknown>([
        [url, { id: url, type: "OrderedCollection", first: page(1) }],
        ...Array.from({ length: last }, (_, i): [string, unknown] => [
          page(i + 1),
          {
            id: page(i + 1),
            type: "OrderedCollectionPage",
            orderedItems: i === 0 ? [local(alice.username)] : [],
            ...(i + 1 < last ? { next: page(i + 2) } : {}),
          },
        ]),
      ]);
    const run = (last: number) =>
      serving(pages(last), async () =>
        processSynchronizeFollowersJob(env, {
          kind: "SynchronizeFollowers",
          actorUri: remote.actorUri,
          url,
          digest: await FollowersSynchronization.digest([local(alice.username)]),
        }),
      );

    const tooLong = await run(11);
    expect(tooLong.fetched.filter((href) => href.startsWith(`https://${host}/sync`))).toHaveLength(
      10,
    );
    expect(await followState(carol.id, remote)).toBe("Accepted");

    await run(10);
    expect(await followState(alice.id, remote)).toBe("Accepted");
    expect(await followState(carol.id, remote)).toBeUndefined();
  });

  it("does not read a URL on another host than the actor's", async () => {
    const { remote, account } = await scenario("host");
    const carol = await account("carol");
    await follow(carol.id, remote, "Accepted");
    const elsewhere = "https://elsewhere.example/followers_synchronization";
    const { fetched } = await serving(new Map([[elsewhere, collection(elsewhere, [])]]), () =>
      processSynchronizeFollowersJob(env, {
        kind: "SynchronizeFollowers",
        actorUri: remote.actorUri,
        url: elsewhere,
      }),
    );
    expect(fetched).not.toContain(elsewhere);
    expect(await followState(carol.id, remote)).toBe("Accepted");
  });

  it("is tried again while the server does not answer, and frees its lock once run", async () => {
    const { remote, actor, url, header, account } = await scenario("lock");
    const alice = await account("alice");
    await follow(alice.id, remote, "Accepted");
    const sent: OutboxJob[] = [];
    await prepareFollowersSynchronization(
      queueCapturingEnv(sent),
      identity,
      actor,
      await header([]),
    );
    const [job] = sent;
    if (job?.kind !== "SynchronizeFollowers") {
      throw new Error("no job queued");
    }
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response("down", { status: 503 });
    try {
      expect(await processSynchronizeFollowersJob(env, job)).toBe("retry");
    } finally {
      globalThis.fetch = original;
    }
    await prepareFollowersSynchronization(
      queueCapturingEnv(sent),
      identity,
      actor,
      await header([]),
    );
    expect(sent).toHaveLength(1);

    await serving(new Map([[url, collection(url, [])]]), () =>
      processSynchronizeFollowersJob(env, job),
    );
    expect(await followState(alice.id, remote)).toBeUndefined();
    await follow((await account("carol")).id, remote, "Accepted");
    await prepareFollowersSynchronization(
      queueCapturingEnv(sent),
      identity,
      actor,
      await header([]),
    );
    expect(sent).toHaveLength(2);
  });
});
