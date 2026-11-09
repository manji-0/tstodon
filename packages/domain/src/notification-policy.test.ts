import { describe, expect, it } from "vite-plus/test";
import {
  NotificationPolicy,
  type LocalNotificationSender,
  type RemoteNotificationSender,
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

const friend = {
  kind: "Local",
  createdAt: "2025-01-01T00:00:00.000Z",
  silenced: false,
  recipientFollowsSender: true,
  senderFollowsRecipient: true,
  privateMention: false,
  bot: false,
} as const satisfies LocalNotificationSender;

const remoteFollower = {
  kind: "Remote",
  standing: { kind: "InGoodStanding" },
  followsRecipient: true,
  bot: false,
} as const satisfies RemoteNotificationSender;

describe("NotificationPolicy.disposition", () => {
  it("accepts a mutual, established local account under a strict policy", () => {
    expect(NotificationPolicy.disposition(strict, friend, NOW)).toBe("accept");
  });

  it("applies the most restrictive matching category", () => {
    expect(
      NotificationPolicy.disposition(strict, { ...friend, recipientFollowsSender: false }, NOW),
    ).toBe("filter");
    expect(
      NotificationPolicy.disposition(
        strict,
        { ...friend, recipientFollowsSender: false, privateMention: true },
        NOW,
      ),
    ).toBe("drop");
    expect(NotificationPolicy.disposition(strict, { ...friend, silenced: true }, NOW)).toBe("drop");
  });

  it("exempts a private mention from an account the recipient follows", () => {
    expect(NotificationPolicy.disposition(strict, { ...friend, privateMention: true }, NOW)).toBe(
      "accept",
    );
  });

  it("counts an account created within 30 days as new", () => {
    const fresh = { ...friend, createdAt: "2026-10-20T00:00:00.000Z" };
    expect(NotificationPolicy.disposition(strict, fresh, NOW)).toBe("filter");
    expect(NotificationPolicy.disposition(strict, { ...fresh, createdAt: "not a date" }, NOW)).toBe(
      "accept",
    );
  });

  it("always applies for_not_following to a remote sender, never for_private_mentions", () => {
    expect(NotificationPolicy.disposition(strict, remoteFollower, NOW)).toBe("filter");
    expect(
      NotificationPolicy.disposition(
        { ...acceptAll, forPrivateMentions: "drop" },
        remoteFollower,
        NOW,
      ),
    ).toBe("accept");
    expect(
      NotificationPolicy.disposition(
        { ...acceptAll, forNotFollowers: "filter" },
        { ...remoteFollower, followsRecipient: false },
        NOW,
      ),
    ).toBe("filter");
  });

  it("filters a silenced remote actor by for_limited_accounts and drops a suspended one", () => {
    expect(
      NotificationPolicy.disposition(
        NotificationPolicy.default,
        { ...remoteFollower, standing: { kind: "Silenced" } },
        NOW,
      ),
    ).toBe("filter");
    expect(
      NotificationPolicy.disposition(
        acceptAll,
        { ...remoteFollower, standing: { kind: "Suspended" } },
        NOW,
      ),
    ).toBe("drop");
  });

  it("applies for_bots to a local or remote bot, accepting bots by default", () => {
    expect(NotificationPolicy.default.forBots).toBe("accept");
    expect(NotificationPolicy.disposition(acceptAll, { ...friend, bot: true }, NOW)).toBe("accept");
    for (const forBots of ["filter", "drop"] as const) {
      const policy = { ...acceptAll, forBots };
      expect(NotificationPolicy.disposition(policy, { ...friend, bot: true }, NOW)).toBe(forBots);
      expect(NotificationPolicy.disposition(policy, friend, NOW)).toBe("accept");
      expect(NotificationPolicy.disposition(policy, { ...remoteFollower, bot: true }, NOW)).toBe(
        forBots,
      );
      expect(NotificationPolicy.disposition(policy, remoteFollower, NOW)).toBe("accept");
    }
    // The most restrictive category still wins.
    expect(
      NotificationPolicy.disposition(
        { ...acceptAll, forBots: "filter", forLimitedAccounts: "drop" },
        { ...friend, bot: true, silenced: true },
        NOW,
      ),
    ).toBe("drop");
  });
});
