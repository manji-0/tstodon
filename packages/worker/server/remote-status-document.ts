import type {
  ApiAccountJSON,
  ApiOriginalStatusJSON,
  ApiPreviewCardJSON,
  ApiTagJSON,
  MediaAttachmentType,
} from "@tstodon/api";
import {
  type QuoteApprovalForViewer,
  type RemoteStatus as RemoteStatusValue,
  Visibility,
} from "@tstodon/domain";
import { remotePollJson } from "./poll-document";
import { NO_REMOTE_POLL_VOTES, type RemotePollVotes } from "./remote-poll-vote-store";
import { remoteEmojisJson } from "./remote-emoji-document";
import { httpUrl, sanitizeRemoteHtml } from "./sanitize-html";
import { NO_STATUS_INTERACTIONS, type StatusInteractionCounts } from "./status-interaction-store";

/** What a remote status shows beside its own fields: its card, and the viewer's and this instance's engagement. */
export type RemoteStatusExtras = Readonly<{
  card?: ApiPreviewCardJSON | null | undefined;
  /** Its hashtags; none when unset. */
  tags?: ReadonlyArray<ApiTagJSON> | undefined;
  pollVotes?: RemotePollVotes | undefined;
  /** Local accounts' favourites and boosts only; remote totals are not kept. */
  interactions?: StatusInteractionCounts | undefined;
  /** Whether the viewer may quote it; no viewer may when unset, as Mastodon answers an anonymous one. */
  quoteApproval?: QuoteApprovalForViewer | undefined;
  /** Accepted quotes by statuses on this instance; remote totals are not kept. */
  quotesCount?: number | undefined;
}>;

/** A remote status with `account`, its author as the reader is shown it. */
export const mastodonRemoteStatus = (
  status: RemoteStatusValue,
  account: ApiAccountJSON,
  extras: RemoteStatusExtras = {},
): ApiOriginalStatusJSON => {
  const card = extras.card ?? null;
  const pollVotes = extras.pollVotes ?? NO_REMOTE_POLL_VOTES;
  const interactions = extras.interactions ?? NO_STATUS_INTERACTIONS;
  const url = httpUrl(status.url) ?? httpUrl(status.objectUri) ?? null;
  return {
    id: status.id,
    created_at: status.publishedAt,
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    sensitive: status.sensitive,
    spoiler_text: status.spoilerText,
    visibility: Visibility.toMastodon(status.visibility),
    language: status.language.kind === "Present" ? status.language.value : null,
    uri: status.objectUri,
    url,
    replies_count: 0,
    reblogs_count: interactions.reblogs,
    favourites_count: interactions.favourites,
    edited_at: status.editedAt.kind === "Edited" ? status.editedAt.at : null,
    favourited: interactions.favourited,
    reblogged: interactions.reblogged,
    muted: false,
    bookmarked: interactions.bookmarked,
    content: sanitizeRemoteHtml(status.contentHtml),
    reblog: null,
    account,
    // Ids follow the stored order; an attachment that is not an http(s) URL is left out.
    media_attachments: status.media.flatMap((attachment, index) =>
      httpUrl(attachment.url) === undefined
        ? []
        : [
            {
              id: `${status.id}-${index}`,
              type: remoteMediaType(attachment.mediaType),
              url: attachment.url,
              preview_url: attachment.url,
              remote_url: attachment.url,
              text_url: attachment.url,
              meta: {},
              description: attachment.description.length > 0 ? attachment.description : null,
              blurhash: null,
            },
          ],
    ),
    mentions: [],
    tags: [...(extras.tags ?? [])],
    emojis: remoteEmojisJson(status.emojis),
    card,
    poll:
      status.poll.kind === "NoPoll"
        ? null
        : remotePollJson(status.id, status.poll, pollVotes, status.emojis),
    quote: null,
    quotes_count: extras.quotesCount ?? 0,
    quote_approval: {
      automatic: status.quotePolicy.automatic,
      manual: status.quotePolicy.manual,
      current_user: extras.quoteApproval ?? "denied",
    },
    // Mastodon 4.7 collections; none are kept here.
    tagged_collections: [],
  };
};

const remoteMediaType = (mediaType: string): MediaAttachmentType => {
  const type = mediaType.toLowerCase();
  if (type.length === 0) {
    return "unknown";
  }
  if (type.startsWith("video/")) {
    return "video";
  }
  if (type.startsWith("audio/")) {
    return "audio";
  }
  if (type.startsWith("image/")) {
    return "image";
  }
  return "unknown";
};
