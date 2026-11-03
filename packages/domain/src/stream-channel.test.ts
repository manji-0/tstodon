import { describe, expect, it } from "vite-plus/test";
import { StreamChannel } from "./stream-channel";

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
});
