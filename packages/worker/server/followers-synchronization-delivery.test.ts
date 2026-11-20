import { SELF, env } from "cloudflare:test";
import { FollowersSynchronization } from "@tstodon/domain";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { deliverTarget } from "../test/delivery-fixture";
import { type Remote, remoteActor } from "../test/remote-actor-fixture";
import { listOutboundActivities } from "./outbox-store";
import { prepareInboxDelivery } from "./delivery";
import { meter, meterWork, patchD1, resetMeter } from "../test/meter";

beforeAll(() => {
  patchD1();
});

const StatusIdSchema = z.object({ id: z.string().min(1) });

const followedBy = async (remote: Remote, username: string): Promise<void> => {
  expect(
    await remote.send({
      id: `${remote.actorUri}#follows/1`,
      type: "Follow",
      object: `https://example.com/users/${username}`,
    }),
  ).toBe(202);
};

const post = async (email: string, path: string, body: Record<string, string>) => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method: path.startsWith("/api/v1/statuses/") && !path.endsWith("reblog") ? "PUT" : "POST",
    headers: { ...(await authHeaders(email)), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return schemaResult(StatusIdSchema)(await response.json())._unsafeUnwrap().id;
};

/** The newest activity of `kind` the account queued. */
const queued = async (accountId: string, kind: string): Promise<string> => {
  const activities = (await listOutboundActivities(env.DB, accountId, 50))._unsafeUnwrap();
  const found = activities.find((activity) => activity.kind === kind);
  if (found === undefined) {
    throw new Error(`no ${kind} queued`);
  }
  return found.id;
};

/**
 * A local account followed by two actors on `sync-delivery-<name>.example`
 * and one on another host, and what its header to that host's inbox says.
 */
const scenario = async (name: string) => {
  const email = `sync-delivery-${name}@example.com`;
  const { id, username } = await signedInAccount(email);
  const host = `sync-delivery-${name}.example`;
  const bob = await remoteActor(`${name}-bob`, host);
  const carol = await remoteActor(`${name}-carol`, host);
  const erin = await remoteActor(`${name}-erin`, `other-${host}`);
  for (const remote of [bob, carol, erin]) {
    await followedBy(remote, username);
  }
  const actor = `https://example.com/users/${username}`;
  const expectedHeader = async (uris: ReadonlyArray<string>) =>
    FollowersSynchronization.header({
      collectionId: `${actor}/followers`,
      digest: await FollowersSynchronization.digest(uris),
      url: `${actor}/followers_synchronization`,
    });
  return { email, id, host, bob, carol, erin, expectedHeader };
};

describe("Collection-Synchronization on deliveries", () => {
  it("goes with a followers-only Create, its digest over the followers on the inbox's host", async () => {
    const { email, id, host, bob, carol, erin, expectedHeader } = await scenario("create");
    await post(email, "/api/v1/statuses", { status: "for followers", visibility: "private" });
    const activityId = await queued(id, "Create");

    const toHost = await deliverTarget(activityId, `https://${host}/inbox`);
    expect(toHost.headers.get("collection-synchronization")).toBe(
      await expectedHeader([bob.actorUri, carol.actorUri]),
    );
    const toOther = await deliverTarget(activityId, `https://other-${host}/inbox`);
    expect(toOther.headers.get("collection-synchronization")).toBe(
      await expectedHeader([erin.actorUri]),
    );
  });

  it("goes with the Update of a followers-only status", async () => {
    const { email, id, host, bob, carol, expectedHeader } = await scenario("update");
    const statusId = await post(email, "/api/v1/statuses", {
      status: "before",
      visibility: "private",
    });
    await post(email, `/api/v1/statuses/${statusId}`, { status: "after" });
    const delivered = await deliverTarget(await queued(id, "Update"), `https://${host}/inbox`);
    expect(delivered.headers.get("collection-synchronization")).toBe(
      await expectedHeader([bob.actorUri, carol.actorUri]),
    );
  });

  it("goes with a followers-only boost", async () => {
    const { email, id, host, bob, carol, expectedHeader } = await scenario("boost");
    const statusId = await post(email, "/api/v1/statuses", { status: "boost me" });
    await post(email, `/api/v1/statuses/${statusId}/reblog`, { visibility: "private" });
    const delivered = await deliverTarget(await queued(id, "Announce"), `https://${host}/inbox`);
    expect(delivered.headers.get("collection-synchronization")).toBe(
      await expectedHeader([bob.actorUri, carol.actorUri]),
    );
  });

  it("reads the followers of a host once for all its inboxes in one delivery step", async () => {
    const { email, id, host, bob, carol, expectedHeader } = await scenario("memo");
    await post(email, "/api/v1/statuses", { status: "for followers", visibility: "private" });
    const activityId = await queued(id, "Create");
    const sent: Request[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      sent.push(new Request(input, init));
      return new Response(null, { status: 202 });
    });
    resetMeter();
    try {
      await meterWork(async () => {
        const postTo = await prepareInboxDelivery(env, activityId);
        await postTo(`${bob.actorUri}/inbox`);
        await postTo(`${carol.actorUri}/inbox`);
        await postTo(`https://${host}/inbox`);
      });
    } finally {
      fetchSpy.mockRestore();
    }
    const expected = await expectedHeader([bob.actorUri, carol.actorUri]);
    const posted = sent.filter((request) => request.url.startsWith(`https://${host}/`));
    expect(posted.map((request) => request.headers.get("collection-synchronization"))).toEqual([
      expected,
      expected,
      expected,
    ]);
    expect(meter.tally.sql.filter((sql) => sql.includes("FROM remote_follows"))).toHaveLength(1);
  });

  it("does not go with a public status", async () => {
    const { email, id, host } = await scenario("public");
    await post(email, "/api/v1/statuses", { status: "for everyone" });
    const delivered = await deliverTarget(await queued(id, "Create"), `https://${host}/inbox`);
    expect(delivered.headers.has("collection-synchronization")).toBe(false);
  });

  it("does not go from an account with 25,000 followers", async () => {
    const { email, id, host } = await scenario("large");
    await env.DB.prepare("UPDATE account_stats SET followers_count = 25000 WHERE account_id = ?")
      .bind(id)
      .run();
    await post(email, "/api/v1/statuses", { status: "for followers", visibility: "private" });
    const delivered = await deliverTarget(await queued(id, "Create"), `https://${host}/inbox`);
    expect(delivered.headers.has("collection-synchronization")).toBe(false);
  });
});
