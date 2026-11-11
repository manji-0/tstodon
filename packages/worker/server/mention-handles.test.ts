import { describe, expect, it } from "vite-plus/test";
import { mentionUsernames, remoteMentionHandles } from "./html";

describe("mention handles in post text", () => {
  const text =
    "hi @alice, @Bob@Remote.Example. and @carol@example.com — mail me at dave@mail.example; @eve.k-9@far.example!";

  it("keeps bare handles and own-domain handles local", () => {
    expect(mentionUsernames(text, "example.com")).toEqual(["alice", "carol"]);
  });

  it("reads other domains as remote, lowercased, without trailing punctuation", () => {
    expect(remoteMentionHandles(text, "example.com")).toEqual([
      { username: "bob", domain: "remote.example" },
      { username: "eve.k-9", domain: "far.example" },
    ]);
  });

  it("keeps a port in a remote domain, as an actor's host:port authority", () => {
    expect(
      remoteMentionHandles("cc @bob@127.0.0.1:8792 and @bob@127.0.0.1:8793", "127.0.0.1:8794"),
    ).toEqual([
      { username: "bob", domain: "127.0.0.1:8792" },
      { username: "bob", domain: "127.0.0.1:8793" },
    ]);
  });
});
