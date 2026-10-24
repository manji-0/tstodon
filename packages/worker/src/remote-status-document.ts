import {
  type InstanceIdentity,
  type RemoteActor,
  type RemoteStatus as RemoteStatusValue,
  Visibility,
} from "@tstodon/domain";
import { mastodonRemoteAccount } from "./account-documents";
import { httpUrl, sanitizeRemoteHtml } from "./sanitize-html";

export const mastodonRemoteStatus = (
  identity: InstanceIdentity,
  status: RemoteStatusValue,
  actor: RemoteActor,
  card: Record<string, unknown> | null = null,
): Record<string, unknown> => {
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
    reblogs_count: 0,
    favourites_count: 0,
    edited_at: null,
    favourited: false,
    reblogged: false,
    muted: false,
    bookmarked: false,
    content: sanitizeRemoteHtml(status.contentHtml),
    reblog: null,
    account: mastodonRemoteAccount(identity, actor),
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
    tags: [],
    emojis: [],
    card,
    poll: null,
    quote: null,
    quotes_count: 0,
    quote_approval: { automatic: [], manual: [], current_user: "unknown" },
    // Mastodon 4.7 collections; none are kept here.
    tagged_collections: [],
  };
};

const remoteMediaType = (mediaType: string): string => {
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

export const remoteStatusVisible = (status: RemoteStatusValue): boolean =>
  status.visibility.kind === "Public" || status.visibility.kind === "Unlisted";
