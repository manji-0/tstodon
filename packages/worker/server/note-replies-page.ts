import type { ApRepliesServedPageJSON } from "@tstodon/api/activitypub";
import {
  type InstanceIdentity,
  type LocalNote,
  RepliesPage,
  type RepliesPageQuery,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountsByIds } from "./account-store";
import { loadCustomEmojis } from "./custom-emoji-store";
import type { RepositoryError } from "./d1";
import { loadLocalNoteDocuments } from "./local-note-document";
import {
  listRepliesPage,
  type RepliedNote,
  type ReplyRef,
  repliesCollectionUri,
  repliesPageDocument,
} from "./note-replies";
import { findStatusesByIds } from "./status-store";

type ServedItem = ApRepliesServedPageJSON["items"][number];

/**
 * The replies of a page in the page's order, a local one as its note (with
 * the first page of its own replies) and a remote one as its URI, as
 * Mastodon's `RepliesController` serves them. A local reply that no longer
 * reads back as a local note stays a URI. A fixed number of statements,
 * however many replies and authors.
 */
const servedItems = async (
  env: Env,
  identity: InstanceIdentity,
  replies: ReadonlyArray<ReplyRef>,
): Promise<Result<ServedItem[], RepositoryError>> => {
  const localIds = replies.flatMap((reply) => (reply.kind === "LocalReply" ? [reply.id] : []));
  if (localIds.length === 0) {
    return ok(replies.map((reply) => reply.uri));
  }
  const statuses = await findStatusesByIds(env.DB, localIds);
  if (statuses.isErr()) {
    return err(statuses.error);
  }
  const notes = [...statuses.value.values()].flatMap((status): LocalNote[] =>
    status.kind === "LocalNote" ? [status] : [],
  );
  const authors = await findAccountsByIds(
    env.DB,
    notes.map((note) => note.accountId),
  );
  if (authors.isErr()) {
    return err(authors.error);
  }
  const documents = await loadLocalNoteDocuments(
    env,
    identity,
    notes.flatMap((note) => {
      const author = authors.value.get(note.accountId);
      return author ? [{ author, note }] : [];
    }),
    await loadCustomEmojis(env, identity.mediaPublicBaseUrl),
  );
  if (documents.isErr()) {
    return err(documents.error);
  }
  return ok(
    replies.map((reply): ServedItem => {
      const document = reply.kind === "LocalReply" ? documents.value.get(reply.id) : undefined;
      if (!document) {
        return reply.uri;
      }
      const { "@context": _context, ...note } = document;
      return note;
    }),
  );
};

/**
 * The served page of a note's `replies` that `query` asks for, up to
 * `RepliesPage.LIMIT` replies ({@link servedItems}), its `id` echoing the query.
 */
export const loadNoteRepliesPage = async (
  env: Env,
  identity: InstanceIdentity,
  note: RepliedNote,
  query: RepliesPageQuery,
): Promise<Result<ApRepliesServedPageJSON, RepositoryError>> => {
  const page = RepliesPage.fromQuery(query);
  const replies = await listRepliesPage(env.DB, note, page, RepliesPage.LIMIT);
  if (replies.isErr()) {
    return err(replies.error);
  }
  const items = await servedItems(env, identity, replies.value);
  if (items.isErr()) {
    return err(items.error);
  }
  const next = RepliesPage.next(
    page,
    replies.value.map((reply) => reply.id),
    RepliesPage.LIMIT,
  );
  return ok({
    id: `${repliesCollectionUri(note.uri)}${RepliesPage.askedQuery(query)}`,
    ...repliesPageDocument(note, replies.value, next),
    items: items.value,
  });
};
