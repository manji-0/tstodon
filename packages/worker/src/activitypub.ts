import { InstanceIdentity, type LocalAccount, type LocalNote } from "@tstodon/domain";

export const actorDocument = (
  identity: InstanceIdentity,
  account: LocalAccount,
): Record<string, unknown> => {
  const id = InstanceIdentity.actorUrl(identity, account.username);
  return {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
    ],
    id,
    type: "Person",
    preferredUsername: account.username,
    name: account.displayName,
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    followers: `${id}/followers`,
    following: `${id}/following`,
    url: id,
    publicKey: {
      id: `${id}#main-key`,
      owner: id,
      publicKeyPem: account.publicKeyPem,
    },
  };
};

export const parseLocalActorUsername = (
  identity: InstanceIdentity,
  value: string,
): string | undefined => {
  const actorPrefix = `https://${identity.domain}/users/`;
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
  const actorPrefix = `https://${identity.domain}/users/`;
  if (!value.startsWith(actorPrefix)) {
    return undefined;
  }
  const match = value.match(/\/statuses\/([^/]+)\/?$/);
  return match?.[1];
};

export const activityPayloadFromJson = (
  raw: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const type = raw.type;
  const id = raw.id;
  const actor = raw.actor;
  if (typeof type !== "string" || typeof id !== "string" || typeof actor !== "string") {
    return undefined;
  }
  const object = raw.object;
  const objectId =
    typeof object === "string"
      ? object
      : object && typeof object === "object" && "id" in object && typeof object.id === "string"
        ? object.id
        : undefined;
  if (!objectId) {
    return undefined;
  }
  return {
    kind: type,
    id,
    actor,
    object: objectId,
  };
};

export const noteDocument = (
  identity: InstanceIdentity,
  account: LocalAccount,
  note: LocalNote,
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
  return {
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
};
