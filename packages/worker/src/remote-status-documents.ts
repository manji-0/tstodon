import {
  type InstanceIdentity,
  type QuoteViewerRelation,
  RemoteQuotePolicy,
  type RemoteStatusValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { presentedAccounts } from "./account-documents";
import { StatusAuthors } from "./account-presentation";
import { parseLocalStatusId } from "./activitypub";
import type { RepositoryError } from "./d1";
import { cardDocument, parseCardJson } from "./link-card";
import { RemoteAccountId } from "./remote-account-id";
import { listRemoteActorModerations } from "./remote-actor-moderation-store";
import { findRemoteActorsByUris, remoteFollowerActorUris } from "./remote-actor-store";
import { acceptedOutboundFollowActorUris } from "./outbound-follow-store";
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
 * How the viewer and each author follow each other, keyed by actor URI; empty
 * for no viewer. A failed read counts as no follow, so it only withholds quoting.
 */
const quoteViewerRelations = async (
  db: D1Database,
  viewerId: string | undefined,
  actorUris: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, QuoteViewerRelation>> => {
  if (viewerId === undefined) {
    return new Map();
  }
  const [following, followers] = await Promise.all([
    acceptedOutboundFollowActorUris(db, viewerId, actorUris),
    remoteFollowerActorUris(db, viewerId, actorUris),
  ]);
  return new Map(
    actorUris.map((actorUri) => [
      actorUri,
      {
        viewerFollowsAuthor: following.isOk() && following.value.has(actorUri),
        authorFollowsViewer: followers.isOk() && followers.value.has(actorUri),
      },
    ]),
  );
};

/**
 * Cached remote statuses as Mastodon statuses rendered for the viewer, in the
 * order given: author, preview card, the viewer's poll votes, local accounts'
 * favourites and boosts with the viewer's own, whether the viewer may quote
 * it, and reply refs. A status with
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
): Promise<Result<Record<string, unknown>[], RepositoryError>> => {
  if (statuses.length === 0) {
    return ok([]);
  }
  const ids = statuses.map((status) => status.id);
  const actorUris = statuses.map((status) => status.actorUri);
  const [cards, actors, moderations, pollVotes, interactions, relations] = await Promise.all([
    listRemoteStatusCards(env.DB, ids),
    findRemoteActorsByUris(env.DB, actorUris),
    listRemoteActorModerations(env.DB, actorUris),
    findRemotePollVotes(env.DB, viewerId, statuses),
    statusInteractionCountsByIds(env.DB, ids, viewerId),
    quoteViewerRelations(env.DB, viewerId, actorUris),
  ]);
  if (actors.isErr()) {
    return err(actors.error);
  }
  const presented = await presentedAccounts(env, identity, [], [...actors.value.values()]);
  if (presented.isErr()) {
    return err(presented.error);
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
      quoteApproval: RemoteQuotePolicy.forViewer(
        status.quotePolicy,
        status.visibility,
        relations.get(status.actorUri),
      ),
    });
    const sensitized = moderations.isOk() && moderations.value.get(status.actorUri)?.sensitized;
    if (sensitized && status.media.length > 0) {
      document.sensitive = true;
    }
    return [document];
  });
  await attachRemoteReplyRefs(env.DB, identity, documents);
  return ok(documents);
};
