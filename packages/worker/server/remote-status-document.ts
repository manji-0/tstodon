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
  Visibility,
  type RemoteStatus as RemoteStatusValue,
} from "@tstodon/domain";
import { remotePollJson, remotePollTexts } from "./poll-document";
import { NO_REMOTE_POLL_VOTES, type RemotePollVotes } from "./remote-poll-vote-store";
import type { EmojisOf } from "./remote-emoji-catalog";
import { statusEmojiTexts } from "./emoji";
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

/**
 * A remote status with `account`, its author as the reader is shown it, and
 * the emoji of the author's domain its texts write (`emojis`), as Mastodon's
 * `Status#emojis` and `Poll#emojis`.
 */
export const mastodonRemoteStatus = (
  status: RemoteStatusValue,
  account: ApiAccountJSON,
  emojis: EmojisOf,
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
    visibility: Visibility.toRest(status.visibility),
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
        : [remoteMediaJson(attachment, `${status.id}-${index}`)],
    ),
    mentions: [...(extras.mentions ?? [])],
    tags: [...(extras.tags ?? [])],
    emojis: emojis(remoteStatusEmojiTexts(status)),
    card,
    poll:
      status.poll.kind === "NoPoll"
        ? null
        : remotePollJson(status.id, status.poll, pollVotes, emojis),
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

/** The texts of a remote status `Status#emojis` scans: the spoiler, the text and the poll's options. */
export const remoteStatusEmojiTexts = (
  status: Pick<RemoteStatusValue, "spoilerText" | "contentHtml" | "poll">,
): ReadonlyArray<string> =>
  statusEmojiTexts(
    { spoilerText: status.spoilerText, text: status.contentHtml },
    remotePollTexts(status.poll),
  );

type RemoteMediaType = "image" | "video" | "audio";

const typed = (type: RemoteMediaType, mimes: ReadonlyArray<string>) =>
  mimes.map((mime) => [mime, type] as const);

/**
 * The media types Mastodon downloads a remote file of, and the type it gives
 * the attachment (`MediaAttachment::IMAGE_MIME_TYPES`, `VIDEO_MIME_TYPES` and
 * `AUDIO_MIME_TYPES`, as `set_type_and_extension` reads them: the audio list
 * holds `video/x-ms-asf`). Mastodon does not download a file of another type
 * (`unsupported_media_type?`), and that attachment stays `unknown`.
 */
const MASTODON_MEDIA_TYPES: ReadonlyMap<string, RemoteMediaType> = new Map([
  ...typed("image", [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/heic",
    "image/heif",
    "image/webp",
    "image/avif",
  ]),
  ...typed("video", ["video/webm", "video/mp4", "video/quicktime", "video/ogg"]),
  ...typed("audio", [
    "audio/wave",
    "audio/wav",
    "audio/x-wav",
    "audio/x-pn-wave",
    "audio/vnd.wave",
    "audio/ogg",
    "audio/vorbis",
    "audio/mpeg",
    "audio/mp3",
    "audio/webm",
    "audio/flac",
    "audio/aac",
    "audio/m4a",
    "audio/x-m4a",
    "audio/mp4",
    "audio/3gpp",
    "video/x-ms-asf",
  ]),
]);

/**
 * A remote attachment as Mastodon's REST `MediaAttachment` shows it once
 * downloaded, without the download. `url` is the remote file. `preview_url`
 * is the thumbnail the attachment's `icon` names (`preview_remote_url`), else
 * an image's own file, else none: Mastodon's would be a frame of the video or
 * the audio's cover art, read from the file. The sizes are the ones the note
 * declares: `meta.original`, and for an image `meta.small`, the size
 * Mastodon's `small` style would have. A GIF stays an `image` and a video
 * without sound a `video`; Mastodon makes both a `gifv` from the file.
 */
const remoteMediaJson = (attachment: RemoteAttachment, id: string): ApiMediaAttachmentJSON => {
  const { size } = attachment;
  const focus = attachment.focus ? { focus: attachment.focus } : {};
  const type = MASTODON_MEDIA_TYPES.get(attachment.mediaType.toLowerCase()) ?? "unknown";
  const fields = {
    id,
    url: attachment.url,
    preview_url:
      attachment.thumbnailUrl ?? (type === "image" || type === "unknown" ? attachment.url : null),
    remote_url: attachment.url,
    preview_remote_url: attachment.thumbnailUrl ?? null,
    // Mastodon gives a text URL to a local attachment only.
    text_url: null,
    description: attachment.description.length > 0 ? attachment.description : null,
    blurhash: attachment.blurhash ?? null,
  };
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
