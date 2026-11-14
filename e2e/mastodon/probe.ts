#!/usr/bin/env node
/**
 * Interop sweep: one pass over the interactions tstodon and a real Mastodon
 * exchange, each in both directions, through the client APIs only. A failed
 * step is recorded and the sweep goes on, so one run lists every gap. Exits 1
 * if any step failed. This is a survey to rank scenarios by, not a gate.
 * Needs the stack from `bootstrap.sh` and `.state/e2e.env`.
 */
import { deflateSync, crc32 } from "node:zlib";
import { z } from "zod";
import { A, signUp, sleep, type E2eUser } from "../lib.js";
import { mastodonUser } from "./lib.js";

const Account = z.looseObject({
  id: z.string(),
  username: z.string(),
  uri: z.string(),
  display_name: z.string(),
  followers_count: z.number(),
});
const Poll = z.looseObject({
  id: z.string(),
  votes_count: z.number(),
  options: z.array(z.looseObject({ title: z.string(), votes_count: z.number().nullable() })),
});
const BaseStatus = z.looseObject({
  id: z.string(),
  uri: z.string(),
  content: z.string(),
  visibility: z.string(),
  in_reply_to_id: z.string().nullable(),
  favourites_count: z.number(),
  reblogs_count: z.number(),
  edited_at: z.string().nullable(),
  account: z.looseObject({ uri: z.string() }),
  poll: Poll.nullish(),
  media_attachments: z.array(
    z.looseObject({ type: z.string(), description: z.string().nullable() }),
  ),
  mentions: z.array(z.looseObject({ acct: z.string() })),
  tags: z.array(z.looseObject({ name: z.string() })),
  emojis: z.array(z.looseObject({ shortcode: z.string() })),
  quote: z
    .looseObject({ state: z.string(), quoted_status: z.looseObject({ uri: z.string() }).nullish() })
    .nullish(),
});
const Status = BaseStatus.extend({ reblog: BaseStatus.nullish() });
type Status = z.infer<typeof Status>;
const Statuses = z.array(Status);
const Notifications = z.array(
  z.looseObject({
    type: z.string(),
    account: z.looseObject({ uri: z.string() }),
    status: z.looseObject({ uri: z.string() }).nullish(),
  }),
);
const Context = z.looseObject({ ancestors: Statuses, descendants: Statuses });
const Search = z.looseObject({ accounts: z.array(Account), statuses: Statuses });
const Relationships = z.array(
  z.looseObject({ following: z.boolean(), followed_by: z.boolean(), requested: z.boolean() }),
);
const Conversations = z.array(
  z.looseObject({
    last_status: z.looseObject({ uri: z.string(), visibility: z.string() }).nullish(),
  }),
);
const Media = z.looseObject({ id: z.string(), url: z.string().nullable() });
const Anything = z.unknown();

class StepFailure extends Error {}

/** Call a client API endpoint as `user`; a non-2xx answer or an unexpected body fails the step. */
const call = async <T>(
  user: E2eUser,
  path: string,
  schema: z.ZodType<T>,
  init: { method?: string; body?: unknown; form?: FormData } = {},
): Promise<T> => {
  const method = init.method ?? "GET";
  const request: RequestInit =
    init.form !== undefined
      ? { method, headers: user.headers, body: init.form }
      : init.body !== undefined
        ? {
            method,
            headers: { ...user.headers, "Content-Type": "application/json" },
            body: JSON.stringify(init.body),
          }
        : { method, headers: user.headers };
  const response = await fetch(`${user.origin}${path}`, request);
  const text = await response.text();
  if (!response.ok) {
    throw new StepFailure(
      `${init.method ?? "GET"} ${user.origin}${path} → ${response.status} ${text.slice(0, 300)}`,
    );
  }
  const parsed = schema.safeParse(text.length > 0 ? JSON.parse(text) : undefined);
  if (!parsed.success) {
    throw new StepFailure(
      `${path} on ${user.origin}: ${z.prettifyError(parsed.error)} in ${text.slice(0, 300)}`,
    );
  }
  return parsed.data;
};

const eventually = async <T>(
  label: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 20_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new StepFailure(`${label}: not within ${timeoutMs} ms`);
    }
    await sleep(500);
  }
};

const results: Array<{ name: string; outcome: "ok" | "FAIL" | "skip"; detail: string }> = [];
const step = async (name: string, run: () => Promise<void>): Promise<boolean> => {
  try {
    await run();
    results.push({ name, outcome: "ok", detail: "" });
    console.log(`ok   ${name}`);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, outcome: "FAIL", detail });
    console.log(`FAIL ${name}\n     ${detail}`);
    return false;
  }
};

const post = (user: E2eUser, body: Record<string, unknown>): Promise<Status> =>
  call(user, "/api/v1/statuses", Status, {
    method: "POST",
    body: { visibility: "public", ...body },
  });

/** `viewer`'s copy of the status with this URI, resolved through search. */
const resolveStatus = (viewer: E2eUser, uri: string): Promise<Status> =>
  eventually(`${viewer.username} resolves ${uri}`, async () => {
    const query = new URLSearchParams({ q: uri, resolve: "true", type: "statuses" });
    const found = await call(viewer, `/api/v2/search?${query.toString()}`, Search);
    return found.statuses.find((status) => status.uri === uri);
  });

/** `viewer`'s copy once it arrived by delivery: on the home timeline, never fetched. */
const onHome = (viewer: E2eUser, uri: string, accept: (status: Status) => boolean = () => true) =>
  eventually(`${uri} on ${viewer.username}'s home`, async () => {
    const home = await call(viewer, "/api/v1/timelines/home?limit=40", Statuses);
    return home.find((status) => status.uri === uri && accept(status));
  });

const notified = (user: E2eUser, type: string, from: E2eUser, statusUri?: string) =>
  eventually(`${user.username} is notified of ${type}`, async () => {
    const list = await call(user, `/api/v1/notifications?types[]=${type}&limit=40`, Notifications);
    return list.find(
      (item) =>
        item.type === type &&
        item.account.uri === from.uri &&
        (statusUri === undefined || item.status?.uri === statusUri),
    );
  });

const resolveAccount = async (viewer: E2eUser, target: E2eUser) => {
  const query = new URLSearchParams({ q: target.acct, resolve: "true", type: "accounts" });
  const found = await call(viewer, `/api/v2/search?${query.toString()}`, Search);
  const account = found.accounts.find((candidate) => candidate.uri === target.uri);
  if (!account) {
    throw new StepFailure(`${viewer.username} cannot resolve ${target.acct}`);
  }
  return account;
};

const relationship = async (viewer: E2eUser, accountId: string) => {
  const [state] = await call(
    viewer,
    `/api/v1/accounts/relationships?id[]=${encodeURIComponent(accountId)}`,
    Relationships,
  );
  if (!state) {
    throw new StepFailure("no relationship");
  }
  return state;
};

const follow = async (follower: E2eUser, followed: E2eUser): Promise<string> => {
  const account = await resolveAccount(follower, followed);
  await call(follower, `/api/v1/accounts/${account.id}/follow`, Anything, {
    method: "POST",
    body: {},
  });
  await eventually(`${followed.acct} accepts`, async () =>
    (await relationship(follower, account.id)).following ? true : undefined,
  );
  return account.id;
};

/** A 32×32 red PNG. */
const png = (): Blob => {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(32, 0);
  header.writeUInt32BE(32, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(96, Buffer.from([220, 40, 40]))]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: 32 }, () => row)));
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return new Blob([new Uint8Array(bytes)], { type: "image/png" });
};

const upload = async (user: E2eUser, description: string): Promise<string> => {
  const form = new FormData();
  form.set("file", png(), "red.png");
  form.set("description", description);
  const media = await call(user, "/api/v2/media", Media, { method: "POST", form });
  await eventually(`${user.username}'s upload is processed`, async () => {
    const response = await fetch(`${user.origin}/api/v1/media/${media.id}`, {
      headers: user.headers,
    });
    return response.status === 200 ? true : undefined;
  });
  return media.id;
};

/** The same interaction, sent from each server to the other. */
const bothWays = async (
  name: string,
  alice: E2eUser,
  mona: E2eUser,
  run: (from: E2eUser, to: E2eUser) => Promise<void>,
): Promise<void> => {
  await step(`${name}: tstodon → Mastodon`, () => run(alice, mona));
  await step(`${name}: Mastodon → tstodon`, () => run(mona, alice));
};

const main = async (): Promise<void> => {
  const alice = await signUp(A, "alice");
  const bob = await signUp(A, "bob");
  const mona = await mastodonUser("mona");
  const carol = await mastodonUser("carol");
  console.log(`users ${alice.acct}, ${mona.acct}`);
  const stamp = Date.now().toString(36);

  const idOf = new Map<string, string>();
  await bothWays("follow → accept", alice, mona, async (from, to) => {
    idOf.set(`${from.username}>${to.username}`, await follow(from, to));
  });

  await bothWays("public post reaches the follower's home", alice, mona, async (from, to) => {
    const sent = await post(from, { status: `plain ${stamp} from ${from.username}` });
    await onHome(to, sent.uri, (status) => status.content.includes(`plain ${stamp}`));
  });

  await bothWays(
    "followers-only post reaches the follower's home",
    alice,
    mona,
    async (from, to) => {
      const sent = await post(from, { status: `private ${stamp}`, visibility: "private" });
      await onHome(to, sent.uri, (status) => status.visibility === "private");
    },
  );

  await bothWays("mention notifies", alice, mona, async (from, to) => {
    const sent = await post(from, { status: `${to.acct} mention ${stamp}` });
    await notified(to, "mention", from, sent.uri);
    const copy = await onHome(to, sent.uri);
    if (
      !copy.mentions.some(
        (mention) => to.acct.endsWith(mention.acct) || mention.acct === to.username,
      )
    ) {
      throw new StepFailure(
        `the receiver's copy lists no mention of ${to.acct}: ${JSON.stringify(copy.mentions)}`,
      );
    }
  });

  await bothWays("direct message", alice, mona, async (from, to) => {
    const sent = await post(from, { status: `${to.acct} dm ${stamp}`, visibility: "direct" });
    await notified(to, "mention", from, sent.uri);
    await eventually("the receiver has the conversation, as direct", async () => {
      const conversations = await call(to, "/api/v1/conversations", Conversations);
      const last = conversations.find((entry) => entry.last_status?.uri === sent.uri)?.last_status;
      return last?.visibility === "direct" ? true : undefined;
    });
  });

  await bothWays("search resolves the URL of a post never seen", alice, mona, async (from, to) => {
    const stranger = from === alice ? bob : carol;
    const sent = await post(stranger, { status: `find me by URL ${stamp}` });
    await resolveStatus(to, sent.uri);
  });

  await bothWays(
    "search resolves the URL of a direct post already received",
    alice,
    mona,
    async (from, to) => {
      const sent = await post(from, {
        status: `${to.acct} dm to look up ${stamp}`,
        visibility: "direct",
      });
      await notified(to, "mention", from, sent.uri);
      await resolveStatus(to, sent.uri);
    },
  );

  await bothWays("reply threads under the parent", alice, mona, async (from, to) => {
    const parent = await post(to, { status: `thread root ${stamp}` });
    const parentOnFrom = await onHome(from, parent.uri);
    const reply = await post(from, { status: `reply ${stamp}`, in_reply_to_id: parentOnFrom.id });
    await eventually("the reply is a descendant of the parent on its author's server", async () => {
      const context = await call(to, `/api/v1/statuses/${parent.id}/context`, Context);
      return context.descendants.some((status) => status.uri === reply.uri) ? true : undefined;
    });
  });

  await bothWays(
    "favourite counts and notifies, unfavourite undoes",
    alice,
    mona,
    async (from, to) => {
      const target = await post(to, { status: `like me ${stamp}` });
      const copy = await onHome(from, target.uri);
      await call(from, `/api/v1/statuses/${copy.id}/favourite`, Status, {
        method: "POST",
        body: {},
      });
      await notified(to, "favourite", from, target.uri);
      await eventually("favourites_count is 1", async () =>
        (await call(to, `/api/v1/statuses/${target.id}`, Status)).favourites_count === 1
          ? true
          : undefined,
      );
      await call(from, `/api/v1/statuses/${copy.id}/unfavourite`, Status, {
        method: "POST",
        body: {},
      });
      await eventually("favourites_count is back to 0", async () =>
        (await call(to, `/api/v1/statuses/${target.id}`, Status)).favourites_count === 0
          ? true
          : undefined,
      );
    },
  );

  await bothWays("boost counts and notifies, unboost undoes", alice, mona, async (from, to) => {
    const target = await post(to, { status: `boost me ${stamp}` });
    const copy = await onHome(from, target.uri);
    await call(from, `/api/v1/statuses/${copy.id}/reblog`, Status, { method: "POST", body: {} });
    await notified(to, "reblog", from, target.uri);
    await eventually("reblogs_count is 1", async () =>
      (await call(to, `/api/v1/statuses/${target.id}`, Status)).reblogs_count === 1
        ? true
        : undefined,
    );
    await call(from, `/api/v1/statuses/${copy.id}/unreblog`, Status, { method: "POST", body: {} });
    await eventually("reblogs_count is back to 0", async () =>
      (await call(to, `/api/v1/statuses/${target.id}`, Status)).reblogs_count === 0
        ? true
        : undefined,
    );
  });

  await bothWays(
    "boost of a post the receiver's server never saw",
    alice,
    mona,
    async (from, to) => {
      const stranger = from === alice ? bob : carol;
      const original = await post(stranger, { status: `boosted across ${stamp}` });
      await call(from, `/api/v1/statuses/${original.id}/reblog`, Status, {
        method: "POST",
        body: {},
      });
      await eventually(`${to.username}'s home has ${from.username}'s reblog`, async () => {
        const home = await call(to, "/api/v1/timelines/home?limit=40", Statuses);
        return home.find(
          (status) => status.reblog?.uri === original.uri && status.account.uri === from.uri,
        );
      });
    },
  );

  await bothWays("edit updates the remote copy", alice, mona, async (from, to) => {
    const sent = await post(from, { status: `before edit ${stamp}` });
    const copy = await onHome(to, sent.uri);
    await call(from, `/api/v1/statuses/${sent.id}`, Status, {
      method: "PUT",
      body: { status: `after edit ${stamp}` },
    });
    await eventually("the copy has the new text and edited_at", async () => {
      const now = await call(to, `/api/v1/statuses/${copy.id}`, Status);
      return now.content.includes("after edit") && now.edited_at !== null ? true : undefined;
    });
  });

  await bothWays("poll arrives, a remote vote is counted", alice, mona, async (from, to) => {
    const sent = await post(from, {
      status: `poll ${stamp}`,
      poll: { options: ["red", "blue"], expires_in: 3600 },
    });
    const copy = await onHome(to, sent.uri);
    if (!copy.poll || copy.poll.options.map((option) => option.title).join() !== "red,blue") {
      throw new StepFailure(`the copy's poll is ${JSON.stringify(copy.poll)}`);
    }
    await call(to, `/api/v1/polls/${copy.poll.id}/votes`, Poll, {
      method: "POST",
      body: { choices: [1] },
    });
    await eventually("the author's server counts the vote", async () => {
      const now = await call(from, `/api/v1/statuses/${sent.id}`, Status);
      return now.poll?.options[1]?.votes_count === 1 ? true : undefined;
    });
  });

  await bothWays("image with alt text arrives", alice, mona, async (from, to) => {
    const mediaId = await upload(from, `alt ${stamp}`);
    const sent = await post(from, { status: `media ${stamp}`, media_ids: [mediaId] });
    const copy = await onHome(to, sent.uri);
    const [attachment] = copy.media_attachments;
    if (attachment?.type !== "image" || attachment.description !== `alt ${stamp}`) {
      throw new StepFailure(`the copy's media is ${JSON.stringify(copy.media_attachments)}`);
    }
  });

  await bothWays("hashtag is indexed on the receiver", alice, mona, async (from, to) => {
    const tag = `interop${stamp}${from.username.slice(0, 3)}`;
    const sent = await post(from, { status: `tagged #${tag}` });
    const copy = await onHome(to, sent.uri);
    if (!copy.tags.some((entry) => entry.name.toLowerCase() === tag)) {
      throw new StepFailure(`the copy's tags are ${JSON.stringify(copy.tags)}`);
    }
    await eventually("the tag timeline has it", async () => {
      const timeline = await call(to, `/api/v1/timelines/tag/${tag}`, Statuses);
      return timeline.some((status) => status.uri === sent.uri) ? true : undefined;
    });
  });

  await bothWays("quote post is accepted", alice, mona, async (from, to) => {
    const target = await post(to, { status: `quote me ${stamp}` });
    const targetOnFrom = await onHome(from, target.uri);
    const sent = await post(from, {
      status: `quoting ${stamp}`,
      quoted_status_id: targetOnFrom.id,
    });
    await eventually("the quoter's server shows the quote accepted", async () => {
      const now = await call(from, `/api/v1/statuses/${sent.id}`, Status);
      return now.quote?.state === "accepted" ? true : undefined;
    });
    const copy = await onHome(to, sent.uri);
    await eventually("the quoted author's server shows the quote accepted", async () => {
      const now = await call(to, `/api/v1/statuses/${copy.id}`, Status);
      return now.quote?.state === "accepted" && now.quote.quoted_status?.uri === target.uri
        ? true
        : undefined;
    });
  });

  await step("custom emoji arrives: Mastodon → tstodon", async () => {
    const sent = await post(mona, { status: `emoji :interop: ${stamp}` });
    const copy = await onHome(alice, sent.uri);
    if (!copy.emojis.some((emoji) => emoji.shortcode === "interop")) {
      throw new StepFailure(`the copy's emojis are ${JSON.stringify(copy.emojis)}`);
    }
  });

  await bothWays("profile update reaches the follower's server", alice, mona, async (from, to) => {
    const form = new FormData();
    form.set("display_name", `${from.username} ${stamp}`);
    await call(from, "/api/v1/accounts/update_credentials", Account, { method: "PATCH", form });
    const id = idOf.get(`${to.username}>${from.username}`) ?? (await resolveAccount(to, from)).id;
    await eventually("the remote account has the new display name", async () =>
      (await call(to, `/api/v1/accounts/${id}`, Account)).display_name ===
      `${from.username} ${stamp}`
        ? true
        : undefined,
    );
  });

  await bothWays("delete removes the remote copy", alice, mona, async (from, to) => {
    const sent = await post(from, { status: `delete me ${stamp}` });
    const copy = await onHome(to, sent.uri);
    await call(from, `/api/v1/statuses/${sent.id}`, Anything, { method: "DELETE" });
    await eventually("the copy is gone", async () => {
      const response = await fetch(`${to.origin}/api/v1/statuses/${copy.id}`, {
        headers: to.headers,
      });
      return response.status === 404 ? true : undefined;
    });
  });

  await bothWays("unfollow drops the follower", alice, mona, async (from, to) => {
    const id = idOf.get(`${from.username}>${to.username}`) ?? (await resolveAccount(from, to)).id;
    const before = (await call(to, `/api/v1/accounts/${to.id}`, Account)).followers_count;
    await call(from, `/api/v1/accounts/${id}/unfollow`, Anything, { method: "POST", body: {} });
    await eventually("followers_count drops by one", async () =>
      (await call(to, `/api/v1/accounts/${to.id}`, Account)).followers_count === before - 1
        ? true
        : undefined,
    );
  });

  await bothWays("block severs the blocked user's follow", alice, mona, async (from, to) => {
    const followedId = await follow(to, from);
    const id = (await resolveAccount(from, to)).id;
    await call(from, `/api/v1/accounts/${id}/block`, Anything, { method: "POST", body: {} });
    await eventually("the blocked user's server no longer shows the follow", async () =>
      (await relationship(to, followedId)).following ? undefined : true,
    );
    await call(from, `/api/v1/accounts/${id}/unblock`, Anything, { method: "POST", body: {} });
  });

  const failed = results.filter((result) => result.outcome === "FAIL");
  console.log(`\n${results.length - failed.length} of ${results.length} steps passed`);
  for (const result of failed) {
    console.log(`FAIL ${result.name}: ${result.detail}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((error: unknown) => {
  console.error("unhandled", error);
  process.exit(2);
});
