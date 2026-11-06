import { describe, expect, it } from "vite-plus/test";
import { QuoteInteractionPolicy } from "./quote-approval-policy";
import { Visibility } from "./visibility";

const author = { actorUri: "https://remote.example/users/bob" };
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

describe("QuoteInteractionPolicy.fromCanQuote", () => {
  it("maps every spelling of the public collection to public", () => {
    for (const value of [PUBLIC, "as:Public", "Public"]) {
      expect(QuoteInteractionPolicy.fromCanQuote({ automaticApproval: [value] }, author)).toEqual({
        automatic: ["public"],
        manual: [],
      });
    }
  });

  it("maps the author's followers and following collections", () => {
    expect(
      QuoteInteractionPolicy.fromCanQuote(
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
      QuoteInteractionPolicy.fromCanQuote({ automaticApproval: [author.actorUri] }, author),
    ).toEqual(QuoteInteractionPolicy.none);
  });

  it("marks another actor, or another host's collection, as unsupported", () => {
    expect(
      QuoteInteractionPolicy.fromCanQuote(
        {
          automaticApproval: [PUBLIC, "https://other.example/users/carol"],
          manualApproval: ["https://other.example/users/bob/followers"],
        },
        author,
      ),
    ).toEqual({ automatic: ["public", "unsupported_policy"], manual: ["unsupported_policy"] });
  });

  it("reads a missing or malformed policy as none", () => {
    expect(QuoteInteractionPolicy.fromCanQuote(undefined, author)).toEqual(
      QuoteInteractionPolicy.none,
    );
    expect(QuoteInteractionPolicy.fromCanQuote("Public", author)).toEqual(
      QuoteInteractionPolicy.none,
    );
    expect(QuoteInteractionPolicy.fromCanQuote({}, author)).toEqual(QuoteInteractionPolicy.none);
  });
});

describe("QuoteInteractionPolicy.forViewer", () => {
  const stranger = {
    viewerIsAuthor: false,
    viewerFollowsAuthor: false,
    authorFollowsViewer: false,
  };
  const follower = { viewerIsAuthor: false, viewerFollowsAuthor: true, authorFollowsViewer: false };
  const followed = { viewerIsAuthor: false, viewerFollowsAuthor: false, authorFollowsViewer: true };
  const self = { viewerIsAuthor: true, viewerFollowsAuthor: false, authorFollowsViewer: false };
  const policy = (automatic: string[], manual: string[] = []) =>
    QuoteInteractionPolicy.fromCanQuote(
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
  const forViewer = QuoteInteractionPolicy.forViewer;

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

  it("lets the author quote their own note under any policy but not a direct one", () => {
    expect(forViewer(QuoteInteractionPolicy.none, Visibility.Public, self)).toBe("automatic");
    expect(forViewer(QuoteInteractionPolicy.none, Visibility.FollowersOnly, self)).toBe(
      "automatic",
    );
    expect(forViewer(policy(["public"]), Visibility.Direct, self)).toBe("denied");
  });

  it("denies under no policy, on a direct note, and to no viewer", () => {
    expect(forViewer(QuoteInteractionPolicy.none, Visibility.Public, follower)).toBe("denied");
    expect(forViewer(policy(["public"]), Visibility.Direct, follower)).toBe("denied");
    expect(forViewer(policy(["public"]), Visibility.Public, undefined)).toBe("denied");
  });
});
