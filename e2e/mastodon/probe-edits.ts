/** Sweep area INT-9: edits of a content warning, media, a poll and mentions, the edit history, and deletes. */
import { z } from "zod";
import { A, signUp, sleep, type E2eUser } from "../lib.js";
import { png, upload } from "./media.js";
import {
  Anything,
  bothWays,
  call,
  type Cast,
  contextOf,
  eventually,
  follow,
  notified,
  onHome,
  post,
  Status,
  Statuses,
  step,
  StepFailure,
} from "./sweep.js";

const History = z.array(
  z.looseObject({
    content: z.string(),
    spoiler_text: z.string(),
    media_attachments: z.array(z.looseObject({ description: z.string().nullable() })),
    poll: z.looseObject({ options: z.array(z.looseObject({ title: z.string() })) }).nullish(),
  }),
);

const edit = (author: E2eUser, statusId: string, body: Record<string, unknown>): Promise<Status> =>
  call(author, `/api/v1/statuses/${statusId}`, Status, { method: "PUT", body });

/** `viewer`'s copy of a status, once `accept` takes it; a timeout reports the last copy seen. */
const copyBecomes = async (
  viewer: E2eUser,
  statusId: string,
  label: string,
  accept: (status: Status) => boolean,
): Promise<Status> => {
  let last = "";
  try {
    return await eventually(label, async () => {
      const now = await call(viewer, `/api/v1/statuses/${statusId}`, Status);
      last = JSON.stringify({
        content: now.content,
        spoiler_text: now.spoiler_text,
        sensitive: now.sensitive,
        media: now.media_attachments.map((media) => media.description),
        poll: now.poll?.options.map((option) => option.title),
        edited_at: now.edited_at,
      });
      return accept(now) ? now : undefined;
    });
  } catch (error) {
    throw new StepFailure(`${error instanceof Error ? error.message : String(error)}; saw ${last}`);
  }
};

const gone = (viewer: E2eUser, statusId: string, label: string) =>
  eventually(label, async () => {
    const response = await fetch(`${viewer.origin}/api/v1/statuses/${statusId}`, {
      headers: viewer.headers,
    });
    await response.arrayBuffer();
    return response.status === 404 ? true : undefined;
  });

export const editScenarios = async ({ stamp, mona }: Cast): Promise<void> => {
  const alice = await signUp(A, "edda");
  const bob = await signUp(A, "edgar");

  await bothWays("follow → accept", alice, mona, async (from, to) => {
    await follow(from, to);
  });

  await bothWays(
    "an edit adds a content warning and marks the post sensitive",
    alice,
    mona,
    async (from, to) => {
      const sent = await post(from, { status: `cw later ${stamp}` });
      const copy = await onHome(to, sent.uri);
      await edit(from, sent.id, {
        status: `cw later ${stamp}`,
        spoiler_text: `warning ${stamp}`,
        sensitive: true,
      });
      await copyBecomes(
        to,
        copy.id,
        "the copy has the content warning and is sensitive",
        (now) => now.spoiler_text === `warning ${stamp}` && now.sensitive,
      );
    },
  );

  await bothWays("an edit removes the content warning again", alice, mona, async (from, to) => {
    const sent = await post(from, {
      status: `cw first ${stamp}`,
      spoiler_text: `warning ${stamp}`,
    });
    const copy = await onHome(to, sent.uri, (status) => status.spoiler_text !== "");
    await edit(from, sent.id, { status: `cw first ${stamp}`, spoiler_text: "" });
    await copyBecomes(
      to,
      copy.id,
      "the copy has no content warning",
      (now) => now.spoiler_text === "",
    );
  });

  await bothWays(
    "the edit history shows each version on the other server",
    alice,
    mona,
    async (from, to) => {
      const sent = await post(from, { status: `version one ${stamp}` });
      const copy = await onHome(to, sent.uri);
      await edit(from, sent.id, { status: `version two ${stamp}`, spoiler_text: "second" });
      await copyBecomes(to, copy.id, "the copy has the second version", (now) =>
        now.content.includes("version two"),
      );
      // Mastodon dates an edit to the second, and applies an `Update` as an edit
      // only when it is dated after the one it holds.
      await sleep(1100);
      await edit(from, sent.id, { status: `version three ${stamp}`, spoiler_text: "" });
      await copyBecomes(to, copy.id, "the copy has the third version", (now) =>
        now.content.includes("version three"),
      );
      const history = await call(to, `/api/v1/statuses/${copy.id}/history`, History);
      const versions = history.map(
        (entry) => `${/version (\w+)/.exec(entry.content)?.[1] ?? "?"}/${entry.spoiler_text}`,
      );
      if (versions.join() !== "one/,two/second,three/") {
        throw new StepFailure(`the history is ${versions.join()}`);
      }
    },
  );

  await bothWays(
    "an edit adds an image and changes the alt text of the first",
    alice,
    mona,
    async (from, to) => {
      const first = await upload(from, `one ${stamp}`);
      const sent = await post(from, { status: `media edit ${stamp}`, media_ids: [first] });
      const copy = await onHome(to, sent.uri);
      const second = await upload(from, `two ${stamp}`, { file: png([40, 40, 220]) });
      await edit(from, sent.id, {
        status: `media edit ${stamp}`,
        media_ids: [first, second],
        media_attributes: [{ id: first, description: `one edited ${stamp}` }],
      });
      await copyBecomes(
        to,
        copy.id,
        "the copy has both images, the first with its new alt text",
        (now) =>
          now.media_attachments.map((media) => media.description).join() ===
          `one edited ${stamp},two ${stamp}`,
      );
    },
  );

  await bothWays("an edit removes the image", alice, mona, async (from, to) => {
    const media = await upload(from, `to remove ${stamp}`);
    const sent = await post(from, { status: `media removed ${stamp}`, media_ids: [media] });
    const copy = await onHome(to, sent.uri, (status) => status.media_attachments.length === 1);
    await edit(from, sent.id, { status: `media removed ${stamp}`, media_ids: [] });
    await copyBecomes(
      to,
      copy.id,
      "the copy has no image",
      (now) => now.media_attachments.length === 0 && now.edited_at !== null,
    );
  });

  await bothWays("an edit changes a poll's options", alice, mona, async (from, to) => {
    const sent = await post(from, {
      status: `poll edit ${stamp}`,
      poll: { options: ["one", "two"], expires_in: 3600 },
    });
    const copy = await onHome(to, sent.uri);
    await edit(from, sent.id, {
      status: `poll edit ${stamp}`,
      poll: { options: ["three", "four", "five"], expires_in: 3600 },
    });
    await copyBecomes(
      to,
      copy.id,
      "the copy's poll has the new options",
      (now) => now.poll?.options.map((option) => option.title).join() === "three,four,five",
    );
  });

  await bothWays("an edit that adds a mention notifies", alice, mona, async (from, to) => {
    const sent = await post(from, { status: `mention later ${stamp}` });
    await onHome(to, sent.uri);
    await edit(from, sent.id, { status: `${to.acct} mention later ${stamp}` });
    await notified(to, "mention", from, sent.uri);
  });

  await bothWays(
    "an edit notifies the account that boosted the post",
    alice,
    mona,
    async (from, to) => {
      const sent = await post(from, { status: `boosted then edited ${stamp}` });
      const copy = await onHome(to, sent.uri);
      await call(to, `/api/v1/statuses/${copy.id}/reblog`, Status, { method: "POST", body: {} });
      await notified(from, "reblog", to, sent.uri);
      await edit(from, sent.id, { status: `boosted then edited, now edited ${stamp}` });
      await notified(to, "update", from, sent.uri);
    },
  );

  await bothWays(
    "a deleted reply leaves the thread on the other server",
    alice,
    mona,
    async (from, to) => {
      const parent = await post(to, { status: `thread to prune ${stamp}` });
      const parentOnFrom = await onHome(from, parent.uri);
      const reply = await post(from, {
        status: `${to.acct} reply to delete ${stamp}`,
        in_reply_to_id: parentOnFrom.id,
      });
      await eventually("the reply is in the parent's thread", async () =>
        (await contextOf(to, parent.id)).descendants.some((status) => status.uri === reply.uri)
          ? true
          : undefined,
      );
      await call(from, `/api/v1/statuses/${reply.id}`, Anything, { method: "DELETE" });
      await eventually("the reply left the parent's thread", async () =>
        (await contextOf(to, parent.id)).descendants.some((status) => status.uri === reply.uri)
          ? undefined
          : true,
      );
      await eventually("the mention notification is gone", async () => {
        const mentions = await call(
          to,
          "/api/v1/notifications?types[]=mention&limit=40",
          z.array(z.looseObject({ status: z.looseObject({ uri: z.string() }).nullish() })),
        );
        return mentions.some((item) => item.status?.uri === reply.uri) ? undefined : true;
      });
    },
  );

  await bothWays(
    "a deleted post takes its boost off the booster's server",
    alice,
    mona,
    async (from, to) => {
      const sent = await post(from, { status: `boosted then deleted ${stamp}` });
      const copy = await onHome(to, sent.uri);
      await call(to, `/api/v1/statuses/${copy.id}/reblog`, Status, { method: "POST", body: {} });
      await notified(from, "reblog", to, sent.uri);
      await call(from, `/api/v1/statuses/${sent.id}`, Anything, { method: "DELETE" });
      await gone(to, copy.id, "the booster's copy is gone");
      await eventually("the booster's profile no longer lists the boost", async () => {
        const own = await call(to, `/api/v1/accounts/${to.id}/statuses?limit=40`, Statuses);
        return own.some((status) => status.reblog?.uri === sent.uri) ? undefined : true;
      });
    },
  );

  // Mastodon sends the `Delete` of a local post to its reach (the followers
  // and the remote accounts that interacted), not to the followers of a local
  // account that boosted it. tstodon sends it to those followers too, as
  // Mastodon's `ActivityPub::Forwarder` does for a remote post.
  await step(
    "a deleted post takes a local boost of it off the home of the booster's remote follower: tstodon → Mastodon",
    async () => {
      const original = await post(bob, { status: `boosted across then deleted ${stamp}` });
      await call(alice, `/api/v1/statuses/${original.id}/reblog`, Status, {
        method: "POST",
        body: {},
      });
      const boostOnHome = async (): Promise<Status | undefined> => {
        const home = await call(mona, "/api/v1/timelines/home?limit=40", Statuses);
        return home.find((status) => status.reblog?.uri === original.uri);
      };
      await eventually("the follower's home has the boost", boostOnHome);
      await call(bob, `/api/v1/statuses/${original.id}`, Anything, { method: "DELETE" });
      await eventually("the follower's home no longer has the boost", async () =>
        (await boostOnHome()) === undefined ? true : undefined,
      );
    },
  );

  // Mastodon's PUT carries the whole revision: a field left out is emptied.
  await bothWays(
    "an edit that leaves the content warning, the sensitive flag and the poll out removes them",
    alice,
    mona,
    async (from, to) => {
      const sent = await post(from, {
        status: `whole revision ${stamp}`,
        spoiler_text: "warning",
        sensitive: true,
        poll: { options: ["yes", "no"], expires_in: 3600 },
      });
      const copy = await onHome(to, sent.uri);
      const emptied = (status: Status): boolean =>
        status.spoiler_text === "" && !status.sensitive && !status.poll;
      const edited = await edit(from, sent.id, { status: `whole revision, edited ${stamp}` });
      if (!emptied(edited)) {
        throw new StepFailure(
          `the author's server answers ${JSON.stringify({
            spoiler_text: edited.spoiler_text,
            sensitive: edited.sensitive,
            poll: edited.poll?.options.map((option) => option.title),
          })}`,
        );
      }
      await copyBecomes(
        to,
        copy.id,
        "the copy has the new text, and no content warning, sensitive flag or poll",
        (status) => status.content.includes("whole revision, edited") && emptied(status),
      );
    },
  );
};
