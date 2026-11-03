import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const json = async (path: string, init?: RequestInit) => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const send = async (email: string, path: string, method: string, body?: unknown) =>
  json(path, {
    method,
    headers: { ...(await authHeaders(email)), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const get = async (email: string, path: string) =>
  json(path, { headers: await authHeaders(email) });

const accountId = (remote: Remote): string => RemoteAccountId.encode(remote.actorUri);

const acceptedFollow = async (email: string, remote: Remote, slug: string) => {
  expect(
    (await send(email, `/api/v1/accounts/${accountId(remote)}/follow`, "POST", {})).status,
  ).toBe(200);
  const viewer = await signedInAccount(email);
  const row = await env.DB.prepare(
    "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
  )
    .bind(viewer.id, remote.actorUri)
    .first<{ follow_activity_id: string }>();
  expect(
    await remote.send({
      id: `${remote.actorUri}/accepts/${slug}`,
      type: "Accept",
      object: row?.follow_activity_id,
    }),
  ).toBe(202);
};

const createList = async (email: string, title: string): Promise<string> =>
  read(z.object({ id: z.string() }), (await send(email, "/api/v1/lists", "POST", { title })).body)
    .id;

const memberIds = async (email: string, listId: string): Promise<string[]> =>
  read(
    z.array(z.object({ id: z.string() })),
    (await get(email, `/api/v1/lists/${listId}/accounts`)).body,
  ).map((account) => account.id);

const listsContaining = async (email: string, id: string): Promise<string[]> =>
  read(
    z.array(z.object({ id: z.string() })),
    (await get(email, `/api/v1/accounts/${id}/lists`)).body,
  ).map((list) => list.id);

describe("remote accounts on lists", () => {
  it("adds a followed remote account next to a local one and removes it again", async () => {
    const remote = await remoteActor("list-member-remote");
    const owner = "list-remote-owner@example.com";
    const local = await signedInAccount("list-remote-local@example.com");
    await acceptedFollow(owner, remote, "list-member");
    const listId = await createList(owner, "Mixed");

    const added = await send(owner, `/api/v1/lists/${listId}/accounts`, "POST", {
      account_ids: [local.id, accountId(remote)],
    });
    expect(added.status).toBe(200);
    expect(await memberIds(owner, listId)).toEqual([local.id, accountId(remote)]);
    expect(await listsContaining(owner, accountId(remote))).toEqual([listId]);

    const removed = await send(owner, `/api/v1/lists/${listId}/accounts`, "DELETE", {
      account_ids: [accountId(remote)],
    });
    expect(removed.status).toBe(200);
    expect(await memberIds(owner, listId)).toEqual([local.id]);
    expect(await listsContaining(owner, accountId(remote))).toEqual([]);
  });

  it("refuses a remote account that is not followed, or only requested", async () => {
    const stranger = await remoteActor("list-stranger-remote");
    const requested = await remoteActor("list-requested-remote");
    const owner = "list-refusing-owner@example.com";
    const local = await signedInAccount("list-refused-local@example.com");
    expect(
      (await send(owner, `/api/v1/accounts/${accountId(requested)}/follow`, "POST", {})).status,
    ).toBe(200);
    const listId = await createList(owner, "Strangers");

    for (const remote of [stranger, requested]) {
      const added = await send(owner, `/api/v1/lists/${listId}/accounts`, "POST", {
        account_ids: [local.id, accountId(remote)],
      });
      expect(added.status).toBe(422);
    }
    expect(await memberIds(owner, listId)).toEqual([]);
  });

  it("drops the remote account from the owner's lists on unfollow", async () => {
    const remote = await remoteActor("list-unfollowed-remote");
    const owner = "list-unfollowing-owner@example.com";
    await acceptedFollow(owner, remote, "list-unfollowed");
    const first = await createList(owner, "First");
    const second = await createList(owner, "Second");
    for (const listId of [first, second]) {
      expect(
        (
          await send(owner, `/api/v1/lists/${listId}/accounts`, "POST", {
            account_ids: [accountId(remote)],
          })
        ).status,
      ).toBe(200);
    }
    expect((await listsContaining(owner, accountId(remote))).toSorted()).toEqual(
      [first, second].toSorted(),
    );

    expect(
      (await send(owner, `/api/v1/accounts/${accountId(remote)}/unfollow`, "POST")).status,
    ).toBe(200);
    expect(await listsContaining(owner, accountId(remote))).toEqual([]);
    expect(await memberIds(owner, first)).toEqual([]);

    await acceptedFollow(owner, remote, "list-refollowed");
    expect(await memberIds(owner, first)).toEqual([]);
  });
});
