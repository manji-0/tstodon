import type { InstanceIdentity, RemoteStatusValue } from "@tstodon/domain";
import { presentedAccounts } from "./account-documents";
import { StatusAuthors } from "./account-presentation";
import { parseLocalStatusId } from "./activitypub";
import { cardDocument, parseCardJson } from "./link-card";
import { RemoteAccountId } from "./remote-account-id";
import { listRemoteActorModerations } from "./remote-actor-moderation-store";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { findRemotePollVotes } from "./remote-poll-vote-store";
import { findRemoteStatusReplyTargets } from "./remote-reply-store";
import { mastodonRemoteStatus } from "./remote-status-document";
import { findRemoteStatusRefsByObjectUris } from "./remote-status-store";
import { listRemoteStatusCards } from "./status-card-store";
import { statusInteractionCountsByIds } from "./status-interaction-store";
import { findStatusesByIds } from "./status-store";

/**
 * Fill `in_reply_to_id` and `in_reply_to_account_id` on remote status
 * documents from the `inReplyTo` stored with them: a local parent by its id
 * and author, a cached remote one by its id and `r_…` author. A parent that
 * is not stored here stays null, as Mastodon renders an unfetched parent.
 * Other documents in the list are left alone.
 */
export const attachRemoteReplyRefs = async (
  db: D1Database,
  identity: InstanceIdentity,
  documents: ReadonlyArray<Record<string, unknown>>,
): Promise<void> => {
  const ids = documents.flatMap((document) =>
    typeof document.id === "string" && document.in_reply_to_id == null ? [document.id] : [],
  );
  const targets = await findRemoteStatusReplyTargets(db, ids);
  if (targets.isErr() || targets.value.size === 0) {
    return;
  }
  const localParents = new Map<string, string>();
  const remoteParents: string[] = [];
  for (const target of targets.value.values()) {
    const uri = target.inReplyToUri;
    if (!uri) {
      continue;
    }
    const localId = parseLocalStatusId(identity, uri);
    if (localId) {
      localParents.set(uri, localId);
    } else {
      remoteParents.push(uri);
    }
  }
  const [locals, remotes] = await Promise.all([
    findStatusesByIds(db, [...localParents.values()]),
    findRemoteStatusRefsByObjectUris(db, remoteParents),
  ]);
  for (const document of documents) {
    const target = typeof document.id === "string" ? targets.value.get(document.id) : undefined;
    const uri = target?.inReplyToUri;
    if (!uri) {
      continue;
    }
    const localId = localParents.get(uri);
    if (localId) {
      const parent = locals.isOk() ? locals.value.get(localId) : undefined;
      if (parent) {
        document.in_reply_to_id = parent.id;
        document.in_reply_to_account_id = parent.accountId;
      }
      continue;
    }
    const parent = remotes.isOk() ? remotes.value.get(uri) : undefined;
    if (parent) {
      document.in_reply_to_id = parent.id;
      document.in_reply_to_account_id = RemoteAccountId.encode(parent.actorUri);
    }
  }
};

/**
 * Cached remote statuses as Mastodon statuses rendered for the viewer, in the
 * order given: author, preview card, the viewer's poll votes, local accounts'
 * favourites and boosts with the viewer's own, and reply refs. A status with
 * media is marked sensitive when an admin marked its author's media sensitive,
 * as Mastodon does for a remote account. A status whose author is not cached,
 * or whose author's presentation `authors` refuses, is left out; an author
 * that is not shown renders stripped. No visibility check is made here.
 */
export const mastodonRemoteStatuses = async (
  env: Env,
  identity: InstanceIdentity,
  statuses: ReadonlyArray<RemoteStatusValue>,
  viewerId: string | undefined,
  authors: StatusAuthors = StatusAuthors.available,
): Promise<Record<string, unknown>[]> => {
  if (statuses.length === 0) {
    return [];
  }
  const ids = statuses.map((status) => status.id);
  const actorUris = statuses.map((status) => status.actorUri);
  const [cards, actors, moderations, pollVotes, interactions] = await Promise.all([
    listRemoteStatusCards(env.DB, ids),
    findRemoteActorsByUris(env.DB, actorUris),
    listRemoteActorModerations(env.DB, actorUris),
    findRemotePollVotes(env.DB, viewerId, statuses),
    statusInteractionCountsByIds(env.DB, ids, viewerId),
  ]);
  const presented = actors.isOk()
    ? await presentedAccounts(env, identity, [], [...actors.value.values()])
    : undefined;
  // A storage error leaves every status out rather than show an author unpresented.
  if (!presented?.isOk()) {
    return [];
  }
  const documents = statuses.flatMap((status) => {
    const author = presented.value.get(RemoteAccountId.encode(status.actorUri));
    if (!author || !authors(author.presentation)) {
      return [];
    }
    const rawCard = cards.isOk() ? cards.value.get(status.id) : undefined;
    const card = rawCard ? parseCardJson(rawCard) : undefined;
    const document = mastodonRemoteStatus(status, author.document, {
      card: card ? cardDocument(card) : null,
      pollVotes: pollVotes.get(status.id),
      interactions: interactions.isOk() ? interactions.value.get(status.id) : undefined,
    });
    const sensitized = moderations.isOk() && moderations.value.get(status.actorUri)?.sensitized;
    if (sensitized && status.media.length > 0) {
      document.sensitive = true;
    }
    return [document];
  });
  await attachRemoteReplyRefs(env.DB, identity, documents);
  return documents;
};
