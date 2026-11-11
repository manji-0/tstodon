import { describe, expect, it } from "vite-plus/test";
import type { StreamChannel } from "./stream-channel";
import { type StreamAccess, StreamSubscription } from "./stream-subscription";

const full = { statuses: true, notifications: true } as const satisfies StreamAccess;
const statusesOnly = { statuses: true, notifications: false } as const satisfies StreamAccess;
const notificationsOnly = { statuses: false, notifications: true } as const satisfies StreamAccess;
const none = { statuses: false, notifications: false } as const satisfies StreamAccess;

const user = { kind: "User" } as const satisfies StreamChannel;
const notifications = { kind: "UserNotification" } as const satisfies StreamChannel;
const list = { kind: "List", listId: "l1" } as const satisfies StreamChannel;
const hashtag = { kind: "Hashtag", tag: "cats", localOnly: false } as const satisfies StreamChannel;
const publicLocal = {
  kind: "Public",
  origin: "Local",
  onlyMedia: false,
} as const satisfies StreamChannel;

const refusal = (access: StreamAccess, channel: StreamChannel) => {
  const result = StreamSubscription.authorize(access, channel);
  return result.isErr() ? result.error.kind : undefined;
};

describe("StreamSubscription.authorize", () => {
  it("needs read:statuses for public and hashtag streams, as Mastodon 4.5 does", () => {
    expect(refusal(none, hashtag)).toBe("InsufficientScope");
    expect(refusal(notificationsOnly, publicLocal)).toBe("InsufficientScope");
    expect(StreamSubscription.authorize(statusesOnly, hashtag)._unsafeUnwrap()).toEqual({
      kind: "Granted",
      channel: hashtag,
    });
    expect(StreamSubscription.authorize(statusesOnly, publicLocal).isOk()).toBe(true);
  });

  it("needs the scope of each stream", () => {
    expect(refusal(none, user)).toBe("InsufficientScope");
    expect(refusal(statusesOnly, notifications)).toBe("InsufficientScope");
    expect(refusal(none, list)).toBe("InsufficientScope");
    expect(StreamSubscription.authorize(statusesOnly, user).isOk()).toBe(true);
    expect(StreamSubscription.authorize(notificationsOnly, notifications).isOk()).toBe(true);
    expect(StreamSubscription.authorize(full, notifications).isOk()).toBe(true);
  });

  it("leaves a list stream to the list's owner", () => {
    expect(StreamSubscription.authorize(statusesOnly, list)._unsafeUnwrap()).toEqual({
      kind: "NeedsListOwner",
      channel: list,
    });
  });
});
