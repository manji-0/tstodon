import { describe, expect, it } from "vite-plus/test";
import { RemoteQuotePolicy } from "./quote-approval-policy";
import { Visibility } from "./visibility";

const author = { actorUri: "https://remote.example/users/bob" };
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

describe("RemoteQuotePolicy.fromCanQuote", () => {
  it("maps every spelling of the public collection to public", () => {
    for (const value of [PUBLIC, "as:Public", "Public"]) {
      expect(RemoteQuotePolicy.fromCanQuote({ automaticApproval: [value] }, author)).toEqual({
        automatic: ["public"],
        manual: [],
      });
    }
  });

  it("maps the author's followers and following collections", () => {
    expect(
      RemoteQuotePolicy.fromCanQuote(
        {
          automaticApproval: "https://remote.example/users/bob/followers",
          manualApproval: ["https://remote.example/users/bob/following"],
        },
        author,
      ),
    ).toEqual({ automatic: ["followers"], manual: ["following"] });
  });

  it("drops the author's own URI", () => {
    expect(
      RemoteQuotePolicy.fromCanQuote({ automaticApproval: [author.actorUri] }, author),
    ).toEqual(RemoteQuotePolicy.none);
  });

  it("marks another actor, or another host's collection, as unsupported", () => {
    expect(
      RemoteQuotePolicy.fromCanQuote(
        {
          automaticApproval: [PUBLIC, "https://other.example/users/carol"],
          manualApproval: ["https://other.example/users/bob/followers"],
        },
        author,
      ),
    ).toEqual({ automatic: ["public", "unsupported_policy"], manual: ["unsupported_policy"] });
  });

  it("reads a missing or malformed policy as none", () => {
    expect(RemoteQuotePolicy.fromCanQuote(undefined, author)).toEqual(RemoteQuotePolicy.none);
    expect(RemoteQuotePolicy.fromCanQuote("Public", author)).toEqual(RemoteQuotePolicy.none);
    expect(RemoteQuotePolicy.fromCanQuote({}, author)).toEqual(RemoteQuotePolicy.none);
  });
});

describe("RemoteQuotePolicy.forViewer", () => {
  const stranger = { viewerFollowsAuthor: false, authorFollowsViewer: false };
  const follower = { viewerFollowsAuthor: true, authorFollowsViewer: false };
  const followed = { viewerFollowsAuthor: false, authorFollowsViewer: true };
  const policy = (automatic: string[], manual: string[] = []) =>
    RemoteQuotePolicy.fromCanQuote(
      {
        automaticApproval: automatic.map((key) => audienceUri[key]),
        manualApproval: manual.map((key) => audienceUri[key]),
      },
      author,
    );
  const audienceUri: Record<string, string> = {
    public: PUBLIC,
    followers: "https://remote.example/users/bob/followers",
    following: "https://remote.example/users/bob/following",
    other: "https://other.example/users/carol",
  };
  const forViewer = RemoteQuotePolicy.forViewer;

  it("allows anyone under a public automatic policy", () => {
    expect(forViewer(policy(["public"]), Visibility.Public, stranger)).toBe("automatic");
  });

  it("allows the author's followers and the accounts the author follows", () => {
    expect(forViewer(policy(["followers"]), Visibility.Public, follower)).toBe("automatic");
    expect(forViewer(policy(["followers"]), Visibility.Public, stranger)).toBe("denied");
    expect(forViewer(policy(["following"]), Visibility.Public, followed)).toBe("automatic");
    expect(forViewer(policy(["following"]), Visibility.Public, follower)).toBe("denied");
  });

  it("falls back to the manual tiers after the automatic ones", () => {
    expect(forViewer(policy(["followers"], ["public"]), Visibility.Public, stranger)).toBe(
      "manual",
    );
    expect(forViewer(policy(["followers"], ["public"]), Visibility.Public, follower)).toBe(
      "automatic",
    );
    expect(forViewer(policy([], ["followers"]), Visibility.Public, follower)).toBe("manual");
    expect(forViewer(policy([], ["following"]), Visibility.Public, followed)).toBe("manual");
  });

  it("answers unknown when an unsupported audience could still allow the viewer", () => {
    expect(forViewer(policy(["other"]), Visibility.Public, stranger)).toBe("unknown");
    expect(forViewer(policy([], ["other"]), Visibility.Public, stranger)).toBe("unknown");
  });

  it("denies under no policy, on a direct note, and to no viewer", () => {
    expect(forViewer(RemoteQuotePolicy.none, Visibility.Public, follower)).toBe("denied");
    expect(forViewer(policy(["public"]), Visibility.Direct, follower)).toBe("denied");
    expect(forViewer(policy(["public"]), Visibility.Public, undefined)).toBe("denied");
  });
});
