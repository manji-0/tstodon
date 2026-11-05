import { describe, expect, it } from "vite-plus/test";
import { AccountId } from "./account-id";
import type { StreamChannel } from "./stream-channel";
import { type StreamAccess, StreamSubscription, type StreamViewer } from "./stream-subscription";

const accountId = AccountId.schema.parse("alice-id");
const account = { kind: "Account", accountId } as const satisfies StreamViewer;
const anonymous = { kind: "Anonymous" } as const satisfies StreamViewer;
const full = { statuses: true, notifications: true } as const satisfies StreamAccess;
const statusesOnly = { statuses: true, notifications: false } as const satisfies StreamAccess;
const none = { statuses: false, notifications: false } as const satisfies StreamAccess;

const user = { kind: "User" } as const satisfies StreamChannel;
const notifications = { kind: "UserNotification" } as const satisfies StreamChannel;
const list = { kind: "List", listId: "l1" } as const satisfies StreamChannel;
const hashtag = { kind: "Hashtag", tag: "cats", localOnly: false } as const satisfies StreamChannel;

const refusal = (viewer: StreamViewer, access: StreamAccess, channel: StreamChannel) => {
  const result = StreamSubscription.authorize(viewer, access, channel);
  return result.isErr() ? result.error.kind : undefined;
};

describe("StreamSubscription.authorize", () => {
  it("opens hashtag streams to anonymous sockets", () => {
    expect(StreamSubscription.authorize(anonymous, none, hashtag)._unsafeUnwrap()).toEqual({
      kind: "Granted",
      channel: hashtag,
    });
  });

  it("needs the account for its own streams", () => {
    expect(refusal(anonymous, full, user)).toBe("NeedsAccount");
    expect(refusal(anonymous, full, notifications)).toBe("NeedsAccount");
    expect(refusal(anonymous, full, list)).toBe("NeedsAccount");
  });

  it("needs the scope of each stream", () => {
    expect(refusal(account, none, user)).toBe("InsufficientScope");
    expect(refusal(account, statusesOnly, notifications)).toBe("InsufficientScope");
    expect(refusal(account, none, list)).toBe("InsufficientScope");
    expect(StreamSubscription.authorize(account, statusesOnly, user).isOk()).toBe(true);
  });

  it("leaves a list stream to the list's owner", () => {
    expect(StreamSubscription.authorize(account, statusesOnly, list)._unsafeUnwrap()).toEqual({
      kind: "NeedsListOwner",
      channel: list,
      accountId,
    });
  });
});
