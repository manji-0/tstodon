import { describe, expect, it } from "vite-plus/test";
import { remoteActorFromDocument } from "./remote-actor-fetch";

const ACTOR = "https://remote.example/users/bob";

const document = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ACTOR,
  type: "Person",
  preferredUsername: "bob",
  inbox: `${ACTOR}/inbox`,
  publicKey: {
    id: `${ACTOR}#main-key`,
    owner: ACTOR,
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n",
  },
  ...fields,
});

describe("remoteActorFromDocument", () => {
  it.each(["bob", "Bob_2", "a.b", "a-b", "a..b", "a.-_b", "_", "x"])(
    "takes the remote username %j, as Mastodon's Account does",
    (username) => {
      const actor = remoteActorFromDocument(document({ preferredUsername: username }), ACTOR);
      expect(actor.isOk()).toBe(true);
      expect(actor.isOk() && actor.value.username).toBe(username.toLowerCase());
    },
  );

  it.each([".bob", "bob.", "-bob", "bob-", "bo b", "bob@remote.example", "josé", "ボブ", "a/b"])(
    "refuses the remote username %j, as Mastodon's Account does",
    (username) => {
      expect(
        remoteActorFromDocument(document({ preferredUsername: username }), ACTOR).isErr(),
      ).toBe(true);
    },
  );

  it("refuses a username longer than Mastodon's hard limit of 2048", () => {
    expect(
      remoteActorFromDocument(document({ preferredUsername: "a".repeat(2048) }), ACTOR).isOk(),
    ).toBe(true);
    expect(
      remoteActorFromDocument(document({ preferredUsername: "a".repeat(2049) }), ACTOR).isErr(),
    ).toBe(true);
  });
});
