import { InstanceIdentity, type LocalAccount, type LocalNote } from "@tstodon/domain";
import type { z } from "zod";
import type { ActivityJsonSchema } from "./schemas";

export const actorDocument = (
  identity: InstanceIdentity,
  account: LocalAccount,
): Record<string, unknown> => {
  const id = InstanceIdentity.actorUrl(identity, account.username);
  return {
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

/** An account a note mentions, as its `Mention` tag names it. */
export type NoteMention = Readonly<{ href: string; name: string }>;

export const noteDocument = (
  identity: InstanceIdentity,
  account: LocalAccount,
  note: LocalNote,
  extras: Readonly<{
    quoteUri?: string | undefined;
    mentions?: ReadonlyArray<NoteMention>;
    /** The parent's URI, and a remote parent author to address alongside the mentions. */
    reply?: Readonly<{ inReplyTo: string; addressAuthor: string | undefined }> | undefined;
  }> = {},
): Record<string, unknown> => {
  const { quoteUri, mentions = [], reply } = extras;
  const actor = InstanceIdentity.actorUrl(identity, account.username);
  const id = `${actor}/statuses/${note.id}`;
  const followers = `${actor}/followers`;
  const mentioned = [
    ...new Set([
      ...mentions.map((mention) => mention.href),
      ...(reply?.addressAuthor ? [reply.addressAuthor] : []),
    ]),
  ];
  // Mastodon's addressing: mentioned accounts are `cc`, except that a direct
  // note is addressed `to` them alone.
  const to =
    note.visibility.kind === "Public"
      ? ["https://www.w3.org/ns/activitystreams#Public"]
      : note.visibility.kind === "Direct"
        ? mentioned
        : [followers];
  const cc =
    note.visibility.kind === "Public"
      ? [followers, ...mentioned]
      : note.visibility.kind === "Unlisted"
        ? ["https://www.w3.org/ns/activitystreams#Public", ...mentioned]
        : note.visibility.kind === "FollowersOnly"
          ? mentioned
          : [];
  const quotes = quoteUri !== undefined && quoteUri.length > 0;
  return {
    // FEP-044f names the `quote` property for a quote post.
    "@context": quotes
      ? [
          "https://www.w3.org/ns/activitystreams",
          {
            quote: { "@id": "https://w3id.org/fep/044f#quote", "@type": "@id" },
            quote_uri: { "@id": "https://w3id.org/fep/044f#quote", "@type": "@id" },
            _misskey_quote: { "@id": "https://w3id.org/fep/044f#quote", "@type": "@id" },
          },
        ]
      : "https://www.w3.org/ns/activitystreams",
    ...(quotes ? { quote: quoteUri, quote_uri: quoteUri, _misskey_quote: quoteUri } : {}),
    id,
    type: "Note",
    attributedTo: actor,
    content: note.contentHtml,
    published: note.createdAt,
    to,
    cc,
    sensitive: note.sensitive,
    summary: note.spoilerText.length > 0 ? note.spoilerText : null,
    inReplyTo: reply?.inReplyTo ?? null,
    tag: mentions.map((mention) => ({ type: "Mention", href: mention.href, name: mention.name })),
  };
};
