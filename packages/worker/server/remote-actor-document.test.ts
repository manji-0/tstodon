import { InstanceIdentity } from "@tstodon/domain";
import { describe, expect, it } from "vite-plus/test";
import { instanceActorDocument } from "./instance-actor";
import { remoteActorFromDocument } from "./remote-actor-fetch";
import { instanceActorJrd, webFingerResource } from "./webfinger-resource";

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
      expect(actor.isOk() && actor.value.actor.username).toBe(username.toLowerCase());
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

describe("the instance actor's username", () => {
  const identity = (domain: string) =>
    InstanceIdentity.parse({
      kind: "InstanceIdentity",
      domain,
      publicOrigin: `http://${domain}`,
      name: "tstodon",
      description: "",
      sourceUrl: "https://example.com/source",
      languages: ["en"],
      contactEmail: "admin@example.com",
      thumbnailUrl: "https://example.com/thumb.png",
      mediaPublicBaseUrl: "https://example.com/media",
    })._unsafeUnwrap();

  it("is one a remote server takes, as Mastodon renames a domain with a port to mastodon.internal", () => {
    for (const domain of ["example.com", "127.0.0.1:8791"]) {
      const local = identity(domain);
      const document = instanceActorDocument(
        local,
        "-----BEGIN PUBLIC KEY-----\n-----END PUBLIC KEY-----\n",
      );
      expect(remoteActorFromDocument(document, document.id).isOk()).toBe(true);
      const subject = instanceActorJrd(local).subject;
      expect(webFingerResource(local, subject)).toEqual({ kind: "InstanceActor" });
    }
    expect(instanceActorDocument(identity("127.0.0.1:8791"), "pem").preferredUsername).toBe(
      "mastodon.internal",
    );
    expect(instanceActorDocument(identity("example.com"), "pem").preferredUsername).toBe(
      "example.com",
    );
  });
});
