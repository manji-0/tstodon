import { describe, expect, it } from "vite-plus/test";
import {
  NotificationPolicy,
  type MentionAncestor,
  type NotificationSender,
} from "./notification-policy";

const NOW = Date.parse("2026-11-04T00:00:00.000Z");

const strict = {
  forNotFollowing: "filter",
  forNotFollowers: "filter",
  forNewAccounts: "filter",
  forPrivateMentions: "drop",
  forLimitedAccounts: "drop",
  forBots: "filter",
} as const satisfies NotificationPolicy;

const acceptAll = {
  forNotFollowing: "accept",
  forNotFollowers: "accept",
  forNewAccounts: "accept",
  forPrivateMentions: "accept",
  forLimitedAccounts: "accept",
  forBots: "accept",
} as const satisfies NotificationPolicy;

/** An established account in a mutual follow with the recipient. */
const friend = {
  createdAt: "2025-01-01T00:00:00.000Z",
  standing: { kind: "InGoodStanding" },
  bot: false,
  followedByRecipient: true,
  followsRecipientSince: "2025-06-01T00:00:00.000Z",
  unansweredPrivateMention: false,
} as const satisfies NotificationSender;

/** An established account that follows the recipient, who does not follow back. */
const follower = { ...friend, followedByRecipient: false } as const satisfies NotificationSender;

const only = (category: Partial<NotificationPolicy>): NotificationPolicy => ({
  ...acceptAll,
  ...category,
});

describe("NotificationPolicy.default", () => {
  it("is Mastodon's: private mentions and limited accounts filtered, the rest accepted", () => {
    expect(NotificationPolicy.default).toEqual({
      forNotFollowing: "accept",
      forNotFollowers: "accept",
      forNewAccounts: "accept",
      forPrivateMentions: "filter",
      forLimitedAccounts: "filter",
      forBots: "accept",
    });
  });
});

describe("NotificationPolicy.disposition", () => {
  it("accepts a mutual, established account under a strict policy", () => {
    expect(NotificationPolicy.disposition(strict, friend, NOW)).toBe("accept");
  });

  it("applies the most restrictive matching category", () => {
    expect(NotificationPolicy.disposition(strict, follower, NOW)).toBe("filter");
    expect(
      NotificationPolicy.disposition(strict, { ...follower, unansweredPrivateMention: true }, NOW),
    ).toBe("drop");
  });

  it("spares a sender the recipient follows every category but for_not_followers", () => {
    const followed = {
      ...friend,
      createdAt: "2026-11-01T00:00:00.000Z",
      standing: { kind: "Silenced" },
      bot: true,
      unansweredPrivateMention: true,
    } as const;
    expect(NotificationPolicy.disposition(strict, followed, NOW)).toBe("accept");
    expect(
      NotificationPolicy.disposition(
        only({ forNotFollowers: "filter" }),
        { ...followed, followsRecipientSince: undefined },
        NOW,
      ),
    ).toBe("filter");
  });

  it("applies for_private_mentions to a private mention that answers nothing of the recipient's", () => {
    const policy = only({ forPrivateMentions: "filter" });
    expect(
      NotificationPolicy.disposition(policy, { ...follower, unansweredPrivateMention: true }, NOW),
    ).toBe("filter");
    expect(NotificationPolicy.disposition(policy, follower, NOW)).toBe("accept");
  });

  it("counts an account first stored within 30 days as new", () => {
    const policy = only({ forNewAccounts: "filter" });
    const fresh = { ...follower, createdAt: "2026-10-20T00:00:00.000Z" };
    expect(NotificationPolicy.disposition(policy, fresh, NOW)).toBe("filter");
    expect(
      NotificationPolicy.disposition(policy, { ...fresh, createdAt: "2026-10-01T00:00:00Z" }, NOW),
    ).toBe("accept");
    expect(NotificationPolicy.disposition(policy, { ...fresh, createdAt: "not a date" }, NOW)).toBe(
      "accept",
    );
  });

  it("counts a follow of less than three days as no follower", () => {
    const policy = only({ forNotFollowers: "filter" });
    expect(NotificationPolicy.disposition(policy, friend, NOW)).toBe("accept");
    expect(
      NotificationPolicy.disposition(
        policy,
        { ...friend, followsRecipientSince: "2026-11-02T00:00:00.000Z" },
        NOW,
      ),
    ).toBe("filter");
    expect(
      NotificationPolicy.disposition(policy, { ...friend, followsRecipientSince: undefined }, NOW),
    ).toBe("filter");
  });

  it("applies for_limited_accounts to a silenced sender and drops a suspended one", () => {
    expect(
      NotificationPolicy.disposition(
        NotificationPolicy.default,
        { ...follower, standing: { kind: "Silenced" } },
        NOW,
      ),
    ).toBe("filter");
    expect(
      NotificationPolicy.disposition(
        acceptAll,
        { ...friend, standing: { kind: "Suspended" } },
        NOW,
      ),
    ).toBe("drop");
  });

  it("applies for_bots to a bot, accepting bots by default", () => {
    expect(
      NotificationPolicy.disposition(NotificationPolicy.default, { ...follower, bot: true }, NOW),
    ).toBe("accept");
    for (const forBots of ["filter", "drop"] as const) {
      const policy = only({ forBots });
      expect(NotificationPolicy.disposition(policy, { ...follower, bot: true }, NOW)).toBe(forBots);
      expect(NotificationPolicy.disposition(policy, follower, NOW)).toBe("accept");
    }
  });
});

describe("NotificationPolicy.answersRecipient", () => {
  const theirs = { byRecipient: false, direct: true, mentionsSender: false } as const;
  const mine = { byRecipient: true, direct: true, mentionsSender: true } as const;

  it("is false for a mention that replies to nothing", () => {
    expect(NotificationPolicy.answersRecipient([])).toBe(false);
  });

  it("is true for a reply to the recipient's direct message to the sender", () => {
    expect(NotificationPolicy.answersRecipient([mine])).toBe(true);
  });

  it("finds the recipient's message further up a conversation of several people", () => {
    expect(NotificationPolicy.answersRecipient([theirs, theirs, mine])).toBe(true);
  });

  it("needs the recipient's message to be direct and to mention the sender", () => {
    expect(NotificationPolicy.answersRecipient([{ ...mine, direct: false }])).toBe(false);
    expect(NotificationPolicy.answersRecipient([{ ...mine, mentionsSender: false }])).toBe(false);
  });

  it("stops at a parent that mentions the sender, whoever wrote it", () => {
    // Mastodon's query ends its walk there, so the recipient's message above is not reached.
    const parent = { ...theirs, mentionsSender: true };
    expect(NotificationPolicy.answersRecipient([parent, mine])).toBe(false);
    // Only the parent ends the walk so: further up, another account's mention is passed over.
    expect(NotificationPolicy.answersRecipient([theirs, parent, mine])).toBe(true);
  });

  it("reads no further than Mastodon's depth limit", () => {
    const above = (count: number): MentionAncestor[] => Array.from({ length: count }, () => theirs);
    expect(NotificationPolicy.answersRecipient([...above(100), mine])).toBe(true);
    expect(NotificationPolicy.answersRecipient([...above(101), mine])).toBe(false);
  });
});
