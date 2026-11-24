/** Sweep area INT-4: replies to posts a server never saw, deep threads, and context backfill. */
import { A, signUp, type E2eUser } from "../lib.js";
import {
  bothWays,
  call,
  type Cast,
  contextOf,
  eventually,
  fetchWaitingOutRateLimit,
  follow,
  mastodonRails,
  notified,
  post,
  resolveStatus,
  Status,
  step,
  StepFailure,
} from "./sweep.js";

const uris = (statuses: readonly Status[]): string[] => statuses.map((status) => status.uri);

/** `viewer`'s context of its copy of `uri`, once `accept` takes it. */
const contextBecomes = (
  viewer: E2eUser,
  statusId: string,
  label: string,
  accept: (context: { ancestors: string[]; descendants: string[] }) => boolean,
) => {
  let last = "";
  return eventually(
    label,
    async () => {
      const context = await contextOf(viewer, statusId);
      const seen = { ancestors: uris(context.ancestors), descendants: uris(context.descendants) };
      last = JSON.stringify(seen);
      return accept(seen) ? seen : undefined;
    },
    30_000,
  ).catch((error: unknown) => {
    throw new StepFailure(`${error instanceof Error ? error.message : String(error)}; saw ${last}`);
  });
};

/**
 * Waits until Mastodon's copy of a status reaches `hops` ancestors through
 * `in_reply_to_id`, reading one status at a time. Mastodon links a fetched
 * reply to its parent in a `ThreadResolveWorker` job, one hop per job, and
 * caches a status's ancestor ids for ten minutes the first time its context
 * is read (`Status#ancestor_ids`), with nothing to clear that cache when a
 * later job links the next hop. A context read while the chain is half linked
 * answers that half for ten minutes, so the context is read only once the
 * whole chain is linked.
 */
const linkedOnMastodon = async (viewer: E2eUser, statusId: string, hops: number) => {
  let linked = 0;
  try {
    await eventually(
      `${viewer.acct}'s copy links ${hops} ancestors`,
      async () => {
        linked = 0;
        let current = await call(viewer, `/api/v1/statuses/${statusId}`, Status);
        while (current.in_reply_to_id !== null) {
          linked += 1;
          current = await call(viewer, `/api/v1/statuses/${current.in_reply_to_id}`, Status);
        }
        return linked === hops ? true : undefined;
      },
      30_000,
    );
  } catch (error) {
    if (error instanceof StepFailure) {
      throw new StepFailure(`${error.message} (saw ${linked} linked)`);
    }
    throw error;
  }
};

const sameMembers = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && expected.every((uri) => actual.includes(uri));

/**
 * Both servers fetch the reply tree of a remote post when a signed-in user
 * reads its context, and only once the post is five minutes old
 * (`FETCH_REPLIES_INITIAL_WAIT_MINUTES`). This dates a status on Mastodon ten
 * minutes back: Mastodon's copy of a tstodon post, so the next context read
 * there starts the fetch, or a Mastodon post before tstodon first fetches it,
 * as tstodon's copy takes its `published` from Mastodon's `created_at`.
 */
const ageOnMastodon = (status: Status): void => {
  mastodonRails(
    `Status.find(${JSON.stringify(status.id)}).update_columns(created_at: 10.minutes.ago)`,
  );
};

/** Whether `viewer`'s context read of its copy of a status says a reply fetch is running. */
const contextRefreshes = async (viewer: E2eUser, statusId: string): Promise<boolean> => {
  const response = await fetchWaitingOutRateLimit(viewer, `/api/v1/statuses/${statusId}/context`);
  await response.arrayBuffer();
  if (!response.ok) {
    throw new StepFailure(`context of ${statusId} on ${viewer.origin} → ${response.status}`);
  }
  return response.headers.get("Mastodon-Async-Refresh") !== null;
};

/** A chain of replies on one server: each author replies to the post before. */
const localChain = async (stamp: string, authors: readonly E2eUser[]): Promise<Status[]> => {
  const chain: Status[] = [];
  for (const author of authors) {
    const parent = chain.at(-1);
    chain.push(
      await post(author, {
        status: `chain ${chain.length} ${stamp}`,
        ...(parent ? { in_reply_to_id: parent.id } : {}),
      }),
    );
  }
  return chain;
};

export const threadScenarios = async ({
  stamp,
  mona,
  carol,
  erin,
  longName,
}: Cast): Promise<void> => {
  const alice = await signUp(A, "thea");
  const bob = await signUp(A, "theo");
  const tina = await signUp(A, "tina");

  await bothWays("follow → accept", alice, mona, async (from, to) => {
    await follow(from, to);
  });

  await bothWays(
    "a reply to a post the receiving server never saw brings its parent",
    alice,
    mona,
    async (from, to) => {
      const stranger = from === alice ? bob : carol;
      const parent = await post(stranger, { status: `unseen parent ${stamp}` });
      const reply = await post(from, {
        status: `${to.acct} reply to an unseen parent ${stamp}`,
        in_reply_to_id: parent.id,
      });
      const notification = await notified(to, "mention", from, reply.uri);
      const copy = Status.parse(notification.status);
      await contextBecomes(to, copy.id, "the reply's ancestors hold the parent", (context) =>
        sameMembers(context.ancestors, [parent.uri]),
      );
      const now = await call(to, `/api/v1/statuses/${copy.id}`, Status);
      if (now.in_reply_to_id === null) {
        throw new StepFailure("the receiver's copy of the reply has no in_reply_to_id");
      }
    },
  );

  await step("a thread five posts deep across both servers shows whole on each", async () => {
    const order = [alice, mona, bob, carol, alice];
    const thread: Status[] = [];
    for (const author of order) {
      const parent = thread.at(-1);
      if (!parent) {
        thread.push(await post(author, { status: `deep root ${stamp}` }));
        continue;
      }
      const parentAuthor = order[thread.length - 1];
      const parentCopy = await resolveStatus(author, parent.uri);
      thread.push(
        await post(author, {
          status: `${parentAuthor?.acct ?? ""} deep ${thread.length} ${stamp}`,
          in_reply_to_id: parentCopy.id,
        }),
      );
    }
    const all = uris(thread);
    for (const viewer of [alice, mona]) {
      const root = await resolveStatus(viewer, all[0] ?? "");
      await contextBecomes(
        viewer,
        root.id,
        `${viewer.acct}'s descendants of the root are the four replies`,
        (context) => sameMembers(context.descendants, all.slice(1)),
      );
      const leaf = await resolveStatus(viewer, all.at(-1) ?? "");
      const context = await contextBecomes(
        viewer,
        leaf.id,
        `${viewer.acct}'s ancestors of the leaf are the four posts above`,
        (seen) => sameMembers(seen.ancestors, all.slice(0, -1)),
      );
      if (context.ancestors.join() !== all.slice(0, -1).join()) {
        throw new StepFailure(
          `${viewer.acct}'s ancestors are out of order: ${context.ancestors.join()}`,
        );
      }
    }
  });

  const readers = [
    ["tstodon reads a Mastodon thread", alice, [carol, erin, carol, erin]],
    ["Mastodon reads a tstodon thread", mona, [bob, tina, bob, tina]],
  ] as const;

  for (const [direction, reader, authors] of readers) {
    await step(`context backfills the ancestors of a resolved leaf: ${direction}`, async () => {
      const chain = await localChain(`${stamp} up`, authors);
      const leaf = await resolveStatus(reader, chain.at(-1)?.uri ?? "");
      // tstodon fetches the ancestors when the context is read; Mastodon
      // fetched them when it resolved the leaf.
      if (reader.origin === mona.origin) {
        await linkedOnMastodon(reader, leaf.id, chain.length - 1);
      }
      const context = await contextBecomes(
        reader,
        leaf.id,
        "the leaf's ancestors are the three posts above it",
        (seen) => sameMembers(seen.ancestors, uris(chain.slice(0, -1))),
      );
      if (context.ancestors.join() !== uris(chain.slice(0, -1)).join()) {
        throw new StepFailure(`the ancestors are out of order: ${context.ancestors.join()}`);
      }
    });
  }

  /** A root with three direct replies: its author's own, and two by other accounts. */
  const repliesOfRoot = async (reader: E2eUser, authors: readonly E2eUser[]): Promise<void> => {
    const [author, second, third] = authors;
    if (!author || !second || !third) {
      throw new StepFailure("three authors are needed");
    }
    const root = await post(author, { status: `star root ${stamp}` });
    if (reader.origin !== mona.origin) {
      ageOnMastodon(root);
    }
    const replies: Status[] = [];
    for (const replier of [author, second, third]) {
      replies.push(
        await post(replier, {
          status: `star reply ${replies.length} ${stamp}`,
          in_reply_to_id: root.id,
        }),
      );
    }
    const copy = await resolveStatus(reader, root.uri);
    if (reader.origin === mona.origin) {
      ageOnMastodon(copy);
    }
    await contextBecomes(reader, copy.id, "the root's descendants are its three replies", (seen) =>
      sameMembers(seen.descendants, uris(replies)),
    );
  };

  /** A chain below a root: only the first reply is in the root's `replies`. */
  const repliesOfReplies = async (reader: E2eUser, authors: readonly E2eUser[]): Promise<void> => {
    const chain = await localChain(`${stamp} down`, authors);
    const [first] = chain;
    if (first && reader.origin !== mona.origin) {
      ageOnMastodon(first);
    }
    const root = await resolveStatus(reader, first?.uri ?? "");
    if (reader.origin === mona.origin) {
      ageOnMastodon(root);
    }
    await contextBecomes(reader, root.id, "the root's descendants are the three below it", (seen) =>
      sameMembers(seen.descendants, uris(chain.slice(1))),
    );
  };

  await bothWays(
    "a post younger than five minutes has no reply fetch started by its context",
    alice,
    mona,
    async (from, to) => {
      const root = await post(from, { status: `fresh root ${stamp}` });
      const copy = await resolveStatus(to, root.uri);
      if (await contextRefreshes(to, copy.id)) {
        throw new StepFailure("the context read of a fresh post started a reply fetch");
      }
    },
  );

  await step(
    "context backfills the replies to a resolved root: tstodon reads a Mastodon thread",
    () => repliesOfRoot(alice, [carol, erin, longName]),
  );
  await step(
    "context backfills the replies to a resolved root: Mastodon reads a tstodon thread",
    () => repliesOfRoot(mona, [bob, tina, alice]),
  );
  await step("context backfills replies of replies: tstodon reads a Mastodon thread", () =>
    repliesOfReplies(alice, [carol, erin, carol, erin]),
  );
  await step("context backfills replies of replies: Mastodon reads a tstodon thread", () =>
    repliesOfReplies(mona, [bob, tina, bob, tina]),
  );
};
