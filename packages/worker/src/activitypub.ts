import { InstanceIdentity, type LocalAccount, type LocalNote } from "@tstodon/domain";
import type { z } from "zod";
import type { ActivityJsonSchema } from "./schemas";
import { mediaAuthUrl, mediaPublicUrl } from "./media-keys";
import type { MediaRow } from "./media-store";

export const actorDocument = (
  identity: InstanceIdentity,
  account: LocalAccount,
): Record<string, unknown> => {
  const id = InstanceIdentity.actorUrl(identity, account.username);
  const doc: Record<string, unknown> = {
    "@context": ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"],
    id,
    type: "Person",
    preferredUsername: account.username,
    name: account.displayName,
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    followers: `${id}/followers`,
    following: `${id}/following`,
    endpoints: {
      sharedInbox: InstanceIdentity.sharedInboxUrl(identity),
    },
    url: id,
    publicKey: {
      id: `${id}#main-key`,
      owner: id,
      publicKeyPem: account.publicKeyPem,
    },
  };
  if (account.avatarObjectKey.kind === "Present") {
    doc.icon = {
      type: "Image",
      url: mediaPublicUrl(identity, account.avatarObjectKey.value),
    };
  }
  if (account.headerObjectKey.kind === "Present") {
    doc.image = {
      type: "Image",
      url: mediaPublicUrl(identity, account.headerObjectKey.value),
    };
  }
  return doc;
};

const usersPrefix = (identity: InstanceIdentity): string => {
  const sample = InstanceIdentity.actorUrl(identity, "_");
  return sample.slice(0, sample.lastIndexOf("/") + 1);
};

export const parseLocalActorUsername = (
  identity: InstanceIdentity,
  value: string,
): string | undefined => {
  const actorPrefix = usersPrefix(identity);
  if (!value.startsWith(actorPrefix)) {
    return undefined;
  }
  const rest = value.slice(actorPrefix.length);
  const username = rest.split("/")[0];
  return username && username.length > 0 ? username : undefined;
};

export const parseLocalStatusId = (
  identity: InstanceIdentity,
  value: string,
): string | undefined => {
  const actorPrefix = usersPrefix(identity);
  if (!value.startsWith(actorPrefix)) {
    return undefined;
  }
  const match = value.match(/\/statuses\/([^/]+)\/?$/);
  return match?.[1];
};

export const activityPayloadFromJson = (
  raw: z.infer<typeof ActivityJsonSchema>,
): Record<string, unknown> => {
  const object = raw.object;
  const objectId = typeof object === "string" ? object : object.id;
  return {
    kind: raw.type,
    id: raw.id,
    actor: raw.actor,
    object: objectId,
  };
};

const noteAttachment = (
  identity: InstanceIdentity,
  row: MediaRow,
): Record<string, unknown> => {
  const privateAttachment = row.is_private === 1;
  const url = privateAttachment
    ? mediaAuthUrl(identity, row.id)
    : mediaPublicUrl(identity, row.object_key);
  const mediaType = row.content_type.length > 0 ? row.content_type : "application/octet-stream";
  const attachment: Record<string, unknown> = {
    type: mediaType.startsWith("video/") ? "Document" : "Image",
    mediaType,
    url,
    name: row.description.length > 0 ? row.description : null,
  };
  if (row.blurhash) {
    attachment.blurhash = row.blurhash;
  }
  return attachment;
};

export const noteDocument = (
  identity: InstanceIdentity,
  account: LocalAccount,
  note: LocalNote,
  media: ReadonlyArray<MediaRow> = [],
): Record<string, unknown> => {
  const actor = InstanceIdentity.actorUrl(identity, account.username);
  const id = `${actor}/statuses/${note.id}`;
  const to =
    note.visibility.kind === "Public"
      ? ["https://www.w3.org/ns/activitystreams#Public"]
      : note.visibility.kind === "Unlisted"
        ? [`${actor}/followers`]
        : note.visibility.kind === "FollowersOnly"
          ? [`${actor}/followers`]
          : [actor];
  const cc =
    note.visibility.kind === "Public"
      ? [`${actor}/followers`]
      : note.visibility.kind === "Unlisted"
        ? ["https://www.w3.org/ns/activitystreams#Public"]
        : [];
  const byId = new Map(media.map((row) => [row.id, row]));
  const attachments = note.mediaIds
    .map((mediaId) => byId.get(mediaId))
    .filter((row): row is MediaRow => row != null)
    .map((row) => noteAttachment(identity, row));
  const doc: Record<string, unknown> = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id,
    type: "Note",
    attributedTo: actor,
    content: note.contentHtml,
    published: note.createdAt,
    to,
    cc,
    sensitive: note.sensitive,
    summary: note.spoilerText.length > 0 ? note.spoilerText : null,
  };
  if (attachments.length === 1) {
    doc.attachment = attachments[0];
  } else if (attachments.length > 1) {
    doc.attachment = attachments;
  }
  return doc;
};
