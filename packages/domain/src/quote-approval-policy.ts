import { QUOTE_APPROVAL_AUDIENCES, type UserQuotePolicy } from "@tstodon/api/values";
import { schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";
import type { Visibility } from "./visibility";

const PublicSchema = unitKind("Public");
const FollowersSchema = unitKind("Followers");
const NobodySchema = unitKind("Nobody");

export const QuoteApprovalPolicySchema = z.discriminatedUnion("kind", [
  PublicSchema,
  FollowersSchema,
  NobodySchema,
]);

export type QuoteApprovalPolicy = z.infer<typeof QuoteApprovalPolicySchema>;

export const QuoteApprovalPolicy = {
  schema: QuoteApprovalPolicySchema,
  parse: schemaResult(QuoteApprovalPolicySchema),
  Public: { kind: "Public" } as const satisfies QuoteApprovalPolicy,
  Followers: { kind: "Followers" } as const satisfies QuoteApprovalPolicy,
  Nobody: { kind: "Nobody" } as const satisfies QuoteApprovalPolicy,
} as const;

/** One audience a remote author lets quote a note, by Mastodon's REST name for it. */
export const QuoteAudienceSchema = z.literal(QUOTE_APPROVAL_AUDIENCES);

export type QuoteAudience = z.infer<typeof QuoteAudienceSchema>;

/**
 * Who may quote a note, as Mastodon's `quote_interaction_policy`: a remote
 * note's `interactionPolicy.canQuote`, or a local note's own policy.
 */
export const QuoteInteractionPolicySchema = z.object({
  automatic: z.array(QuoteAudienceSchema),
  manual: z.array(QuoteAudienceSchema),
});

export type QuoteInteractionPolicy = z.infer<typeof QuoteInteractionPolicySchema>;

/** Mastodon's `current_user` answer: whether the viewer may quote, and how. */
export type QuoteApprovalForViewer = UserQuotePolicy;

/** Who the viewer is to the note's author; `undefined` for no viewer. */
export type QuoteViewerRelation = Readonly<{
  viewerIsAuthor: boolean;
  viewerFollowsAuthor: boolean;
  authorFollowsViewer: boolean;
}>;

const PUBLIC_AUDIENCE = new Set([
  "https://www.w3.org/ns/activitystreams#Public",
  "as:Public",
  "Public",
]);

const CanQuoteSchema = z.object({
  automaticApproval: z.unknown().optional(),
  manualApproval: z.unknown().optional(),
});

const parseCanQuote = schemaResult(CanQuoteSchema);

const hostOf = (uri: string): string | undefined => {
  try {
    return new URL(uri).host;
  } catch {
    return undefined;
  }
};

/** The author a `canQuote` belongs to, with the collections its actor document named. */
export type QuotePolicyAuthor = Readonly<{
  actorUri: string;
  followersUri?: string | undefined;
  followingUri?: string | undefined;
}>;

/** A URI as the URL parser writes it, so two spellings of one URI compare equal. */
const normalized = (uri: string): string | undefined => {
  try {
    return new URL(uri).href;
  } catch {
    return undefined;
  }
};

/**
 * The author's own collection a URI names. When the author's actor document
 * named its collections, only those URIs match, as Mastodon compares with
 * `followers_url` / `following_url`. An author cached before those were kept
 * names none, and falls back to a URI on the author's host whose path ends
 * in `/followers` or `/following`, as `visibilityFromAudience` reads them;
 * the policy only renders who may ask to quote, the quoted server decides.
 */
const authorCollection = (
  uri: string,
  author: QuotePolicyAuthor,
): "followers" | "following" | undefined => {
  if (author.followersUri !== undefined || author.followingUri !== undefined) {
    const entry = normalized(uri);
    if (entry === undefined) {
      return undefined;
    }
    if (author.followersUri !== undefined && normalized(author.followersUri) === entry) {
      return "followers";
    }
    if (author.followingUri !== undefined && normalized(author.followingUri) === entry) {
      return "following";
    }
    return undefined;
  }
  const authorHost = hostOf(author.actorUri);
  if (authorHost === undefined || hostOf(uri) !== authorHost) {
    return undefined;
  }
  const path = new URL(uri).pathname;
  if (path.endsWith("/followers")) {
    return "followers";
  }
  if (path.endsWith("/following")) {
    return "following";
  }
  return undefined;
};

const AUDIENCE_ORDER: ReadonlyArray<QuoteAudience> = [
  "public",
  "followers",
  "following",
  "unsupported_policy",
];

/** Mastodon's `quote_subpolicy`: known audiences, the author's own URI dropped, anything else unsupported. */
const subpolicy = (raw: unknown, author: QuotePolicyAuthor): QuoteAudience[] => {
  const entries = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
  const found = new Set<QuoteAudience>();
  for (const entry of entries) {
    if (typeof entry !== "string") {
      found.add("unsupported_policy");
    } else if (PUBLIC_AUDIENCE.has(entry)) {
      found.add("public");
    } else if (entry !== author.actorUri) {
      found.add(authorCollection(entry, author) ?? "unsupported_policy");
    }
  }
  return AUDIENCE_ORDER.filter((audience) => found.has(audience));
};

const allows = (audiences: ReadonlyArray<QuoteAudience>, relation: QuoteViewerRelation): boolean =>
  audiences.includes("public") ||
  (audiences.includes("followers") && relation.viewerFollowsAuthor) ||
  (audiences.includes("following") && relation.authorFollowsViewer);

const none: QuoteInteractionPolicy = { automatic: [], manual: [] };

export const QuoteInteractionPolicy = {
  schema: QuoteInteractionPolicySchema,
  parse: schemaResult(QuoteInteractionPolicySchema),
  /** No policy advertised: Mastodon lets nobody but the author quote. */
  none,
  /** Read a note's `interactionPolicy.canQuote`, as Mastodon's status parser does. */
  fromCanQuote: (canQuote: unknown, author: QuotePolicyAuthor): QuoteInteractionPolicy => {
    const parsed = parseCanQuote(canQuote);
    if (parsed.isErr()) {
      return none;
    }
    return {
      automatic: subpolicy(parsed.value.automaticApproval, author),
      manual: subpolicy(parsed.value.manualApproval, author),
    };
  },
  /**
   * Mastodon's `quote_policy_for_account`: no viewer and a direct note are
   * denied, the author may always quote their own note, then the policy.
   */
  forViewer: (
    policy: QuoteInteractionPolicy,
    visibility: Visibility,
    relation: QuoteViewerRelation | undefined,
  ): QuoteApprovalForViewer => {
    if (relation === undefined || visibility.kind === "Direct") {
      return "denied";
    }
    if (relation.viewerIsAuthor || allows(policy.automatic, relation)) {
      return "automatic";
    }
    if (allows(policy.manual, relation)) {
      return "manual";
    }
    if (
      policy.automatic.includes("unsupported_policy") ||
      policy.manual.includes("unsupported_policy")
    ) {
      return "unknown";
    }
    return "denied";
  },
} as const;
