import type {
  ApRepliesJSON,
  ApRepliesPageJSON,
  ApRepliesServedPageJSON,
} from "@tstodon/api/activitypub";
import { type InstanceIdentity, type LocalNote, RepliesPage } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { findAccountsByIds } from "./account-store";
import { loadCustomEmojis } from "./custom-emoji-store";
import { type RepositoryError, runD1 } from "./d1";
import {
  listLocalNoteReplies as listLocalNoteRepliesSql,
  listRemoteNoteReplies as listRemoteNoteRepliesSql,
} from "./generated/prisma/sql";
import { loadLocalNoteDocuments } from "./local-note-document";
import { findStatusesByIds } from "./status-store";
import { queryTyped } from "./typed-sql";

/*
 * A local note's `replies` collection, in Mastodon's shape (`NoteSerializer`,
 * `RepliesController`), so another server can read the replies to a note it
 * fetched: the note embeds a first page with a few of the author's own
 * replies, as URIs, and the pages its `next` links list the rest, a local
 * reply embedded as its note and a remote one as its URI.
 */

/** A reply as a page lists it: its id in the page's order, and its URI. */
type ReplyRef = Readonly<{ id: string; uri: string }>;

const LocalReplyRow = z.object({ id: z.string(), username: z.string() });
const RemoteReplyRow = z.object({ id: z.string(), object_uri: z.string() });

/** The note a `replies` collection belongs to. */
export type RepliedNote = Readonly<{
  /** The note's local status id. */
  id: string;
  /** The note's ActivityPub URI. */
  uri: string;
  authorId: string;
  /** The prefix of this instance's actor URIs, ending in `/`. */
  actorUrlPrefix: string;
}>;

/** The URI of a note's `replies` collection. */
export const repliesCollectionUri = (noteUri: string): string => `${noteUri}/replies`;

const pageUri = (noteUri: string, page: RepliesPage): string =>
  `${repliesCollectionUri(noteUri)}${RepliesPage.query(page)}`;

/** Up to `limit` of the replies `page` lists, public and unlisted only. */
const listReplies = async (
  db: D1Database,
  note: RepliedNote,
  page: RepliesPage,
  limit: number,
): Promise<Result<ReplyRef[], RepositoryError>> =>
  runD1(async () => {
    const afterId = page.afterId ?? "";
    if (page.kind === "RemoteReplies") {
      const rows = await queryTyped(
        db,
        listRemoteNoteRepliesSql(note.uri, afterId, limit),
        RemoteReplyRow,
      );
      return rows.map((row) => ({ id: row.id, uri: row.object_uri }));
    }
    const rows = await queryTyped(
      db,
      listLocalNoteRepliesSql(
        note.id,
        note.authorId,
        page.kind === "SelfReplies" ? 1 : 0,
        afterId,
        limit,
      ),
      LocalReplyRow,
    );
    return rows.map((row) => ({
      id: row.id,
      uri: `${note.actorUrlPrefix}${row.username}/statuses/${row.id}`,
    }));
  });

const pageDocument = (
  note: RepliedNote,
  page: RepliesPage,
  replies: ReadonlyArray<ReplyRef>,
  limit: number,
): Omit<ApRepliesPageJSON, "id"> => {
  const next = RepliesPage.next(
    page,
    replies.map((reply) => reply.id),
    limit,
  );
  return {
    type: "CollectionPage",
    ...(next ? { next: pageUri(note.uri, next) } : {}),
    partOf: repliesCollectionUri(note.uri),
    items: replies.map((reply) => reply.uri),
  };
};

/**
 * The `replies` a note document carries: the collection with its first page
 * embedded, holding up to `RepliesPage.EMBEDDED_LIMIT` of the author's own
 * replies. One query.
 */
export const loadNoteReplies = async (
  db: D1Database,
  note: RepliedNote,
): Promise<Result<ApRepliesJSON, RepositoryError>> =>
  (await listReplies(db, note, RepliesPage.first, RepliesPage.EMBEDDED_LIMIT)).map((replies) => ({
    id: repliesCollectionUri(note.uri),
    type: "Collection",
    first: pageDocument(note, RepliesPage.first, replies, RepliesPage.EMBEDDED_LIMIT),
  }));

/** The `replies` of a note that has none yet: what a new note's `Create` carries. */
export const emptyNoteReplies = (noteUri: string): ApRepliesJSON => ({
  id: repliesCollectionUri(noteUri),
  type: "Collection",
  first: {
    type: "CollectionPage",
    next: `${repliesCollectionUri(noteUri)}${RepliesPage.query({ kind: "LocalReplies" })}`,
    partOf: repliesCollectionUri(noteUri),
    items: [],
  },
});

type ServedItem = ApRepliesServedPageJSON["items"][number];

/**
 * The local replies of a page as their notes, in the page's order, as
 * Mastodon's `RepliesController` embeds a local status. A reply that no
 * longer reads back as a local note stays a URI. A fixed number of
 * statements, however many replies and authors.
 */
const embedLocalReplies = async (
  env: Env,
  identity: InstanceIdentity,
  replies: ReadonlyArray<ReplyRef>,
): Promise<Result<ServedItem[], RepositoryError>> => {
  if (replies.length === 0) {
    return ok([]);
  }
  const statuses = await findStatusesByIds(
    env.DB,
    replies.map((reply) => reply.id),
  );
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
      const document = documents.value.get(reply.id);
      if (!document) {
        return reply.uri;
      }
      const { "@context": _context, ...note } = document;
      return note;
    }),
  );
};

/**
 * One served page of a note's `replies`, up to `RepliesPage.LIMIT` replies,
 * the local ones embedded ({@link embedLocalReplies}).
 */
export const loadNoteRepliesPage = async (
  env: Env,
  identity: InstanceIdentity,
  note: RepliedNote,
  page: RepliesPage,
): Promise<Result<ApRepliesServedPageJSON, RepositoryError>> => {
  const replies = await listReplies(env.DB, note, page, RepliesPage.LIMIT);
  if (replies.isErr()) {
    return err(replies.error);
  }
  const items =
    page.kind === "RemoteReplies"
      ? ok(replies.value.map((reply): ServedItem => reply.uri))
      : await embedLocalReplies(env, identity, replies.value);
  if (items.isErr()) {
    return err(items.error);
  }
  return ok({
    id: pageUri(note.uri, page),
    ...pageDocument(note, page, replies.value, RepliesPage.LIMIT),
    items: items.value,
  });
};
