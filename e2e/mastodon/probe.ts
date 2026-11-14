#!/usr/bin/env node
/**
 * Interop sweep: one pass over the interactions tstodon and a real Mastodon
 * exchange, each in both directions, through the client APIs only. A failed
 * step is recorded and the sweep goes on, so one run lists every gap. Exits 1
 * if any step failed. This is a survey to rank scenarios by, not a gate.
 * Needs the stack from `bootstrap.sh` and `.state/e2e.env`.
 */
import { deflateSync, crc32 } from "node:zlib";
import { A, signUp, type E2eUser } from "../lib.js";
import { mastodonUser } from "./lib.js";
import { authorizedFetchScenarios } from "./probe-authorized-fetch.js";
import { directScenarios } from "./probe-direct.js";
import { followScenarios } from "./probe-follows.js";
import { searchScenarios } from "./probe-search.js";
import { threadScenarios } from "./probe-threads.js";
import {
  Account,
  Anything,
  bothWays,
  call,
  type Cast,
  Context,
  Conversations,
  eventually,
  follow,
  Media,
  notified,
  onHome,
  Poll,
  post,
  relationship,
  resolveAccount,
  resolveStatus,
  results,
  Status,
  Statuses,
  step,
  StepFailure,
} from "./sweep.js";

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

/** Every interaction once, in both directions, between a pair that follows each other. */
const baseScenarios = async ({ stamp, mona, carol }: Cast): Promise<void> => {
  const alice = await signUp(A, "alice");
  const bob = await signUp(A, "bob");
  console.log(`users ${alice.acct}, ${mona.acct}`);

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
};

const areas: ReadonlyArray<readonly [name: string, run: (cast: Cast) => Promise<void>]> = [
  ["base", baseScenarios],
  ["search", searchScenarios],
  ["direct", directScenarios],
  ["threads", threadScenarios],
  ["follows", followScenarios],
  ["authorized-fetch", authorizedFetchScenarios],
];

/** `E2E_PROBE_AREAS=search,threads` runs those areas only. */
const main = async (): Promise<void> => {
  const only = process.env["E2E_PROBE_AREAS"]?.split(",").map((name) => name.trim());
  const unknown = only?.filter((name) => !areas.some(([area]) => area === name)) ?? [];
  if (unknown.length > 0) {
    console.error(`unknown area ${unknown.join(", ")}: ${areas.map(([area]) => area).join(", ")}`);
    process.exit(2);
  }
  const cast: Cast = {
    stamp: Date.now().toString(36),
    mona: await mastodonUser("mona"),
    carol: await mastodonUser("carol"),
    dana: await mastodonUser("dana"),
    erin: await mastodonUser("erin"),
    longName: await mastodonUser("long_username_for_interop_0123"),
  };
  for (const [name, run] of areas) {
    if (only === undefined || only.includes(name)) {
      console.log(`\n== ${name}`);
      await run(cast);
    }
  }

  const count = (outcome: (typeof results)[number]["outcome"]): number =>
    results.filter((result) => result.outcome === outcome).length;
  const ran = count("ok") + count("FAIL");
  console.log(
    `\n${count("ok")} of ${ran} steps passed` +
      (count("gap") > 0 ? `, ${count("gap")} known gaps` : "") +
      (count("skip") > 0 ? `, ${count("skip")} skipped` : ""),
  );
  const failed = results.filter((result) => result.outcome === "FAIL");
  for (const result of results) {
    if (result.outcome === "FAIL" || result.outcome === "gap") {
      console.log(
        `${result.outcome === "FAIL" ? "FAIL" : "gap "} ${result.name}: ${result.detail}`,
      );
    }
  }
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((error: unknown) => {
  console.error("unhandled", error);
  process.exit(2);
});
