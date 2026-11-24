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
  mastodonRails,
  notified,
  Notifications,
  post,
  resolveStatus,
  Search,
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
 * on the sender's messages notify. The message has no conversation either
 * until then, on either server (`AccountConversation.add_status` on accept).
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
  const conversations = await call(receiver, "/api/v1/conversations?limit=40", Conversations);
  if (conversations.some((entry) => entry.last_status?.uri === sent.uri)) {
    throw new StepFailure("the filtered message has a conversation before the request is accepted");
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

/**
 * A note from `sender` that tags `mentioned` and reaches `addressed` without
 * a tag, delivered by Mastodon's own `ActivityPub::DeliveryWorker`, signed
 * with the sender's key. Mastodon's API cannot write such a note: its
 * `to` names only the accounts a status mentions. `inbox` is where it goes.
 */
const deliverUntagged = (
  sender: E2eUser,
  slug: string,
  audience: Readonly<{ to: string[]; tag: E2eUser; inbox: string }>,
): string => {
  const noteUri = `${sender.uri}/statuses/${slug}`;
  const published = new Date().toISOString();
  const note = {
    id: noteUri,
    type: "Note",
    attributedTo: sender.uri,
    content: `<p>${slug}</p>`,
    published,
    to: audience.to,
    cc: [],
    tag: [{ type: "Mention", href: audience.tag.uri, name: `@${audience.tag.acct}` }],
  };
  const create = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${noteUri}/activity`,
    type: "Create",
    actor: sender.uri,
    published,
    to: audience.to,
    cc: [],
    object: note,
  };
  // Base64 keeps the JSON out of Ruby's string interpolation (`#{`, `#@`).
  // `perform` returns without raising on a 4xx (`@unsalvageable`), so the
  // script checks that the request went through (`@performed`).
  const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
  mastodonRails(
    [
      `json = Base64.strict_decode64("${base64(JSON.stringify(create))}").force_encoding("UTF-8")`,
      `sender = Account.find_local!(Base64.strict_decode64("${base64(sender.username)}"))`,
      `inbox = Base64.strict_decode64("${base64(audience.inbox)}")`,
      "worker = ActivityPub::DeliveryWorker.new",
      "worker.perform(json, sender.id, inbox, { 'bypass_availability' => true })",
      'raise "not delivered to #{inbox}" unless worker.instance_variable_get(:@performed)',
    ].join("\n"),
  );
  return noteUri;
};

/**
 * Mastodon's `limited`: a note its audience makes direct that reaches an
 * account without a `Mention` tag (`Create#process_audience`), or arrives at
 * the personal inbox of an account it does not tag. tstodon serves it as
 * `private` to the accounts it reaches and to no one else, adds it to no
 * conversation, and notifies the tagged account past its private-mention
 * policy.
 */
const limitedNote = async (stamp: string, sender: E2eUser): Promise<void> => {
  const mentioned = await signUp(A, "lima");
  const addressed = await signUp(A, "limb");
  const bystander = await signUp(A, "limc");
  const checkReach = async (noteUri: string): Promise<void> => {
    for (const viewer of [mentioned, addressed]) {
      const seen = await resolveStatus(viewer, noteUri);
      if (seen.visibility !== "private") {
        throw new StepFailure(`${viewer.acct} sees it as ${seen.visibility}`);
      }
    }
    const query = new URLSearchParams({ q: noteUri, resolve: "true", type: "statuses" });
    const found = await call(bystander, `/api/v2/search?${query.toString()}`, Search);
    if (found.statuses.length > 0) {
      throw new StepFailure("an account it does not reach finds it");
    }
  };
  const checkLimited = async (noteUri: string): Promise<void> => {
    await checkReach(noteUri);
    await notified(mentioned, "mention", sender, noteUri);
    const conversations = await call(mentioned, "/api/v1/conversations?limit=40", Conversations);
    if (conversations.some((entry) => entry.last_status?.uri === noteUri)) {
      throw new StepFailure("the limited note has a conversation");
    }
  };

  await step("a note that reaches a tstodon user untagged is limited: Mastodon → tstodon", () =>
    checkLimited(
      deliverUntagged(sender, `limited-cc-${stamp}`, {
        to: [mentioned.uri, addressed.uri],
        tag: mentioned,
        inbox: `${A}/inbox`,
      }),
    ),
  );
  await step(
    "a note at the personal inbox of a tstodon user it does not tag is limited: Mastodon → tstodon",
    () =>
      checkLimited(
        deliverUntagged(sender, `limited-inbox-${stamp}`, {
          to: [mentioned.uri],
          tag: mentioned,
          inbox: `${A}/users/${addressed.username}/inbox`,
        }),
      ),
  );
  // `Create#postprocess_audience_and_deliver`: the same activity, at the
  // shared inbox first and then at a personal one, reaches that inbox's owner.
  // The first delivery stores a direct message from a stranger, so its mention
  // waits in a notification request (`NotifyService#message?`), and turning
  // the status limited afterwards does not take it out of that request.
  await step(
    "a note held already, then sent to the personal inbox of a tstodon user it does not tag, is limited: Mastodon → tstodon",
    async () => {
      const slug = `limited-held-${stamp}`;
      const audience = { to: [mentioned.uri], tag: mentioned };
      const noteUri = deliverUntagged(sender, slug, { ...audience, inbox: `${A}/inbox` });
      deliverUntagged(sender, slug, {
        ...audience,
        inbox: `${A}/users/${addressed.username}/inbox`,
      });
      await checkReach(noteUri);
      const request = await eventually(
        "the mentioned account has a notification request",
        async () => {
          const requests = await call(
            mentioned,
            "/api/v1/notifications/requests",
            NotificationRequests,
          );
          return requests.find((entry) => entry.account.uri === sender.uri);
        },
      );
      if (request.last_status?.uri !== noteUri) {
        throw new StepFailure(`the request's last status is ${String(request.last_status?.uri)}`);
      }
    },
  );
};

/**
 * A tstodon post with `visibility=limited`, as Mastodon takes it on
 * `POST /api/v1/statuses`: its author sees it as `private`, and it is
 * addressed and delivered to the account it mentions alone, which Mastodon
 * stores as the direct message its audience makes it. A follower it does
 * not mention cannot find it.
 */
const limitedPost = async (
  stamp: string,
  author: E2eUser,
  mentioned: E2eUser,
  follower: E2eUser,
): Promise<void> => {
  const sent = await post(author, {
    status: `${mentioned.acct} limited ${stamp}`,
    visibility: "limited",
  });
  if (sent.visibility !== "private") {
    throw new StepFailure(`its author sees it as ${sent.visibility}`);
  }
  await notified(mentioned, "mention", author, sent.uri);
  const seen = await resolveStatus(mentioned, sent.uri);
  if (seen.visibility !== "direct") {
    throw new StepFailure(`${mentioned.acct} sees it as ${seen.visibility}`);
  }
  const query = new URLSearchParams({ q: sent.uri, resolve: "true", type: "statuses" });
  const found = await call(follower, `/api/v2/search?${query.toString()}`, Search);
  if (found.statuses.length > 0) {
    throw new StepFailure(`${follower.acct}, who follows its author, finds it`);
  }
};

export const directScenarios = async ({ stamp, mona, carol, dana }: Cast): Promise<void> => {
  const alice = await signUp(A, "dora");
  const bob = await signUp(A, "dirk");

  // A private mention from an account its receiver does not follow waits in
  // a request, and has no conversation until then, on either server. The
  // Mastodon recipients follow every sender; the tstodon recipients, made for
  // this run, take private mentions from anyone instead, since no tstodon
  // user may keep a follow of carol.
  await step("the recipients take the senders' private mentions", async () => {
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
    for (const recipient of [alice, bob]) {
      await call(recipient, "/api/v2/notifications/policy", Anything, {
        method: "PATCH",
        body: { for_private_mentions: "accept" },
      });
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

  await limitedNote(stamp, carol);
  await step("a limited post reaches only the account it mentions: tstodon → Mastodon", () =>
    limitedPost(stamp, alice, mona, carol),
  );
};
