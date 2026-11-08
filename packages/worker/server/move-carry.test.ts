import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { type AccountRef, localRef, remoteRef } from "./account-ref";
import { RemoteAccountId } from "./remote-account-id";
import { findRemoteActorByUri } from "./remote-actor-store";
import { MOVE_PAGE_SIZE, moveCarryPage, startMovingFollows } from "./remote-move";
import { parseInstanceIdentity } from "./runtime-config";

const ORIGIN = "https://example.com";

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`response schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const call = async (email: string, path: string, method = "GET", body?: unknown) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { ...(await authHeaders(email)), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
};

const RelationshipSchema = z.object({
  following: z.boolean(),
  requested: z.boolean(),
  blocking: z.boolean(),
  muting: z.boolean(),
  muting_notifications: z.boolean(),
  note: z.string(),
});

const relationship = async (email: string, id: string) => {
  const found = read(
    z.array(RelationshipSchema),
    (await call(email, `/api/v1/accounts/relationships?id[]=${encodeURIComponent(id)}`)).body,
  )[0];
  if (!found) {
    throw new Error("no relationship");
  }
  return found;
};

const listMemberIds = async (email: string, listId: string) =>
  read(
    z.array(z.object({ id: z.string() })),
    (await call(email, `/api/v1/lists/${listId}/accounts`)).body,
  ).map((member) => member.id);

/** One end of a move: a local account or a cached remote actor, with its API id. */
type Party = Readonly<{ id: string; ref: AccountRef; remote?: Remote }>;

const identityOf = () => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    throw new Error("identity rejected");
  }
  return identity.value;
};

const localParty = async (slug: string): Promise<Party> => {
  const account = await signedInAccount(`${slug}@example.com`);
  return { id: account.id, ref: localRef(identityOf(), account) };
};

const remoteParty = async (slug: string, domain: string): Promise<Party> => {
  const remote = await remoteActor(slug, domain);
  const cached = await findRemoteActorByUri(env.DB, remote.actorUri);
  if (cached.isErr() || !cached.value) {
    throw new Error("remote actor not cached");
  }
  return {
    id: RemoteAccountId.encode(remote.actorUri),
    ref: remoteRef(cached.value),
    remote,
  };
};

const party = (kind: "local" | "remote", slug: string): Promise<Party> =>
  kind === "local" ? localParty(slug) : remoteParty(slug, `${slug}.example`);

/** `email` follows `target` for good: a remote target is made to accept. */
const follow = async (email: string, target: Party) => {
  expect((await call(email, `/api/v1/accounts/${target.id}/follow`, "POST", {})).status).toBe(200);
  if (!target.remote) {
    return;
  }
  const account = await signedInAccount(email);
  const row = await env.DB.prepare(
    "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
  )
    .bind(account.id, target.remote.actorUri)
    .first<{ follow_activity_id: string }>();
  if (!row) {
    throw new Error("no outbound follow");
  }
  expect(
    await target.remote.send({
      id: `${target.remote.actorUri}/accepts/${crypto.randomUUID()}`,
      type: "Accept",
      object: row.follow_activity_id,
    }),
  ).toBe(202);
};

/** Local accounts that followed, blocked, muted and noted `from` before it moved. */
const audience = async (slug: string, from: Party) => {
  const fan = `${slug}-fan@example.com`;
  const blocker = `${slug}-blocker@example.com`;
  const muter = `${slug}-muter@example.com`;
  const noter = `${slug}-noter@example.com`;
  await follow(fan, from);
  const list = read(
    z.object({ id: z.string() }),
    (await call(fan, "/api/v1/lists", "POST", { title: `${slug} list` })).body,
  ).id;
  expect(
    (await call(fan, `/api/v1/lists/${list}/accounts`, "POST", { account_ids: [from.id] })).status,
  ).toBe(200);
  expect(
    (await call(fan, `/api/v1/accounts/${from.id}/note`, "POST", { comment: "met at the fair" }))
      .status,
  ).toBe(200);
  expect((await call(blocker, `/api/v1/accounts/${from.id}/block`, "POST")).status).toBe(200);
  expect(
    (await call(muter, `/api/v1/accounts/${from.id}/mute`, "POST", { notifications: false }))
      .status,
  ).toBe(200);
  expect(
    (await call(noter, `/api/v1/accounts/${from.id}/note`, "POST", { comment: "owes me a book" }))
      .status,
  ).toBe(200);
  return { fan, blocker, muter, noter, list };
};

const directions = [
  ["local", "local"],
  ["local", "remote"],
  ["remote", "local"],
  ["remote", "remote"],
] as const;

describe("what an account that moved carries over", () => {
  for (const [fromKind, toKind] of directions) {
    it(`carries follows, lists, notes, blocks and mutes ${fromKind} to ${toKind}`, async () => {
      const slug = `carry-${fromKind}-${toKind}`;
      const from = await party(fromKind, `${slug}-old`);
      const to = await party(toKind, `${slug}-new`);
      const people = await audience(slug, from);
      const bystander = `${slug}-bystander@example.com`;
      await signedInAccount(bystander);

      expect(
        (await startMovingFollows(env, identityOf(), from.ref, to.ref)).isOk(),
        "the move was carried over",
      ).toBe(true);

      const fan = await relationship(people.fan, to.id);
      expect(fan.following || fan.requested).toBe(true);
      expect(await relationship(people.fan, from.id)).toMatchObject({
        following: false,
        requested: false,
      });
      expect(await listMemberIds(people.fan, people.list)).toEqual([to.id]);
      expect((await relationship(people.fan, to.id)).note).toBe(
        `This user moved from ${acctOf(from)}, here were your previous notes about them:\nmet at the fair`,
      );

      expect(await relationship(people.blocker, to.id)).toMatchObject({
        blocking: true,
        note: `This user moved from ${acctOf(from)}, which you had blocked.`,
      });
      expect(await relationship(people.blocker, from.id)).toMatchObject({ blocking: true });

      expect(await relationship(people.muter, to.id)).toMatchObject({
        muting: true,
        muting_notifications: false,
        note: `This user moved from ${acctOf(from)}, which you had muted.`,
      });

      expect((await relationship(people.noter, to.id)).note).toBe(
        `This user moved from ${acctOf(from)}, here were your previous notes about them:\nowes me a book`,
      );
      expect(await relationship(bystander, to.id)).toMatchObject({
        blocking: false,
        muting: false,
        note: "",
      });
    });
  }

  const acctOf = (side: Party): string =>
    side.ref.kind === "LocalAccount"
      ? side.ref.account.username
      : `${side.ref.actor.username}@${side.ref.actor.domain}`;

  it("does not block or mute for an account that already follows, blocks or mutes the target, and joins notes", async () => {
    const from = await localParty("carry-skip-old");
    const to = await localParty("carry-skip-new");
    const alreadyFollowing = "carry-skip-following@example.com";
    const alreadyBlocking = "carry-skip-blocking@example.com";
    const hasNote = "carry-skip-noted@example.com";
    for (const email of [alreadyFollowing, alreadyBlocking, hasNote]) {
      expect((await call(email, `/api/v1/accounts/${from.id}/block`, "POST")).status).toBe(200);
      expect((await call(email, `/api/v1/accounts/${from.id}/mute`, "POST", {})).status).toBe(200);
    }
    expect(
      (await call(alreadyFollowing, `/api/v1/accounts/${to.id}/follow`, "POST", {})).status,
    ).toBe(200);
    expect((await call(alreadyBlocking, `/api/v1/accounts/${to.id}/block`, "POST")).status).toBe(
      200,
    );
    expect(
      (await call(hasNote, `/api/v1/accounts/${from.id}/note`, "POST", { comment: "old" })).status,
    ).toBe(200);
    expect(
      (await call(hasNote, `/api/v1/accounts/${to.id}/note`, "POST", { comment: "new" })).status,
    ).toBe(200);

    await startMovingFollows(env, identityOf(), from.ref, to.ref);

    expect(await relationship(alreadyFollowing, to.id)).toMatchObject({
      following: true,
      blocking: false,
      muting: false,
      note: "",
    });
    expect(await relationship(alreadyBlocking, to.id)).toMatchObject({
      blocking: true,
      muting: true,
    });
    expect((await relationship(hasNote, to.id)).note).toBe(
      `This user moved from ${acctOf(from)}, here were your previous notes about them:\nold\n\n\nnew`,
    );

    // Carrying a move over again adds nothing.
    await startMovingFollows(env, identityOf(), from.ref, to.ref);
    expect((await relationship(hasNote, to.id)).note).toBe(
      `This user moved from ${acctOf(from)}, here were your previous notes about them:\nold\n\n\nnew`,
    );
  });

  it("keeps a follower who cannot follow the target on the old account with its lists", async () => {
    const from = await localParty("carry-refused-old");
    const to = await localParty("carry-refused-new");
    const fan = "carry-refused-fan@example.com";
    await follow(fan, from);
    const list = read(
      z.object({ id: z.string() }),
      (await call(fan, "/api/v1/lists", "POST", { title: "refused" })).body,
    ).id;
    await call(fan, `/api/v1/lists/${list}/accounts`, "POST", { account_ids: [from.id] });
    expect((await call(fan, `/api/v1/accounts/${to.id}/block`, "POST")).status).toBe(200);

    await startMovingFollows(env, identityOf(), from.ref, to.ref);

    expect(await relationship(fan, from.id)).toMatchObject({ following: true });
    expect(await listMemberIds(fan, list)).toEqual([from.id]);
  });

  it("carries a page at a time, going on to the next phase when one ends", async () => {
    const from = await localParty("carry-paged-old");
    const to = await localParty("carry-paged-new");
    const blockers = ["carry-paged-b1@example.com", "carry-paged-b2@example.com"];
    for (const email of blockers) {
      expect((await call(email, `/api/v1/accounts/${from.id}/block`, "POST")).status).toBe(200);
    }
    expect(MOVE_PAGE_SIZE).toBeGreaterThan(2);

    const first = await moveCarryPage(
      env,
      identityOf(),
      from.ref,
      to.ref,
      { phase: "follows", afterId: "" },
      1,
    );
    // No follows or notes: the first full page is the first blocker.
    const cursor = first.isOk() ? first.value : undefined;
    expect(cursor).toMatchObject({ phase: "blocks" });
    const carriedAfterFirst = await Promise.all(
      blockers.map(async (email) => (await relationship(email, to.id)).blocking),
    );
    expect(carriedAfterFirst.filter(Boolean)).toHaveLength(1);

    const second = await moveCarryPage(
      env,
      identityOf(),
      from.ref,
      to.ref,
      cursor ?? { phase: "follows", afterId: "" },
      1,
    );
    expect(second.isOk() && second.value).toMatchObject({ phase: "blocks" });
    const done = await moveCarryPage(
      env,
      identityOf(),
      from.ref,
      to.ref,
      second.isOk() && second.value ? second.value : { phase: "follows", afterId: "" },
      1,
    );
    expect(done.isOk() && done.value).toBe(undefined);
    for (const email of blockers) {
      expect(await relationship(email, to.id)).toMatchObject({ blocking: true });
    }
  });
});
