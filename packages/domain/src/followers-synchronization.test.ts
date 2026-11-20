import { describe, expect, it } from "vite-plus/test";
import { FollowersSynchronization } from "./followers-synchronization";
import { OutboundFollow } from "./outbound-follow";
import { Visibility } from "./visibility";

const bob = "https://remote.example/users/bob";
const carol = "https://remote.example/users/carol";

describe("FollowersSynchronization.digest", () => {
  // Vectors from Mastodon's `Xorcist.xor!` over `Digest::SHA256.digest`.
  it("XORs the SHA-256 of each URI, as hex", async () => {
    expect(await FollowersSynchronization.digest([])).toBe("0".repeat(64));
    expect(await FollowersSynchronization.digest([bob])).toBe(
      "7465f01e38a0fe4071b7c1784b472567d44a2cb4a812a6f35983918dac2ddd86",
    );
    expect(await FollowersSynchronization.digest([bob, carol])).toBe(
      "0f7fa9dcc2c54ce5c4aca2d551e6f7be697bff4d2dc30029c9b8565608c9d096",
    );
    expect(await FollowersSynchronization.digest([carol, bob])).toBe(
      await FollowersSynchronization.digest([bob, carol]),
    );
  });
});

describe("FollowersSynchronization.uriPrefix", () => {
  it("keeps the scheme and authority as written, as Account::URL_PREFIX_RE", () => {
    expect(FollowersSynchronization.uriPrefix("https://remote.example/inbox")).toBe(
      "https://remote.example",
    );
    expect(FollowersSynchronization.uriPrefix("http://Remote.example:8080/users/a")).toBe(
      "http://Remote.example:8080",
    );
    expect(FollowersSynchronization.uriPrefix("https://remote.example")).toBe(
      "https://remote.example",
    );
    expect(FollowersSynchronization.uriPrefix("Https://remote.example/inbox")).toBeUndefined();
    expect(FollowersSynchronization.uriPrefix("ftp://remote.example/inbox")).toBeUndefined();
  });

  it("matches a URI under the prefix or equal to it, case-sensitively", () => {
    const prefix = "https://remote.example";
    expect(FollowersSynchronization.underPrefix(bob, prefix)).toBe(true);
    expect(FollowersSynchronization.underPrefix(prefix, prefix)).toBe(true);
    expect(FollowersSynchronization.underPrefix("https://remote.example.org/u", prefix)).toBe(
      false,
    );
    expect(FollowersSynchronization.underPrefix("https://remote.example:8443/u", prefix)).toBe(
      false,
    );
    expect(FollowersSynchronization.underPrefix("https://REMOTE.example/u", prefix)).toBe(false);
  });
});

describe("FollowersSynchronization.header", () => {
  it("writes the parameters in Mastodon's order", () => {
    expect(
      FollowersSynchronization.header({
        collectionId: "https://example.com/users/alice/followers",
        digest: "ab",
        url: "https://example.com/users/alice/followers_synchronization",
      }),
    ).toBe(
      'collectionId="https://example.com/users/alice/followers", digest="ab", url="https://example.com/users/alice/followers_synchronization"',
    );
  });
});

describe("FollowersSynchronization.parseHeader", () => {
  // Each case is Mastodon's `SignatureParser.parse` run on the same input.
  const parsed = (raw: string) =>
    FollowersSynchronization.parseHeader(raw).match(
      (params) => Object.fromEntries(params),
      (error) => error.kind,
    );

  it("reads the header Mastodon writes", () => {
    expect(
      parsed(
        'collectionId="https://a.example/users/x/followers", digest="ab12", url="https://a.example/users/x/followers_synchronization"',
      ),
    ).toEqual({
      collectionId: "https://a.example/users/x/followers",
      digest: "ab12",
      url: "https://a.example/users/x/followers_synchronization",
    });
  });

  it("takes tokens, loose commas and the old `Signature ` prefix", () => {
    expect(parsed('Signature collectionId="c",digest=abc ,  url="u"')).toEqual({
      collectionId: "c",
      digest: "abc",
      url: "u",
    });
    expect(parsed('collectionId = "c"')).toEqual({ collectionId: "c" });
    expect(parsed("a=b  ")).toEqual({ a: "b" });
  });

  it("keeps a quoted pair as written", () => {
    expect(parsed('collectionId="c", digest="a\\"b"')).toEqual({
      collectionId: "c",
      digest: 'a\\"b',
    });
  });

  it("refuses what Mastodon refuses", () => {
    expect(parsed('collectionId="c" digest="d"')).toBe("MalformedHeader");
    expect(parsed('collectionId="c",')).toBe("MalformedHeader");
    expect(parsed(' collectionId="c"')).toBe("MalformedHeader");
    expect(parsed('a="b"x')).toBe("MalformedHeader");
    expect(parsed("")).toBe("MalformedHeader");
    expect(parsed('collectionId="c", collectionId="d"')).toBe("DuplicateKey");
  });
});

describe("FollowersSynchronization.synchronizes", () => {
  it("is for a followers-only status of an account under 25,000 followers", () => {
    expect(FollowersSynchronization.synchronizes(Visibility.FollowersOnly, 24_999)).toBe(true);
    expect(FollowersSynchronization.synchronizes(Visibility.FollowersOnly, 25_000)).toBe(false);
    expect(FollowersSynchronization.synchronizes(Visibility.Public, 1)).toBe(false);
    expect(FollowersSynchronization.synchronizes(Visibility.Unlisted, 1)).toBe(false);
    expect(FollowersSynchronization.synchronizes(Visibility.Direct, 1)).toBe(false);
  });
});

describe("FollowersSynchronization.matchesDigest", () => {
  it("compares the listed URIs with the expected digest, in either case", async () => {
    const digest = await FollowersSynchronization.digest([bob]);
    expect(await FollowersSynchronization.matchesDigest([bob], digest)).toBe(true);
    expect(await FollowersSynchronization.matchesDigest([bob], digest.toUpperCase())).toBe(true);
    expect(await FollowersSynchronization.matchesDigest([bob, carol], digest)).toBe(false);
    expect(await FollowersSynchronization.matchesDigest([bob], digest.slice(2))).toBe(false);
  });
});

describe("FollowersSynchronization.listedFollowAction", () => {
  it("keeps a follow, accepts a request, and undoes a follow this server does not hold", () => {
    expect(FollowersSynchronization.listedFollowAction(OutboundFollow.Accepted)).toEqual({
      kind: "Keep",
    });
    expect(FollowersSynchronization.listedFollowAction(OutboundFollow.Requested)).toEqual({
      kind: "Authorize",
    });
    expect(FollowersSynchronization.listedFollowAction(undefined)).toEqual({ kind: "Undo" });
  });
});
