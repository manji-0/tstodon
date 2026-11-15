import type {
  ApiAccountJSON,
  ApiMediaAttachmentJSON,
  ApiMentionJSON,
  ApiOriginalStatusJSON,
  ApiPreviewCardJSON,
  ApiTagJSON,
} from "@tstodon/api";
import {
  ImageDimensions,
  type QuoteApprovalForViewer,
  type RemoteAttachment,
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
  /** The accounts it mentions; none when unset. */
  mentions?: ReadonlyArray<ApiMentionJSON> | undefined;
  pollVotes?: RemotePollVotes | undefined;
  /** Favourites, boosts, quotes and replies seen on this instance; remote totals are not kept. */
  interactions?: StatusInteractionCounts | undefined;
  /** Whether the viewer may quote it; no viewer may when unset, as Mastodon answers an anonymous one. */
  quoteApproval?: QuoteApprovalForViewer | undefined;
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
    replies_count: interactions.replies,
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
            remoteMediaJson(attachment, {
              id: `${status.id}-${index}`,
              url: attachment.url,
              preview_url: attachment.url,
              remote_url: attachment.url,
              text_url: attachment.url,
              description: attachment.description.length > 0 ? attachment.description : null,
              blurhash: attachment.blurhash ?? null,
            }),
          ],
    ),
    mentions: [...(extras.mentions ?? [])],
    tags: [...(extras.tags ?? [])],
    emojis: remoteEmojisJson(status.emojis),
    card,
    poll:
      status.poll.kind === "NoPoll"
        ? null
        : remotePollJson(status.id, status.poll, pollVotes, status.emojis),
    quote: null,
    quotes_count: interactions.quotes,
    quote_approval: {
      automatic: status.quotePolicy.automatic,
      manual: status.quotePolicy.manual,
      current_user: extras.quoteApproval ?? "denied",
    },
    // Mastodon 4.7 collections; none are kept here.
    tagged_collections: [],
  };
};

type RemoteMediaFields = Omit<ApiMediaAttachmentJSON, "type" | "meta">;

/**
 * A remote attachment as Mastodon's REST `MediaAttachment`. The file is not
 * downloaded, so its sizes are the ones the note declares: `meta.original`,
 * and for an image `meta.small`, the size Mastodon's `small` style would have.
 * `preview_url` stays the original file.
 */
const remoteMediaJson = (
  attachment: RemoteAttachment,
  fields: RemoteMediaFields,
): ApiMediaAttachmentJSON => {
  const { size } = attachment;
  const focus = attachment.focus ? { focus: attachment.focus } : {};
  const type = remoteMediaType(attachment.mediaType);
  switch (type) {
    case "image":
      return {
        ...fields,
        type,
        meta: {
          ...(size
            ? {
                original: ImageDimensions.meta(size),
                small: ImageDimensions.meta(
                  ImageDimensions.fitWithin(size, ImageDimensions.smallPixels),
                ),
              }
            : {}),
          ...focus,
        },
      };
    case "video":
      return { ...fields, type, meta: { ...(size ? { original: size } : {}), ...focus } };
    case "audio":
      return { ...fields, type, meta: {} };
    case "unknown":
      return { ...fields, type, meta: {} };
  }
};

const remoteMediaType = (mediaType: string): "image" | "video" | "audio" | "unknown" => {
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
