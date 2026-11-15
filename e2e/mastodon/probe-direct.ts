/** Sweep area INT-2: direct messages to several recipients, reply chains, and a stranger's DM. */
import { z } from "zod";
import { A, signUp, type E2eUser } from "../lib.js";
import {
  Anything,
  call,
  type Cast,
  contextOf,
  conversationOf,
  Conversations,
  eventually,
  follow,
  Notifications,
  post,
  Status,
  step,
  StepFailure,
} from "./sweep.js";

const NotificationPolicy = z.looseObject({ for_private_mentions: z.string() });
const NotificationRequests = z.array(
  z.looseObject({
    id: z.string(),
    account: z.looseObject({ uri: z.string() }),
    last_status: z.looseObject({ uri: z.string() }).nullish(),
  }),
);

const mentionsOf = (users: readonly E2eUser[]): string => users.map((user) => user.acct).join(" ");

/** `user`'s copy of a direct status, once its conversation has it. */
const copyOf = async (
  user: E2eUser,
  uri: string,
): Promise<{ id: string; conversation: string }> => {
  const conversation = await conversationOf(user, uri);
  const last = z.looseObject({ id: z.string() }).parse(conversation.last_status);
  return { id: last.id, conversation: conversation.id };
};

const mentionNotification = async (user: E2eUser, from: E2eUser, uri: string) => {
  const list = await call(user, "/api/v1/notifications?types[]=mention&limit=40", Notifications);
  return list.find((item) => item.account.uri === from.uri && item.status?.uri === uri);
};

/**
 * A direct message to three recipients on both servers, then two replies:
 * every participant keeps one conversation that follows the chain, and the
 * author's server threads the replies under the first message.
 */
const groupChain = async (
  stamp: string,
  author: E2eUser,
  sameServer: E2eUser,
  firstRemote: E2eUser,
  secondRemote: E2eUser,
): Promise<void> => {
  const everyone = [author, sameServer, firstRemote, secondRemote];
  const others = (user: E2eUser) => everyone.filter((candidate) => candidate !== user);
  const direction =
    author.origin === A ? "tstodon → Mastodon and tstodon" : "Mastodon → tstodon and Mastodon";
  let root: Status | undefined;
  const conversations = new Map<E2eUser, string>();

  const delivered = await step(`a direct message to three recipients: ${direction}`, async () => {
    const sent = await post(author, {
      status: `${mentionsOf(others(author))} group dm ${stamp}`,
      visibility: "direct",
    });
    root = sent;
    for (const recipient of others(author)) {
      const copy = await copyOf(recipient, sent.uri);
      conversations.set(recipient, copy.conversation);
      const seen = await call(recipient, `/api/v1/statuses/${copy.id}`, Status);
      if (seen.visibility !== "direct" || seen.mentions.length !== 3) {
        throw new StepFailure(
          `${recipient.acct}'s copy is ${seen.visibility} with mentions ${JSON.stringify(seen.mentions)}`,
        );
      }
      const participants = (await conversationOf(recipient, sent.uri)).accounts.map(
        (account) => account.uri,
      );
      const missing = others(recipient).filter((user) => !participants.includes(user.uri));
      if (missing.length > 0) {
        throw new StepFailure(
          `${recipient.acct}'s conversation lacks ${missing.map((user) => user.acct).join(", ")}`,
        );
      }
    }
  });
  if (!delivered || !root) {
    return;
  }
  const first = root;

  await step(`a direct reply chain keeps one conversation: ${direction}`, async () => {
    let parentUri = first.uri;
    const chain = [first.uri];
    for (const replier of [firstRemote, sameServer, secondRemote]) {
      const parent = await copyOf(replier, parentUri);
      const reply = await post(replier, {
        status: `${mentionsOf(others(replier))} reply ${chain.length} ${stamp}`,
        visibility: "direct",
        in_reply_to_id: parent.id,
      });
      chain.push(reply.uri);
      for (const recipient of others(replier)) {
        const copy = await copyOf(recipient, reply.uri);
        const before = conversations.get(recipient);
        if (before !== undefined && before !== copy.conversation) {
          throw new StepFailure(
            `${recipient.acct} got reply ${chain.length - 1} in conversation ${copy.conversation}, not ${before}`,
          );
        }
        conversations.set(recipient, copy.conversation);
      }
      parentUri = reply.uri;
    }
    for (const participant of everyone) {
      const leaf = await copyOf(participant, parentUri);
      const ancestors = (await contextOf(participant, leaf.id)).ancestors.map(
        (status) => status.uri,
      );
      if (ancestors.join() !== chain.slice(0, -1).join()) {
        throw new StepFailure(
          `${participant.acct}'s ancestors of the last reply are ${JSON.stringify(ancestors)}`,
        );
      }
    }
  });
};

/**
 * A private mention from an account the receiver does not follow waits in a
 * notification request (`for_private_mentions: filter`, Mastodon's default
 * and tstodon's): no notification until the receiver accepts, and from then
 * on the sender's messages notify. On Mastodon the message has no
 * conversation either until then; tstodon lists it at once (INT-2).
 */
const strangerMessage = async (
  stamp: string,
  stranger: E2eUser,
  receiver: E2eUser,
): Promise<void> => {
  const policy = await call(receiver, "/api/v2/notifications/policy", NotificationPolicy);
  if (policy.for_private_mentions !== "filter") {
    throw new StepFailure(
      `${receiver.acct}'s for_private_mentions is ${policy.for_private_mentions}`,
    );
  }
  const sent = await post(stranger, {
    status: `${receiver.acct} from a stranger ${stamp}`,
    visibility: "direct",
  });
  const request = await eventually("the receiver has a notification request", async () => {
    const requests = await call(receiver, "/api/v1/notifications/requests", NotificationRequests);
    return requests.find((entry) => entry.account.uri === stranger.uri);
  });
  if (request.last_status?.uri !== sent.uri) {
    throw new StepFailure(`the request's last status is ${String(request.last_status?.uri)}`);
  }
  if ((await mentionNotification(receiver, stranger, sent.uri)) !== undefined) {
    throw new StepFailure("the filtered mention is among the notifications");
  }
  if (receiver.origin !== A) {
    const conversations = await call(receiver, "/api/v1/conversations?limit=40", Conversations);
    if (conversations.some((entry) => entry.last_status?.uri === sent.uri)) {
      throw new StepFailure(
        "the filtered message has a conversation before the request is accepted",
      );
    }
  }
  await call(receiver, `/api/v1/notifications/requests/${request.id}/accept`, Anything, {
    method: "POST",
    body: {},
  });
  await eventually("accepting the request notifies", () =>
    mentionNotification(receiver, stranger, sent.uri),
  );
  await conversationOf(receiver, sent.uri);
  const next = await post(stranger, {
    status: `${receiver.acct} from a stranger again ${stamp}`,
    visibility: "direct",
  });
  await eventually("the next message notifies without a request", () =>
    mentionNotification(receiver, stranger, next.uri),
  );
};

export const directScenarios = async ({ stamp, mona, carol, dana }: Cast): Promise<void> => {
  const alice = await signUp(A, "dora");
  const bob = await signUp(A, "dirk");

  // A private mention from an account its receiver does not follow waits in
  // a request, and on Mastodon has no conversation until then, so the
  // Mastodon recipients follow every sender.
  await step("the Mastodon recipients follow the senders", async () => {
    for (const [follower, followed] of [
      [mona, alice],
      [mona, bob],
      [mona, carol],
      [carol, alice],
      [carol, bob],
      [carol, mona],
    ] as const) {
      await follow(follower, followed);
    }
  });

  await groupChain(stamp, alice, bob, mona, carol);
  await groupChain(stamp, mona, carol, alice, bob);

  await step(
    "a stranger's direct message waits in a notification request: tstodon → Mastodon",
    () => signUp(A, "stig").then((stranger) => strangerMessage(stamp, stranger, dana)),
  );
  await step(
    "a stranger's direct message waits in a notification request: Mastodon → tstodon",
    () => signUp(A, "rita").then((receiver) => strangerMessage(stamp, dana, receiver)),
  );
};
