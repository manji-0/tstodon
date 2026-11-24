import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiScheduledStatus, ApiStatus } from "@tstodon/api";
import { OutboxJob } from "@tstodon/domain";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { deliveredCreate } from "../test/delivery-fixture";
import { parseRows } from "./d1";
import { processOutboxJob } from "./outbox-job";

// Mastodon v4.7.5 takes `visibility=limited` on `POST /api/v1/statuses`: the
// `visibility` enum holds it and `PostStatusService` stores what it is given.
// A local limited status is a direct one in all but name: `StatusPolicy`
// asks for a mention, `ActivityPub::TagManager` addresses it to its
// mentions, and `StatusReachFinder` delivers it to them. Where Mastodon
// tells the two apart (`direct_visibility?`), it is not direct: no
// conversation, no private-mention policy, and it counts in `statuses_count`.

const ORIGIN = "https://example.com";
const HOST = "local-limited.example";

const request = async (email: string | undefined, path: string, init: RequestInit = {}) =>
  SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(email === undefined ? {} : await authHeaders(email)),
    },
  });

const call = async (email: string, path: string, init: RequestInit = {}): Promise<unknown> => {
  const response = await request(email, path, init);
  expect(response.status, path).toBe(200);
  return response.json();
};

const post = async (email: string, body: Record<string, unknown>) =>
  expectContract(
    ApiStatus,
    await call(email, "/api/v1/statuses", { method: "POST", body: JSON.stringify(body) }),
  );

const storedVisibility = async (id: string): Promise<string | undefined> =>
  parseRows(
    z.object({ visibility: z.string() }),
    (await env.DB.prepare("SELECT visibility FROM statuses WHERE id = ?").bind(id).all()).results,
  )[0]?.visibility;

const statusAs = async (email: string | undefined, id: string) =>
  (await request(email, `/api/v1/statuses/${id}`)).status;

const idsIn = async (email: string, path: string): Promise<string[]> =>
  z
    .array(z.object({ id: z.string() }))
    .parse(await call(email, path))
    .map((entry) => entry.id);

const notified = async (email: string, statusId: string): Promise<boolean> =>
  z
    .array(z.object({ type: z.string(), status: z.object({ id: z.string() }).nullish() }))
    .parse(await call(email, "/api/v1/notifications?types[]=mention"))
    .some((entry) => entry.status?.id === statusId);

const follow = async (email: string, targetId: string): Promise<void> => {
  await call(email, `/api/v1/accounts/${targetId}/follow`, { method: "POST", body: "{}" });
};

const actorUrl = (username: string) => `${ORIGIN}/users/${username}`;

/** `remote` follows the local account `username`, which accepts it. */
const remoteFollows = async (remote: Remote, username: string): Promise<void> => {
  expect(
    await remote.send({
      id: `${remote.actorUri}/follows/${username}`,
      type: "Follow",
      object: actorUrl(username),
    }),
  ).toBe(202);
};

describe("a local status posted limited", () => {
  it("is stored limited and rendered private", async () => {
    const email = "loclim-stored@example.com";
    const mentioned = await signedInAccount("loclim-stored-mentioned@example.com");
    await signedInAccount(email);
    const status = await post(email, {
      status: `@${mentioned.username} hello`,
      visibility: "limited",
    });
    expect(status.visibility).toBe("private");
    expect(await storedVisibility(status.id)).toBe("limited");
    const shown = expectContract(ApiStatus, await call(email, `/api/v1/statuses/${status.id}`));
    expect(shown.visibility).toBe("private");
  });

  it("is shown to its author and the accounts it mentions only", async () => {
    // `StatusPolicy#show?`: `requires_mention?` holds for a limited status.
    const email = "loclim-show@example.com";
    const author = await signedInAccount(email);
    const mentioned = await signedInAccount("loclim-show-mentioned@example.com");
    await signedInAccount("loclim-show-follower@example.com");
    await follow("loclim-show-follower@example.com", author.id);
    const status = await post(email, {
      status: `@${mentioned.username} for you`,
      visibility: "limited",
    });
    expect(await statusAs(email, status.id)).toBe(200);
    expect(await statusAs("loclim-show-mentioned@example.com", status.id)).toBe(200);
    expect(await statusAs("loclim-show-follower@example.com", status.id)).toBe(404);
    expect(await statusAs(undefined, status.id)).toBe(404);
  });

  it("notifies the accounts it mentions past the private-mention policy", async () => {
    // `NotifyService#message?` asks for a direct status only.
    const email = "loclim-notify@example.com";
    await signedInAccount(email);
    const mentioned = await signedInAccount("loclim-notify-mentioned@example.com");
    const limited = await post(email, {
      status: `@${mentioned.username} limited`,
      visibility: "limited",
    });
    const direct = await post(email, {
      status: `@${mentioned.username} direct`,
      visibility: "direct",
    });
    expect(await notified("loclim-notify-mentioned@example.com", limited.id)).toBe(true);
    expect(await notified("loclim-notify-mentioned@example.com", direct.id)).toBe(false);
  });

  it("reaches its author's home and the homes of the followers it mentions, no list and no conversation", async () => {
    // `FanOutOnWriteService`: `deliver_to_self!` and, for `:limited`,
    // `deliver_to_mentioned_followers!` only; `deliver_to_conversation!` is direct's.
    const email = "loclim-home@example.com";
    const author = await signedInAccount(email);
    const mentioned = await signedInAccount("loclim-home-mentioned@example.com");
    const stranger = await signedInAccount("loclim-home-stranger@example.com");
    await signedInAccount("loclim-home-follower@example.com");
    await follow("loclim-home-mentioned@example.com", author.id);
    await follow("loclim-home-follower@example.com", author.id);
    const list = z.object({ id: z.string() }).parse(
      await call("loclim-home-mentioned@example.com", "/api/v1/lists", {
        method: "POST",
        body: JSON.stringify({ title: "limited" }),
      }),
    );
    await call("loclim-home-mentioned@example.com", `/api/v1/lists/${list.id}/accounts`, {
      method: "POST",
      body: JSON.stringify({ account_ids: [author.id] }),
    });
    const status = await post(email, {
      status: `@${mentioned.username} @${stranger.username} at home`,
      visibility: "limited",
    });
    expect(await idsIn(email, "/api/v1/timelines/home")).toContain(status.id);
    expect(await idsIn("loclim-home-mentioned@example.com", "/api/v1/timelines/home")).toContain(
      status.id,
    );
    expect(await idsIn("loclim-home-stranger@example.com", "/api/v1/timelines/home")).not.toContain(
      status.id,
    );
    expect(await idsIn("loclim-home-follower@example.com", "/api/v1/timelines/home")).not.toContain(
      status.id,
    );
    expect(
      await idsIn("loclim-home-mentioned@example.com", `/api/v1/timelines/list/${list.id}`),
    ).not.toContain(status.id);
    for (const viewer of [email, "loclim-home-mentioned@example.com"]) {
      expect(await call(viewer, "/api/v1/conversations"), viewer).toEqual([]);
      expect(await idsIn(viewer, "/api/v1/timelines/direct"), viewer).toEqual([]);
    }
  });

  it("is in the account statuses of its author and its mentions, and exclude_direct leaves it out", async () => {
    // `AccountStatusesFilter`: `exclude_direct` keeps public, unlisted and private only.
    const email = "loclim-profile@example.com";
    const author = await signedInAccount(email);
    const mentioned = await signedInAccount("loclim-profile-mentioned@example.com");
    await signedInAccount("loclim-profile-follower@example.com");
    await follow("loclim-profile-follower@example.com", author.id);
    const status = await post(email, {
      status: `@${mentioned.username} profile`,
      visibility: "limited",
    });
    const path = `/api/v1/accounts/${author.id}/statuses`;
    expect(await idsIn(email, path)).toContain(status.id);
    expect(await idsIn("loclim-profile-mentioned@example.com", path)).toContain(status.id);
    expect(await idsIn("loclim-profile-follower@example.com", path)).not.toContain(status.id);
    expect(await idsIn(email, `${path}?exclude_direct=true`)).not.toContain(status.id);
    expect(
      await idsIn("loclim-profile-mentioned@example.com", `${path}?exclude_direct=true`),
    ).not.toContain(status.id);
  });

  it("cannot be boosted, even by its author", async () => {
    // `StatusPolicy#reblog?` refuses a status that `requires_mention?`.
    const email = "loclim-boost@example.com";
    await signedInAccount(email);
    const mentioned = await signedInAccount("loclim-boost-mentioned@example.com");
    const status = await post(email, {
      status: `@${mentioned.username} no boosts`,
      visibility: "limited",
    });
    for (const booster of [email, "loclim-boost-mentioned@example.com"]) {
      const response = await request(booster, `/api/v1/statuses/${status.id}/reblog`, {
        method: "POST",
        body: "{}",
      });
      expect(response.status, booster).toBe(404);
    }
  });

  it("counts toward its author's statuses_count", async () => {
    // `Status#increment_counter_caches` skips a direct status only.
    const email = "loclim-count@example.com";
    const author = await signedInAccount(email);
    await post(email, { status: "limited, alone", visibility: "limited" });
    await post(email, { status: "direct, alone", visibility: "direct" });
    const account = z
      .object({ statuses_count: z.number() })
      .parse(await call(email, `/api/v1/accounts/${author.id}`));
    expect(account.statuses_count).toBe(1);
  });

  it("federates as a direct note does, to the remote accounts it mentions only", async () => {
    // `ActivityPub::TagManager#to` names its mentions and `#cc` nothing;
    // `StatusReachFinder#followers_scope` is empty for a limited status.
    const email = "loclim-federate@example.com";
    const author = await signedInAccount(email);
    const mentioned = await remoteActor("loclimmentioned", HOST);
    const follower = await remoteActor("loclimfollower", HOST);
    await remoteFollows(follower, author.username);
    const status = await post(email, {
      status: `@loclimmentioned@${HOST} over there`,
      visibility: "limited",
    });
    const created = await deliveredCreate(author.id, status.uri);
    expect(created?.activity.object.to).toEqual([mentioned.actorUri]);
    expect(created?.activity.object.cc).toEqual([]);
    expect(created?.inboxes).toEqual([`${mentioned.actorUri}/inbox`]);
    expect(created?.inboxes).not.toContain(`${follower.actorUri}/inbox`);
  });

  it("stays limited through an edit", async () => {
    // `UpdateStatusService` never changes a status's visibility.
    const email = "loclim-edit@example.com";
    await signedInAccount(email);
    const mentioned = await signedInAccount("loclim-edit-mentioned@example.com");
    const status = await post(email, {
      status: `@${mentioned.username} before`,
      visibility: "limited",
    });
    const edited = expectContract(
      ApiStatus,
      await call(email, `/api/v1/statuses/${status.id}`, {
        method: "PUT",
        body: JSON.stringify({ status: `@${mentioned.username} after` }),
      }),
    );
    expect(edited.visibility).toBe("private");
    expect(await storedVisibility(status.id)).toBe("limited");
    expect(await statusAs("loclim-edit-mentioned@example.com", status.id)).toBe(200);
  });

  it("can be pinned, as only a direct status cannot", async () => {
    // `StatusPinValidator` refuses `direct_visibility?` alone.
    const email = "loclim-pin@example.com";
    await signedInAccount(email);
    const status = await post(email, { status: "pinned limited", visibility: "limited" });
    expect(
      (await request(email, `/api/v1/statuses/${status.id}/pin`, { method: "POST" })).status,
    ).toBe(200);
  });

  it("sends its Delete to the remote accounts it mentions, not to its author's followers", async () => {
    // `RemoveStatusService#remove_from_remote_reach`: `StatusReachFinder`.
    const email = "loclim-delete@example.com";
    const author = await signedInAccount(email);
    const mentioned = await remoteActor("loclimdelmentioned", HOST);
    const follower = await remoteActor("loclimdelfollower", HOST);
    await remoteFollows(follower, author.username);
    const status = await post(email, {
      status: `@loclimdelmentioned@${HOST} soon gone`,
      visibility: "limited",
    });
    expect(
      (await request(email, `/api/v1/statuses/${status.id}`, { method: "DELETE" })).status,
    ).toBe(200);
    const deletes = parseRows(
      z.object({ id: z.string() }),
      (
        await env.DB.prepare(
          "SELECT id FROM outbound_activities WHERE account_id = ? AND kind = 'Delete'",
        )
          .bind(author.id)
          .all()
      ).results,
    );
    expect(deletes.length).toBeGreaterThan(0);
    const inboxes: string[] = [];
    for (const { id } of deletes) {
      await processOutboxJob(
        env,
        OutboxJob.parse({ kind: "ExpandFollowers", activityId: id })._unsafeUnwrap(),
      );
      inboxes.push(
        ...parseRows(
          z.object({ inbox_url: z.string() }),
          (
            await env.DB.prepare(
              "SELECT inbox_url FROM outbox_deliveries WHERE activity_id = ? AND inbox_url IS NOT NULL",
            )
              .bind(id)
              .all()
          ).results,
        ).map((row) => row.inbox_url),
      );
    }
    expect(inboxes).toContain(`${mentioned.actorUri}/inbox`);
    expect(inboxes).not.toContain(`${follower.actorUri}/inbox`);
  });

  it("is in its author's outbox for a remote actor it mentions, follower or not, and for no other", async () => {
    // `AccountStatusesFilter#filtered_scope`: any status that mentions the fetcher.
    const email = "loclim-outbox@example.com";
    const author = await signedInAccount(email);
    const mentioned = await remoteActor("loclimoutboxmentioned", HOST);
    const mentionedFollower = await remoteActor("loclimoutboxfan", HOST);
    const follower = await remoteActor("loclimoutboxfollower", HOST);
    await remoteFollows(mentionedFollower, author.username);
    await remoteFollows(follower, author.username);
    const status = await post(email, {
      status: `@loclimoutboxmentioned@${HOST} @loclimoutboxfan@${HOST} in the outbox`,
      visibility: "limited",
    });
    const listed = async (reader: Remote) => {
      const response = await reader.fetch(`/users/${author.username}/outbox?page=true`);
      expect(response.status).toBe(200);
      return (await response.text()).includes(status.uri);
    };
    expect(await listed(mentioned)).toBe(true);
    expect(await listed(mentionedFollower)).toBe(true);
    expect(await listed(follower)).toBe(false);
  });

  it("is found by status search for its mentions, not for its author's followers", async () => {
    const email = "loclim-search@example.com";
    const author = await signedInAccount(email);
    const mentioned = await signedInAccount("loclim-search-mentioned@example.com");
    await signedInAccount("loclim-search-follower@example.com");
    await follow("loclim-search-follower@example.com", author.id);
    const status = await post(email, {
      status: `@${mentioned.username} loclimsearchq`,
      visibility: "limited",
    });
    const found = async (viewer: string) =>
      z
        .object({ statuses: z.array(z.object({ id: z.string() })) })
        .parse(await call(viewer, "/api/v2/search?q=loclimsearchq&type=statuses"))
        .statuses.map((entry) => entry.id);
    expect(await found("loclim-search-mentioned@example.com")).toEqual([status.id]);
    expect(await found("loclim-search-follower@example.com")).toEqual([]);
  });

  it("is no visibility a boost may ask for", async () => {
    // `Status::Visibility` excludes `direct` and `limited` for a reblog.
    const email = "loclim-boost-ask@example.com";
    await signedInAccount(email);
    const status = await post(email, { status: "boost me" });
    const response = await request(email, `/api/v1/statuses/${status.id}/reblog`, {
      method: "POST",
      body: JSON.stringify({ visibility: "limited" }),
    });
    expect(response.status).toBe(400);
  });

  it("keeps its hashtags off the hashtag timeline", async () => {
    const email = "loclim-tag@example.com";
    await signedInAccount(email);
    const status = await post(email, { status: "#loclimtag hidden", visibility: "limited" });
    expect(await idsIn(email, "/api/v1/timelines/tag/loclimtag")).not.toContain(status.id);
  });

  it("is scheduled limited and published limited", async () => {
    // `ScheduledStatus#params` keeps the visibility as given, and
    // `REST::ScheduledStatusSerializer` renders the params as stored.
    const email = "loclim-scheduled@example.com";
    await signedInAccount(email);
    const scheduled = expectContract(
      ApiScheduledStatus,
      await call(email, "/api/v1/statuses", {
        method: "POST",
        body: JSON.stringify({
          status: "later, limited",
          visibility: "limited",
          scheduled_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        }),
      }),
    );
    expect(scheduled.params.visibility).toBe("limited");
    await env.DB.prepare("UPDATE scheduled_statuses SET scheduled_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 60_000).toISOString(), scheduled.id)
      .run();
    expect(await processOutboxJob(env, { kind: "PublishScheduledStatuses" })).toBe("ok");
    const author = await signedInAccount(email);
    const [published] = z
      .array(z.object({ id: z.string(), visibility: z.string() }))
      .parse(await call(email, `/api/v1/accounts/${author.id}/statuses`));
    expect(published?.visibility).toBe("private");
    expect(published && (await storedVisibility(published.id))).toBe("limited");
  });

  it("is quoted by its author only, and its author's quote keeps the visibility asked for", async () => {
    // `downgrade_quote_policy` leaves nobody but the author
    // (`quote_policy_for_account`), and `PostStatusService` clamps a quote to
    // private only for a private quoted status.
    const email = "loclim-quote@example.com";
    await signedInAccount(email);
    const mentioned = await signedInAccount("loclim-quote-mentioned@example.com");
    const status = await post(email, {
      status: `@${mentioned.username} quotable by me`,
      visibility: "limited",
    });
    const quote = await post(email, { status: "my own quote", quoted_status_id: status.id });
    expect(quote.visibility).toBe("public");
    const other = await request("loclim-quote-mentioned@example.com", "/api/v1/statuses", {
      method: "POST",
      body: JSON.stringify({ status: "not mine", quoted_status_id: status.id }),
    });
    expect(other.status).not.toBe(200);
  });
});
