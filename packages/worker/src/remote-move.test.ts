import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { generateAccountKeys } from "./keys";
import { RemoteAccountId } from "./remote-account-id";
import { MOVE_PAGE_SIZE, moveFollowPage } from "./remote-move";
import { findRemoteActorByUri } from "./remote-actor-store";
import { parseInstanceIdentity } from "./runtime-config";

const json = async (path: string, init?: RequestInit) => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  return { status: response.status, body: await response.json() };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const RelationshipSchema = z.object({
  following: z.boolean(),
  requested: z.boolean(),
  blocking: z.boolean(),
  showing_reblogs: z.boolean(),
  notifying: z.boolean(),
  languages: z.array(z.string()).nullable(),
});

const idOf = (remote: Remote | string) =>
  RemoteAccountId.encode(typeof remote === "string" ? remote : remote.actorUri);

const follow = async (email: string, remote: Remote, body: Record<string, unknown> = {}) =>
  json(`/api/v1/accounts/${idOf(remote)}/follow`, {
    method: "POST",
    headers: { ...(await authHeaders(email)), "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const relationship = async (email: string, remote: Remote | string) => {
  const response = await json(`/api/v1/accounts/relationships?id[]=${idOf(remote)}`, {
    headers: await authHeaders(email),
  });
  const found = read(z.array(RelationshipSchema), response.body)[0];
  if (!found) {
    throw new Error("no relationship");
  }
  return found;
};

/** The activities of `kind` queued for one inbox each, oldest first. */
const queued = async (email: string, kind: string) => {
  const account = await signedInAccount(email);
  const rows = await env.DB.prepare(
    `SELECT a.payload_json, d.inbox_url FROM outbound_activities a
     JOIN outbox_deliveries d ON d.activity_id = a.id AND d.inbox_url IS NOT NULL
     WHERE a.account_id = ? AND a.kind = ? ORDER BY a.rowid`,
  )
    .bind(account.id, kind)
    .all<{ payload_json: string; inbox_url: string }>();
  return rows.results.map((row) => ({
    inbox: row.inbox_url,
    activity: read(
      z.object({ id: z.string(), type: z.string(), actor: z.string(), object: z.unknown() }),
      JSON.parse(row.payload_json),
    ),
  }));
};

/** Follow `remote` as `email` and have it accept. */
const acceptedFollow = async (
  email: string,
  remote: Remote,
  slug: string,
  body: Record<string, unknown> = {},
) => {
  expect((await follow(email, remote, body)).status).toBe(200);
  const sent = await queued(email, "Follow");
  const sentToRemote = sent.filter((entry) => entry.inbox === `${remote.actorUri}/inbox`);
  const followId = sentToRemote.at(-1)?.activity.id;
  if (!followId) {
    throw new Error("no Follow was queued");
  }
  expect(
    await remote.send({
      id: `${remote.actorUri}/accepts/${slug}`,
      type: "Accept",
      object: followId,
    }),
  ).toBe(202);
};

const NotificationsSchema = z.array(
  z.object({
    type: z.string(),
    account: z.object({ id: z.string() }),
    target: z.object({ id: z.string() }).optional(),
  }),
);

const notifications = async (email: string) =>
  read(
    NotificationsSchema,
    (await json("/api/v1/notifications", { headers: await authHeaders(email) })).body,
  );

type Mover = Readonly<{
  /** The account that moves. */
  old: Remote;
  /** Where it moves to; cached, with its own key. */
  target: Remote;
  /** Sign and send a `Move` from `old`; `aliases` is what the target's document claims. */
  move: (
    id: string,
    options?: Readonly<{ aliases?: ReadonlyArray<string>; object?: string }>,
  ) => Promise<number>;
}>;

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/activity+json" } });

/**
 * An account on `old.example` and the account on `new.example` it moves to.
 * The target's actor document is served to the fetch the inbox makes for it.
 */
const mover = async (slug: string): Promise<Mover> => {
  const old = await remoteActor(`mover-${slug}`, "old.example");
  const target = await remoteActor(`mover-${slug}`, "new.example");
  const keys = await generateAccountKeys();
  const document = (aliases: ReadonlyArray<string>) => ({
    id: target.actorUri,
    type: "Person",
    preferredUsername: `mover-${slug}`,
    inbox: `${target.actorUri}/inbox`,
    publicKey: {
      id: `${target.actorUri}#main-key`,
      owner: target.actorUri,
      publicKeyPem: keys.publicKeyPem,
    },
    alsoKnownAs: aliases,
  });
  return {
    old,
    target,
    move: async (id, options = {}) => {
      const original = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const href =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return href === target.actorUri
          ? jsonResponse(document(options.aliases ?? [old.actorUri]))
          : original(input as RequestInfo, init);
      }) as typeof fetch;
      try {
        return await old.send({
          id: `${old.actorUri}/moves/${id}`,
          type: "Move",
          object: options.object ?? old.actorUri,
          target: target.actorUri,
        });
      } finally {
        globalThis.fetch = original;
      }
    },
  };
};

describe("a followed remote account moving", () => {
  it("moves the follow to the new account with the same options", async () => {
    const { old, target, move } = await mover("valid");
    const email = "mover-valid-follower@example.com";
    await acceptedFollow(email, old, "valid", { reblogs: false, notify: true, languages: ["en"] });

    expect(await move("valid")).toBe(202);

    expect(await relationship(email, old)).toMatchObject({ following: false, requested: false });
    expect(await relationship(email, target)).toMatchObject({
      following: false,
      requested: true,
      showing_reblogs: false,
      notifying: true,
      languages: ["en"],
    });
    const follows = await queued(email, "Follow");
    expect(follows.map((entry) => entry.inbox)).toEqual([
      `${old.actorUri}/inbox`,
      `${target.actorUri}/inbox`,
    ]);
    expect(follows[1]?.activity).toMatchObject({ type: "Follow", object: target.actorUri });
    const undone = await queued(email, "Undo");
    expect(undone.map((entry) => entry.inbox)).toEqual([`${old.actorUri}/inbox`]);

    const [moved] = await notifications(email);
    expect(moved?.type).toBe("move");
    expect(moved?.account.id).toBe(idOf(old));
    expect(moved?.target?.id).toBe(idOf(target));

    const account = await json(`/api/v1/accounts/${idOf(old)}`);
    expect(read(z.object({ moved: z.object({ id: z.string() }) }), account.body).moved.id).toBe(
      idOf(target),
    );
  });

  it("is ignored when the new account does not list the old one in alsoKnownAs", async () => {
    const { old, target, move } = await mover("no-alias");
    const email = "mover-no-alias-follower@example.com";
    await acceptedFollow(email, old, "no-alias");

    expect(await move("no-alias", { aliases: ["https://elsewhere.example/users/other"] })).toBe(
      202,
    );

    expect(await relationship(email, old)).toMatchObject({ following: true });
    expect(await relationship(email, target)).toMatchObject({ following: false, requested: false });
    expect(await queued(email, "Follow")).toHaveLength(1);
    expect(await notifications(email)).toHaveLength(0);
    const account = await json(`/api/v1/accounts/${idOf(old)}`);
    expect(Reflect.has(read(z.object({}).passthrough(), account.body), "moved")).toBe(false);
  });

  it("is ignored when the Move names an account other than its signer", async () => {
    const { target, move } = await mover("not-signer");
    const bystander = await remoteActor("mover-bystander", "old.example");
    const email = "mover-not-signer-follower@example.com";
    await acceptedFollow(email, bystander, "not-signer");

    expect(await move("not-signer", { object: bystander.actorUri })).toBe(202);

    expect(await relationship(email, bystander)).toMatchObject({ following: true });
    expect(await relationship(email, target)).toMatchObject({ following: false, requested: false });
    expect(await queued(email, "Follow")).toHaveLength(1);
  });

  it("does nothing new when the Move is delivered again", async () => {
    const { old, target, move } = await mover("redelivered");
    const email = "mover-redelivered-follower@example.com";
    await acceptedFollow(email, old, "redelivered");

    expect(await move("redelivered")).toBe(202);
    expect(await move("redelivered")).toBe(202);
    expect(await move("redelivered-again")).toBe(202);

    const toTarget = (await queued(email, "Follow")).filter(
      (entry) => entry.inbox === `${target.actorUri}/inbox`,
    );
    expect(toTarget).toHaveLength(1);
    expect(await queued(email, "Undo")).toHaveLength(1);
    expect(await notifications(email)).toHaveLength(1);
  });

  it("keeps the follow a follower already has of the new account", async () => {
    const { old, target, move } = await mover("already");
    const email = "mover-already-follower@example.com";
    await acceptedFollow(email, old, "already-old");
    await acceptedFollow(email, target, "already-new");

    expect(await move("already")).toBe(202);

    expect(await relationship(email, old)).toMatchObject({ following: false, requested: false });
    expect(await relationship(email, target)).toMatchObject({ following: true, requested: false });
    const toTarget = (await queued(email, "Follow")).filter(
      (entry) => entry.inbox === `${target.actorUri}/inbox`,
    );
    expect(toTarget).toHaveLength(1);
  });

  it("leaves the follow alone for a follower who blocks the new account", async () => {
    const { old, target, move } = await mover("blocked");
    const email = "mover-blocked-follower@example.com";
    await acceptedFollow(email, old, "blocked");
    expect(
      (
        await json(`/api/v1/accounts/${idOf(target)}/block`, {
          method: "POST",
          headers: await authHeaders(email),
        })
      ).status,
    ).toBe(200);

    expect(await move("blocked")).toBe(202);

    expect(await relationship(email, old)).toMatchObject({ following: true });
    expect(await relationship(email, target)).toMatchObject({ blocking: true, requested: false });
    expect(await queued(email, "Follow")).toHaveLength(1);
    expect(await queued(email, "Undo")).toHaveLength(0);
    expect(await notifications(email)).toHaveLength(0);
  });

  it("moves followers one page at a time", async () => {
    const { old, target } = await mover("paged");
    const emails = ["mover-paged-one@example.com", "mover-paged-two@example.com"];
    for (const email of emails) {
      await acceptedFollow(email, old, `paged-${email}`);
    }
    const identity = parseInstanceIdentity(env);
    const from = await findRemoteActorByUri(env.DB, old.actorUri);
    const to = await findRemoteActorByUri(env.DB, target.actorUri);
    if (identity.isErr() || from.isErr() || !from.value || to.isErr() || !to.value) {
      throw new Error("move fixture rejected");
    }
    expect(MOVE_PAGE_SIZE).toBeGreaterThan(2);

    const first = await moveFollowPage(env, identity.value, from.value, to.value, "", 1);
    const cursor = first.isOk() ? first.value : undefined;
    expect(cursor).toBeDefined();
    const movedAfterFirst = await Promise.all(
      emails.map(async (email) => (await relationship(email, target)).requested),
    );
    expect(movedAfterFirst.filter(Boolean)).toHaveLength(1);

    // A full page always hands on a cursor; the page after the last follow is empty.
    const second = await moveFollowPage(env, identity.value, from.value, to.value, cursor ?? "", 1);
    const rest = second.isOk() ? second.value : undefined;
    expect(rest).toBeDefined();
    const last = await moveFollowPage(env, identity.value, from.value, to.value, rest ?? "", 1);
    expect(last.isOk() && last.value).toBe(undefined);
    for (const email of emails) {
      expect(await relationship(email, target)).toMatchObject({ requested: true });
      expect(await relationship(email, old)).toMatchObject({ following: false });
    }
  });
});
