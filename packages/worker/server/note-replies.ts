import type {
  ApRepliesJSON,
  ApRepliesPageDocumentJSON,
  ApRepliesPageJSON,
} from "@tstodon/api/activitypub";
import { RepliesPage } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { type RepositoryError, runD1 } from "./d1";
import {
  listLocalNoteReplies as listLocalNoteRepliesSql,
  listRemoteNoteReplies as listRemoteNoteRepliesSql,
} from "./generated/prisma/sql";
import { queryTyped } from "./typed-sql";

/*
 * A local note's `replies` collection, in Mastodon's shape (`NoteSerializer`,
 * `RepliesController`), so another server can read the replies to a note it
 * fetched: the note embeds a first page with a few of the author's own
 * replies, and the pages its `next` links list the rest, as URIs.
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

/** One served page of a note's `replies`, up to `RepliesPage.LIMIT` replies. One query. */
export const loadNoteRepliesPage = async (
  db: D1Database,
  note: RepliedNote,
  page: RepliesPage,
): Promise<Result<Omit<ApRepliesPageDocumentJSON, "@context">, RepositoryError>> =>
  (await listReplies(db, note, page, RepliesPage.LIMIT)).map((replies) => ({
    id: pageUri(note.uri, page),
    ...pageDocument(note, page, replies, RepliesPage.LIMIT),
  }));
