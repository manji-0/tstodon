import { describe, expect, it } from "vite-plus/test";
import type { ReplyAccount } from "./reply-account";
import {
  NoteThread,
  type NotifiedNote,
  type NotifyingFollower,
  StatusNotificationAudience,
} from "./status-notification-audience";

const note = (overrides: Partial<NotifiedNote> = {}): NotifiedNote => ({
  visibility: { kind: "Public" },
  thread: { kind: "Root" },
  language: { kind: "None" },
  addressed: new Set(),
  ...overrides,
});

const follower = (accountId: string, languages: ReadonlyArray<string> = []): NotifyingFollower => ({
  accountId,
  languages,
});

const recipients = (
  value: NotifiedNote,
  followers: ReadonlyArray<NotifyingFollower> = [follower("a"), follower("b")],
) => StatusNotificationAudience.recipients(value, followers);

describe("StatusNotificationAudience.recipients", () => {
  it("is every notifying follower for a public, unlisted or followers-only note", () => {
    for (const kind of ["Public", "Unlisted", "FollowersOnly"] as const) {
      expect(recipients(note({ visibility: { kind } }))).toEqual(["a", "b"]);
    }
  });

  it("is the named followers only for a limited or direct note", () => {
    for (const kind of ["Limited", "Direct"] as const) {
      expect(recipients(note({ visibility: { kind }, addressed: new Set(["b"]) }))).toEqual(["b"]);
    }
  });

  it("is nobody for a reply to someone else, and everyone for a self-reply", () => {
    expect(recipients(note({ thread: { kind: "ReplyToOther" } }))).toEqual([]);
    expect(recipients(note({ thread: { kind: "SelfReply" } }))).toEqual(["a", "b"]);
  });

  it("leaves out a follower whose follow keeps other languages", () => {
    const followers = [follower("ja", ["ja"]), follower("en", ["en"]), follower("any")];
    expect(recipients(note({ language: { kind: "Present", value: "en" } }), followers)).toEqual([
      "en",
      "any",
    ]);
    expect(recipients(note(), followers)).toEqual(["ja", "en", "any"]);
  });
});

describe("NoteThread.of", () => {
  const alice: ReplyAccount = { kind: "RemoteActor", actorUri: "https://a.example/users/alice" };
  const bob: ReplyAccount = { kind: "LocalAccount", accountId: "1" };

  it("is a self-reply only when the reply answers its own author", () => {
    expect(NoteThread.of({ kind: "NotReply" }, alice)).toEqual({ kind: "Root" });
    expect(NoteThread.of({ kind: "Answers", account: alice }, alice)).toEqual({
      kind: "SelfReply",
    });
    expect(NoteThread.of({ kind: "Answers", account: bob }, alice)).toEqual({
      kind: "ReplyToOther",
    });
    expect(NoteThread.of({ kind: "NoAccount" }, alice)).toEqual({ kind: "ReplyToOther" });
  });
});
