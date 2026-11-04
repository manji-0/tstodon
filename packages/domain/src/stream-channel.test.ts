import { describe, expect, it } from "vite-plus/test";
import { STREAM_LIST_ID_MAX_LENGTH, STREAM_TAG_MAX_LENGTH, StreamChannel } from "./stream-channel";

const nameOf = (input: Parameters<typeof StreamChannel.fromWire>[0]) =>
  StreamChannel.fromWire(input).map(StreamChannel.streamName);

describe("StreamChannel", () => {
  it("names every stream the way the client asked for it", () => {
    for (const stream of [
      "user",
      "user:notification",
      "public",
      "public:media",
      "public:local",
      "public:local:media",
      "public:remote",
      "public:remote:media",
    ]) {
      expect(nameOf({ stream })._unsafeUnwrap()).toEqual([stream]);
    }
    expect(nameOf({ stream: "hashtag", tag: "#Cats" })._unsafeUnwrap()).toEqual([
      "hashtag",
      "Cats",
    ]);
    expect(nameOf({ stream: "hashtag:local", tag: "cats" })._unsafeUnwrap()).toEqual([
      "hashtag:local",
      "cats",
    ]);
    expect(nameOf({ stream: "list", list: "42" })._unsafeUnwrap()).toEqual(["list", "42"]);
  });

  it("refuses unknown streams and missing parameters", () => {
    expect(StreamChannel.fromWire({ stream: "direct:everyone" })._unsafeUnwrapErr()).toEqual({
      kind: "UnknownStream",
    });
    expect(StreamChannel.fromWire({ stream: "hashtag", tag: " " })._unsafeUnwrapErr()).toEqual({
      kind: "MissingTag",
    });
    expect(StreamChannel.fromWire({ stream: "list" })._unsafeUnwrapErr()).toEqual({
      kind: "MissingList",
    });
  });

  it("treats hashtags that differ only in case as one channel", () => {
    const upper = StreamChannel.fromWire({ stream: "hashtag", tag: "Cats" })._unsafeUnwrap();
    const lower = StreamChannel.fromWire({ stream: "hashtag", tag: "cats" })._unsafeUnwrap();
    const local = StreamChannel.fromWire({ stream: "hashtag:local", tag: "cats" })._unsafeUnwrap();
    expect(StreamChannel.key(upper)).toBe(StreamChannel.key(lower));
    expect(StreamChannel.key(local)).not.toBe(StreamChannel.key(lower));
  });

  it("accepts only hashtag names: letters, digits, and underscores with a letter", () => {
    for (const tag of ["cats", "Cats_2026", "日本語", "café", "a".repeat(STREAM_TAG_MAX_LENGTH)]) {
      expect(StreamChannel.fromWire({ stream: "hashtag", tag }).isOk()).toBe(true);
    }
    for (const tag of [
      "_",
      "%",
      "a%b",
      "a b",
      "a-b",
      "2026",
      "a".repeat(STREAM_TAG_MAX_LENGTH + 1),
    ]) {
      expect(StreamChannel.fromWire({ stream: "hashtag", tag })._unsafeUnwrapErr()).toEqual({
        kind: "InvalidTag",
      });
    }
  });

  it("refuses list ids no list could have", () => {
    expect(
      StreamChannel.fromWire({
        stream: "list",
        list: "1".repeat(STREAM_LIST_ID_MAX_LENGTH + 1),
      })._unsafeUnwrapErr(),
    ).toEqual({ kind: "InvalidList" });
  });

  it("parses back only channels the wire parser could produce", () => {
    expect(StreamChannel.parse({ kind: "Hashtag", tag: "%", localOnly: false }).isErr()).toBe(true);
  });

  it("name the stream an SSE path stands for", () => {
    expect(StreamChannel.streamFromPath("user", false)).toBe("user");
    expect(StreamChannel.streamFromPath("/user/notification/", false)).toBe("user:notification");
    expect(StreamChannel.streamFromPath("public/local", false)).toBe("public:local");
    expect(StreamChannel.streamFromPath("public/remote/media", false)).toBe("public:remote:media");
    expect(StreamChannel.streamFromPath("public/remote", true)).toBe("public:remote:media");
    expect(StreamChannel.streamFromPath("public/media", true)).toBe("public:media");
    expect(StreamChannel.streamFromPath("hashtag/local", true)).toBe("hashtag:local");
    expect(StreamChannel.streamFromPath("health", false)).toBeUndefined();
    expect(StreamChannel.streamFromPath("constructor", false)).toBeUndefined();
    expect(StreamChannel.streamFromPath("", false)).toBeUndefined();
  });
});
