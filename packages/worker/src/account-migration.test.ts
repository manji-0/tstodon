import { SELF, env } from "cloudflare:test";
import { OutboxJob } from "@tstodon/domain";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { accessTokenFor, authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { ORIGIN, postForm, read, signUp } from "../test/passkey-browser";
import { addAccountAlias } from "./account-alias-store";
import { findAccountByUsername } from "./account-store";
import { generateAccountKeys } from "./keys";
import { processOutboxJob } from "./outbox-job";
import { RemoteAccountId } from "./remote-account-id";

const jsonResponse = (body: unknown, type = "application/activity+json"): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": type } });

/** Answer the Worker's own outbound fetches of these URLs; anything else goes out as usual. */
const withFetched = async <T>(
  documents: Readonly<Record<string, unknown>>,
  work: () => Promise<T>,
): Promise<T> => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const document = documents[href];
    return document === undefined
      ? original(input, init)
      : jsonResponse(
          document,
          href.includes("/.well-known/webfinger") ? "application/jrd+json" : undefined,
        );
  };
  try {
    return await work();
  } finally {
    globalThis.fetch = original;
  }
};

const webfinger = (username: string, domain: string, actorUri: string) => ({
  [`https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${username}@${domain}`)}`]:
    {
      subject: `acct:${username}@${domain}`,
      links: [{ rel: "self", type: "application/activity+json", href: actorUri }],
    },
});

const ActorSchema = z.object({
  id: z.string(),
  alsoKnownAs: z.array(z.string()).optional(),
  movedTo: z.string().optional(),
});

const actor = async (username: string) => {
  const response = await SELF.fetch(`${ORIGIN}/users/${username}`, {
    headers: { Accept: "application/activity+json" },
  });
  expect(response.status).toBe(200);
  return read(ActorSchema, await response.json());
};

describe("moving from a different account", () => {
  it("lists an added alias as alsoKnownAs on the actor, until it is removed", async () => {
    const old = await remoteActor("alias-old", "old.example");
    const { fetcher } = await signUp("alias_new");

    const added = await withFetched(webfinger("alias-old", "old.example", old.actorUri), () =>
      postForm(fetcher, "/settings/aliases", { acct: "@alias-old@old.example" }),
    );
    expect(added.status).toBe(200);
    const page = await added.text();
    expect(page).toContain("alias-old@old.example");
    expect((await actor("alias_new")).alsoKnownAs).toEqual([old.actorUri]);

    const id = /name="id" value="([^"]+)"/.exec(page)?.[1] ?? "";
    const removed = await postForm(fetcher, "/settings/aliases/remove", { id });
    expect(removed.status).toBe(200);
    expect(await removed.text()).toContain("No aliases yet.");
    expect((await actor("alias_new")).alsoKnownAs).toBeUndefined();
  });

  it("refuses a handle that does not resolve, and the account itself", async () => {
    const { fetcher } = await signUp("alias_refused");

    const unknown = await postForm(fetcher, "/settings/aliases", { acct: "nobody" });
    expect(unknown.status).toBe(422);
    expect(await unknown.text()).toContain("No account was found");
    const self = await postForm(fetcher, "/settings/aliases", { acct: "alias_refused" });
    expect(self.status).toBe(422);
    expect((await actor("alias_refused")).alsoKnownAs).toBeUndefined();
  });

  it("needs a signed-in browser on this site", async () => {
    const signedOut = await SELF.fetch(`${ORIGIN}/settings/aliases`, { redirect: "manual" });
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get("location")).toBe("/auth/sign_in?return_to=%2Fsettings%2Faliases");

    const { fetcher } = await signUp("alias_cross_site");
    const crossSite = await fetcher("/settings/aliases", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "cross-site",
      },
      body: new URLSearchParams({ acct: "alias_refused" }).toString(),
    });
    expect(crossSite.status).toBe(403);
    expect((await actor("alias_cross_site")).alsoKnownAs).toBeUndefined();
  });
});

const localAccount = async (username: string) => {
  const found = await findAccountByUsername(env.DB, username);
  if (found.isErr() || !found.value) {
    throw new Error(`no account ${username}`);
  }
  return found.value;
};

const json = async (path: string, init?: RequestInit) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, init);
  return { status: response.status, body: await response.json() };
};

const followLocally = async (email: string, accountId: string) =>
  json(`/api/v1/accounts/${accountId}/follow`, {
    method: "POST",
    headers: { ...(await authHeaders(email)), "content-type": "application/json" },
    body: "{}",
  });

const RelationshipSchema = z.object({ following: z.boolean(), requested: z.boolean() });

const relationship = async (email: string, id: string) =>
  read(
    z.array(RelationshipSchema),
    (
      await json(`/api/v1/accounts/relationships?id[]=${encodeURIComponent(id)}`, {
        headers: await authHeaders(email),
      })
    ).body,
  )[0];

const NotificationSchema = z.object({
  type: z.string(),
  account: z.object({ id: z.string() }),
  target: z.object({ id: z.string() }).optional(),
});

const notifications = async (email: string) =>
  read(
    z.array(NotificationSchema),
    (await json("/api/v1/notifications", { headers: await authHeaders(email) })).body,
  );

const MovedSchema = z.object({ moved: z.object({ id: z.string() }).optional() });

const movedTo = async (accountId: string) =>
  read(MovedSchema, (await json(`/api/v1/accounts/${accountId}`)).body).moved?.id;

const post = async (accountId: string) =>
  json("/api/v1/statuses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await accessTokenFor(accountId)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ status: "still here?" }),
  });

/**
 * The inboxes the account's queued `Move` goes to, expanded as the outbox
 * queue does; `[]` when no `Move` was queued.
 */
const moveInboxes = async (accountId: string) => {
  const row = await env.DB.prepare(
    "SELECT id, payload_json FROM outbound_activities WHERE account_id = ? AND kind = 'Move' ORDER BY rowid DESC LIMIT 1",
  )
    .bind(accountId)
    .first<{ id: string; payload_json: string }>();
  if (!row) {
    return { activity: undefined, inboxes: [] };
  }
  const job = OutboxJob.parse({ kind: "ExpandFollowers", activityId: row.id });
  if (job.isErr()) {
    throw new Error("expand job rejected");
  }
  await processOutboxJob(env, job.value);
  const { results } = await env.DB.prepare(
    "SELECT inbox_url FROM outbox_deliveries WHERE activity_id = ? AND inbox_url IS NOT NULL ORDER BY inbox_url",
  )
    .bind(row.id)
    .all<{ inbox_url: string }>();
  return {
    activity: read(
      z.object({ type: z.string(), actor: z.string(), object: z.string(), target: z.string() }),
      JSON.parse(row.payload_json),
    ),
    inboxes: results.map((target) => target.inbox_url),
  };
};

/** A remote account's WebFinger and actor documents, listing `aliases` in `alsoKnownAs`. */
const remoteAccount = async (username: string, domain: string, aliases: ReadonlyArray<string>) => {
  const actorUri = `https://${domain}/users/${username}`;
  const keys = await generateAccountKeys();
  return {
    actorUri,
    id: RemoteAccountId.encode(actorUri),
    documents: {
      ...webfinger(username, domain, actorUri),
      [actorUri]: {
        id: actorUri,
        type: "Person",
        preferredUsername: username,
        inbox: `${actorUri}/inbox`,
        publicKey: { id: `${actorUri}#main-key`, owner: actorUri, publicKeyPem: keys.publicKeyPem },
        alsoKnownAs: aliases,
      },
    },
  };
};

describe("moving to a different account", () => {
  it("moves to a remote account that lists this one and tells every follower", async () => {
    const { fetcher } = await signUp("mover_out");
    const mover = await localAccount("mover_out");
    const moverUri = `${ORIGIN}/users/mover_out`;
    const sharedInbox = "https://followers.example/inbox";
    const fans = [
      await remoteActor("fan-one", "followers.example", { sharedInboxUri: sharedInbox }),
      await remoteActor("fan-two", "followers.example", { sharedInboxUri: sharedInbox }),
      await remoteActor("fan-solo", "solo.example"),
    ];
    for (const fan of fans) {
      expect(
        await fan.send({
          id: `${fan.actorUri}/follows/mover-out`,
          type: "Follow",
          object: moverUri,
        }),
      ).toBe(202);
    }
    const follower = "mover-out-local@example.com";
    expect((await followLocally(follower, mover.id)).status).toBe(200);
    const target = await remoteAccount("mover-out-new", "new.example", [moverUri]);

    const moved = await withFetched(target.documents, () =>
      postForm(fetcher, "/settings/migration", { acct: "mover-out-new@new.example" }),
    );
    expect(moved.status).toBe(200);
    expect(await moved.text()).toContain("Your followers are moving to mover-out-new@new.example");

    const delivered = await moveInboxes(mover.id);
    expect(delivered.activity).toMatchObject({
      type: "Move",
      actor: moverUri,
      object: moverUri,
      target: target.actorUri,
    });
    expect(delivered.inboxes).toEqual([sharedInbox, "https://solo.example/users/fan-solo/inbox"]);

    expect(await relationship(follower, mover.id)).toMatchObject({ following: false });
    expect(await relationship(follower, target.id)).toMatchObject({ requested: true });
    expect(await notifications(follower)).toMatchObject([
      { type: "move", account: { id: mover.id }, target: { id: target.id } },
    ]);
    expect(await movedTo(mover.id)).toBe(target.id);
    expect((await actor("mover_out")).movedTo).toBe(target.actorUri);
    const refused = await post(mover.id);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: "Your login is currently disabled" });
  });

  it("refuses a target that does not list this account", async () => {
    const { fetcher } = await signUp("mover_unlisted");
    const mover = await localAccount("mover_unlisted");
    const target = await remoteAccount("mover-unlisted-new", "new.example", [
      "https://elsewhere.example/users/someone",
    ]);

    const refused = await withFetched(target.documents, () =>
      postForm(fetcher, "/settings/migration", { acct: "mover-unlisted-new@new.example" }),
    );
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain("does not list this account as an alias");
    expect(await movedTo(mover.id)).toBeUndefined();
    expect((await actor("mover_unlisted")).movedTo).toBeUndefined();
    expect((await moveInboxes(mover.id)).activity).toBeUndefined();
    expect((await post(mover.id)).status).toBe(200);
  });

  it("moves local followers to a local target, then waits out the cooldown to move again", async () => {
    const { fetcher } = await signUp("mover_local");
    const mover = await localAccount("mover_local");
    const moverUri = `${ORIGIN}/users/mover_local`;
    const [first, second] = await Promise.all([
      signedInAccount("mover-local-first@example.com"),
      signedInAccount("mover-local-second@example.com"),
    ]);
    for (const target of [first, second]) {
      expect(
        (
          await addAccountAlias(env.DB, target.id, { acct: "mover_local", actorUri: moverUri })
        ).isOk(),
      ).toBe(true);
    }
    const follower = "mover-local-follower@example.com";
    expect((await followLocally(follower, mover.id)).status).toBe(200);

    const moved = await postForm(fetcher, "/settings/migration", { acct: first.username });
    expect(moved.status).toBe(200);
    expect(await relationship(follower, mover.id)).toMatchObject({ following: false });
    expect(await relationship(follower, first.id)).toMatchObject({ following: true });
    expect(await notifications(follower)).toMatchObject([
      { type: "move", account: { id: mover.id }, target: { id: first.id } },
    ]);
    expect(await movedTo(mover.id)).toBe(first.id);

    const again = await postForm(fetcher, "/settings/migration", { acct: second.username });
    expect(again.status).toBe(422);
    expect(await again.text()).toContain("You moved recently");
    expect((await actor("mover_local")).movedTo).toBe(`${ORIGIN}/users/${first.username}`);

    // Repeating the same move is allowed and changes nothing.
    expect((await postForm(fetcher, "/settings/migration", { acct: first.username })).status).toBe(
      200,
    );
    expect(await notifications(follower)).toHaveLength(1);
  });

  it("asks for a recent sign-in", async () => {
    const { fetcher } = await signUp("mover_stale");
    const mover = await localAccount("mover_stale");
    const target = await signedInAccount("mover-stale-new@example.com");
    await addAccountAlias(env.DB, target.id, {
      acct: "mover_stale",
      actorUri: `${ORIGIN}/users/mover_stale`,
    });
    await env.DB.prepare(
      `UPDATE "session" SET "createdAt" = "createdAt" - CASE WHEN "createdAt" > 100000000000 THEN 3600000 ELSE 3600 END
       WHERE "userId" = (SELECT auth_user_id FROM accounts WHERE id = ?)`,
    )
      .bind(mover.id)
      .run();

    const form = await fetcher("/settings/migration");
    expect(await form.text()).toContain("signInWithPasskey");
    const refused = await postForm(fetcher, "/settings/migration", { acct: target.username });
    expect(refused.status).toBe(403);
    expect(await movedTo(mover.id)).toBeUndefined();
  });
});

/** The `kind` activities the account queued, oldest first, as their JSON payloads. */
const queuedPayloads = async (accountId: string, kind: string) => {
  const { results } = await env.DB.prepare(
    "SELECT id, payload_json FROM outbound_activities WHERE account_id = ? AND kind = ? ORDER BY rowid",
  )
    .bind(accountId, kind)
    .all<{ id: string; payload_json: string }>();
  return results.map((row) => ({ id: row.id, payload: JSON.parse(row.payload_json) as unknown }));
};

const UpdateSchema = z.object({
  type: z.literal("Update"),
  actor: z.string(),
  object: z.object({ id: z.string(), type: z.string(), movedTo: z.string().optional() }),
});

/** The inboxes the queued activity `id` goes to, expanded as the outbox queue does. */
const inboxesOf = async (activityId: string) => {
  const job = OutboxJob.parse({ kind: "ExpandFollowers", activityId });
  if (job.isErr()) {
    throw new Error("expand job rejected");
  }
  await processOutboxJob(env, job.value);
  const { results } = await env.DB.prepare(
    "SELECT inbox_url FROM outbox_deliveries WHERE activity_id = ? AND inbox_url IS NOT NULL ORDER BY inbox_url",
  )
    .bind(activityId)
    .all<{ inbox_url: string }>();
  return results.map((row) => row.inbox_url);
};

const apiAs = async (accountId: string, path: string, method: string, body?: unknown) =>
  json(path, {
    method,
    headers: {
      Authorization: `Bearer ${await accessTokenFor(accountId)}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("an account that moved", () => {
  it("tells remote servers with an actor Update, and a cancelled redirect with another", async () => {
    const { fetcher } = await signUp("redirect_cancel");
    const mover = await localAccount("redirect_cancel");
    const moverUri = `${ORIGIN}/users/redirect_cancel`;
    const fan = await remoteActor("redirect-fan", "fans.example");
    expect(
      await fan.send({ id: `${fan.actorUri}/follows/redirect`, type: "Follow", object: moverUri }),
    ).toBe(202);
    const follower = "redirect-cancel-follower@example.com";
    expect((await followLocally(follower, mover.id)).status).toBe(200);
    const target = await remoteAccount("redirect-cancel-new", "new.example", [moverUri]);

    expect((await queuedPayloads(mover.id, "Update")).length).toBe(0);
    const moved = await withFetched(target.documents, () =>
      postForm(fetcher, "/settings/migration", { acct: "redirect-cancel-new@new.example" }),
    );
    expect(await moved.text()).toContain("Cancel redirect");
    const [update] = await queuedPayloads(mover.id, "Update");
    expect(update && read(UpdateSchema, update.payload)).toMatchObject({
      actor: moverUri,
      object: { id: moverUri, type: "Person", movedTo: target.actorUri },
    });
    expect(update && (await inboxesOf(update.id))).toEqual([`${fan.actorUri}/inbox`]);

    const cancelled = await postForm(fetcher, "/settings/migration/cancel", {});
    expect(cancelled.status).toBe(200);
    const page = await cancelled.text();
    expect(page).toContain("The redirect is cancelled");
    expect(page).not.toContain("Cancel redirect</button>");
    expect(page).toContain("You can move to a different account again after");

    expect((await actor("redirect_cancel")).movedTo).toBeUndefined();
    expect(await movedTo(mover.id)).toBeUndefined();
    expect((await post(mover.id)).status).toBe(200);
    const updates = await queuedPayloads(mover.id, "Update");
    expect(updates).toHaveLength(2);
    const [, undone] = updates;
    expect(undone && read(UpdateSchema, undone.payload).object.movedTo).toBeUndefined();
    expect(undone && (await inboxesOf(undone.id))).toEqual([`${fan.actorUri}/inbox`]);

    // The follower who moved stays moved.
    expect(await relationship(follower, target.id)).toMatchObject({ requested: true });
    expect(await relationship(follower, mover.id)).toMatchObject({ following: false });

    // The cooldown of the cancelled move still holds, for the same target too.
    const again = await withFetched(target.documents, () =>
      postForm(fetcher, "/settings/migration", { acct: "redirect-cancel-new@new.example" }),
    );
    expect(again.status).toBe(422);
    expect(await again.text()).toContain("You moved recently");
    expect((await actor("redirect_cancel")).movedTo).toBeUndefined();
  });

  it("has nothing to cancel before it moves, and only from this site", async () => {
    const { fetcher } = await signUp("redirect_none");
    const nothing = await postForm(fetcher, "/settings/migration/cancel", {});
    expect(nothing.status).toBe(422);
    expect(await nothing.text()).toContain("has not moved");

    const crossSite = await fetcher("/settings/migration/cancel", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "cross-site",
      },
      body: "",
    });
    expect(crossSite.status).toBe(403);
    const signedOut = await SELF.fetch(`${ORIGIN}/settings/migration/cancel`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: ORIGIN },
    });
    expect(signedOut.status).toBe(302);
  });

  it("can no longer follow, favourite, boost or edit, until the redirect is cancelled", async () => {
    const { fetcher } = await signUp("redirect_limits");
    const mover = await localAccount("redirect_limits");
    const target = await signedInAccount("redirect-limits-new@example.com");
    await addAccountAlias(env.DB, target.id, {
      acct: "redirect_limits",
      actorUri: `${ORIGIN}/users/redirect_limits`,
    });
    const other = await signedInAccount("redirect-limits-other@example.com");
    const own = read(
      z.object({ id: z.string() }),
      (await apiAs(mover.id, "/api/v1/statuses", "POST", { status: "before" })).body,
    ).id;
    const theirs = read(
      z.object({ id: z.string() }),
      (await apiAs(other.id, "/api/v1/statuses", "POST", { status: "from elsewhere" })).body,
    ).id;
    expect((await apiAs(mover.id, `/api/v1/statuses/${theirs}/favourite`, "POST")).status).toBe(
      200,
    );
    expect((await apiAs(mover.id, `/api/v1/statuses/${theirs}/unfavourite`, "POST")).status).toBe(
      200,
    );

    expect((await postForm(fetcher, "/settings/migration", { acct: target.username })).status).toBe(
      200,
    );

    const refusals = [
      ["POST", "/api/v1/statuses", { status: "after" }],
      ["PUT", `/api/v1/statuses/${own}`, { status: "edited" }],
      ["POST", `/api/v1/accounts/${other.id}/follow`, {}],
      ["POST", `/api/v1/statuses/${theirs}/favourite`, undefined],
      ["POST", `/api/v1/statuses/${theirs}/reblog`, undefined],
    ] as const;
    for (const [method, path, body] of refusals) {
      const refused = await apiAs(mover.id, path, method, body);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(refused.body).toMatchObject({ error: "Your login is currently disabled" });
    }
    expect((await apiAs(mover.id, "/api/v1/accounts/verify_credentials", "GET")).status).toBe(200);
    expect((await apiAs(mover.id, "/api/v1/timelines/home", "GET")).status).toBe(200);
    expect((await apiAs(other.id, `/api/v1/statuses/${theirs}/favourite`, "POST")).status).toBe(
      200,
    );

    expect((await postForm(fetcher, "/settings/migration/cancel", {})).status).toBe(200);
    expect((await apiAs(mover.id, `/api/v1/statuses/${theirs}/favourite`, "POST")).status).toBe(
      200,
    );
    expect(
      (await apiAs(mover.id, `/api/v1/statuses/${own}`, "PUT", { status: "edited" })).status,
    ).toBe(200);
  });
});
