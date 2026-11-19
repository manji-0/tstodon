import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const HOUR_MS = 60 * 60 * 1000;

const json = async (email: string, path: string, init: RequestInit = {}) => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    ...init,
    headers: { ...(await authHeaders(email)), "content-type": "application/json" },
  });
  return { status: response.status, body: await response.json() };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T =>
  schemaResult(schema)(body)._unsafeUnwrap();

const StatusCounts = z.object({
  id: z.string(),
  uri: z.string(),
  favourites_count: z.number(),
  reblogs_count: z.number(),
});

const Relationship = z.object({ following: z.boolean(), requested: z.boolean() });

/**
 * A local account with a public status, and a remote actor that likes,
 * boosts, follows and blocks it, and undoes each, as Mastodon's
 * `ActivityPub::Activity::Undo` reads them.
 */
const scenario = async (name: string) => {
  const email = `undo-before-${name}@example.com`;
  const account = await signedInAccount(email);
  const posted = await json(email, "/api/v1/statuses", {
    method: "POST",
    body: JSON.stringify({ status: `undo before ${name}` }),
  });
  const status = read(StatusCounts, posted.body);
  const remote = await remoteActor(`undo-before-${name}`);
  const accountUri = `https://example.com/users/${account.username}`;
  const activity = (type: string, object: string) => ({
    id: `${remote.actorUri}/${type.toLowerCase()}s/${name}`,
    type,
    actor: remote.actorUri,
    object,
  });
  const like = activity("Like", status.uri);
  const announce = {
    ...activity("Announce", status.uri),
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: [`${remote.actorUri}/followers`],
  };
  const block = activity("Block", accountUri);
  const follow = activity("Follow", accountUri);
  const undo = (object: string | Record<string, unknown>, n = 1) =>
    remote.send({
      id: `${remote.actorUri}/undos/${name}-${n}`,
      type: "Undo",
      actor: remote.actorUri,
      object,
    });
  const counts = async () =>
    read(StatusCounts, (await json(email, `/api/v1/statuses/${status.id}`)).body);
  const blocks = async (): Promise<number> =>
    (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM remote_blocks WHERE actor_uri = ?")
        .bind(remote.actorUri)
        .first<{ n: number }>()
    )?.n ?? 0;
  const followers = async (): Promise<number> =>
    read(
      z.object({ followers_count: z.number() }),
      (await json(email, `/api/v1/accounts/${account.id}`)).body,
    ).followers_count;
  return { remote, like, announce, block, follow, undo, counts, blocks, followers };
};

describe("an Undo handled before the activity it undoes", () => {
  it("drops a Like that comes after its Undo", async () => {
    const { remote, like, undo, counts } = await scenario("like");
    expect(await undo(like)).toBe(202);
    expect(await remote.send(like)).toBe(202);
    expect((await counts()).favourites_count).toBe(0);
  });

  it("drops an Announce that comes after its Undo", async () => {
    const { remote, announce, undo, counts } = await scenario("announce");
    expect(await undo(announce)).toBe(202);
    expect(await remote.send(announce)).toBe(202);
    expect((await counts()).reblogs_count).toBe(0);
  });

  it("drops a Block that comes after its Undo", async () => {
    const { remote, block, undo, blocks } = await scenario("block");
    expect(await undo(block)).toBe(202);
    expect(await remote.send(block)).toBe(202);
    expect(await blocks()).toBe(0);
  });

  it("keeps a Like with another id", async () => {
    const { remote, like, undo, counts } = await scenario("relike");
    expect(await undo(like)).toBe(202);
    expect(await remote.send({ ...like, id: `${like.id}-again` })).toBe(202);
    expect((await counts()).favourites_count).toBe(1);
  });

  it("forgets the Undo after six hours, as Mastodon does", async () => {
    const { remote, like, undo, counts } = await scenario("forgotten");
    expect(await undo(like)).toBe(202);
    await env.DB.prepare("UPDATE undone_before_arrival SET created_at = ? WHERE actor_uri = ?")
      .bind(new Date(Date.now() - 6 * HOUR_MS - 1000).toISOString(), remote.actorUri)
      .run();
    expect(await remote.send(like)).toBe(202);
    expect((await counts()).favourites_count).toBe(1);
  });
});

describe("an Undo that names its activity by URI only", () => {
  it("ends the Announce, Follow and Block it names", async () => {
    const { remote, announce, follow, block, undo, counts, blocks, followers } =
      await scenario("by-uri");
    // The Block ends a follow, so it comes first.
    for (const activity of [block, announce, follow]) {
      expect(await remote.send(activity)).toBe(202);
    }
    expect((await counts()).reblogs_count).toBe(1);
    expect(await blocks()).toBe(1);
    expect(await followers()).toBe(1);

    expect(await undo(announce.id, 1)).toBe(202);
    expect(await undo(follow.id, 2)).toBe(202);
    expect(await undo(block.id, 3)).toBe(202);
    expect((await counts()).reblogs_count).toBe(0);
    expect(await followers()).toBe(0);
    expect(await blocks()).toBe(0);
  });

  it("drops an activity with that URI that comes after it", async () => {
    const { remote, like, announce, undo, counts } = await scenario("by-uri-first");
    expect(await undo(like.id, 1)).toBe(202);
    expect(await undo(announce.id, 2)).toBe(202);
    expect(await remote.send(like)).toBe(202);
    expect(await remote.send(announce)).toBe(202);
    expect(await counts()).toMatchObject({ favourites_count: 0, reblogs_count: 0 });
  });

  it("leaves a Like it names in place, as Mastodon's try_undo_like", async () => {
    const { remote, like, undo, counts } = await scenario("by-uri-like");
    expect(await remote.send(like)).toBe(202);
    expect(await undo(like.id)).toBe(202);
    expect((await counts()).favourites_count).toBe(1);
  });
});

describe("an Undo(Accept)", () => {
  const followRemote = async (email: string, remote: Remote) => {
    const viewer = await signedInAccount(email);
    const remoteId = RemoteAccountId.encode(remote.actorUri);
    expect(
      (await json(email, `/api/v1/accounts/${remoteId}/follow`, { method: "POST" })).status,
    ).toBe(200);
    const row = await env.DB.prepare(
      "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
    )
      .bind(viewer.id, remote.actorUri)
      .first<{ follow_activity_id: string }>();
    const followId = row?.follow_activity_id ?? "";
    const accept = {
      id: `${remote.actorUri}/accepts/${viewer.id}`,
      type: "Accept",
      object: followId,
    };
    expect(await remote.send(accept)).toBe(202);
    const relationship = async () =>
      read(
        z.array(Relationship),
        (await json(email, `/api/v1/accounts/relationships?id[]=${remoteId}`)).body,
      )[0];
    return { accept, relationship };
  };

  it("turns the follow it accepted back into a request, as Mastodon's revoke_request!", async () => {
    const email = "undo-accept@example.com";
    const remote = await remoteActor("undo-accept-target");
    const { accept, relationship } = await followRemote(email, remote);
    expect(await relationship()).toMatchObject({ following: true, requested: false });
    expect(
      await remote.send({
        id: `${accept.id}/undo`,
        type: "Undo",
        actor: remote.actorUri,
        object: accept,
      }),
    ).toBe(202);
    expect(await relationship()).toMatchObject({ following: false, requested: true });
  });
});
