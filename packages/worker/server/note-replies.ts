import type { ApRepliesJSON, ApRepliesPageJSON } from "@tstodon/api/activitypub";
import { InstanceIdentity, type LocalAccount, RepliesPage } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { type RepositoryError, runD1 } from "./d1";
import {
  listOtherNoteReplies as listOtherNoteRepliesSql,
  listSelfNoteRepliesJson,
} from "./generated/prisma/sql";
import { queryTyped } from "./typed-sql";

/*
 * A local note's `replies` collection, in Mastodon's shape (`NoteSerializer`,
 * `RepliesController`), so another server can read the replies to a note it
 * fetched: the note embeds a first page with a few of the author's own
 * replies, as URIs, and the pages its `next` links list the rest of them,
 * then every other account's, local or cached from another server, in one id
 * order.
 */

/** A reply as a page lists it: its id in the page's order, and its URI. */
export type ReplyRef = Readonly<
  { kind: "LocalReply"; id: string; uri: string } | { kind: "RemoteReply"; id: string; uri: string }
>;

const SelfReplyRow = z.object({ note_id: z.string(), id: z.string() });
const OtherReplyRow = z.union([
  z.object({ id: z.string(), username: z.string(), object_uri: z.null() }),
  z.object({ id: z.string(), username: z.null(), object_uri: z.string() }),
]);

/** The note a `replies` collection belongs to. */
export type RepliedNote = Readonly<{
  /** The note's local status id. */
  id: string;
  /** The note's ActivityPub URI. */
  uri: string;
  authorId: string;
  authorUsername: string;
  /** The prefix of this instance's actor URIs, ending in `/`. */
  actorUrlPrefix: string;
}>;

/** The note `noteId` of the local account `author`, as its `replies` collection names it. */
export const repliedNote = (
  identity: InstanceIdentity,
  author: LocalAccount,
  noteId: string,
): RepliedNote => {
  const actorUri = InstanceIdentity.actorUrl(identity, author.username);
  return {
    id: noteId,
    uri: `${actorUri}/statuses/${noteId}`,
    authorId: author.id,
    authorUsername: author.username,
    actorUrlPrefix: actorUri.slice(0, actorUri.length - author.username.length),
  };
};

/** The URI of a note's `replies` collection. */
export const repliesCollectionUri = (noteUri: string): string => `${noteUri}/replies`;

const repliesPageUri = (noteUri: string, page: RepliesPage): string =>
  `${repliesCollectionUri(noteUri)}${RepliesPage.query(page)}`;

const localReplyUri = (note: RepliedNote, username: string, id: string): string =>
  `${note.actorUrlPrefix}${username}/statuses/${id}`;

/**
 * Up to `limit` of each note's author's own public and unlisted replies after
 * `afterId` ('' for the first), keyed by note id, every note keyed. One query.
 */
const listSelfReplies = async (
  db: D1Database,
  notes: ReadonlyArray<RepliedNote>,
  afterId: string,
  limit: number,
): Promise<Result<ReadonlyMap<string, ReplyRef[]>, RepositoryError>> =>
  runD1(async () => {
    const byId = new Map(notes.map((note): [string, ReplyRef[]] => [note.id, []]));
    if (notes.length === 0) {
      return byId;
    }
    const rows = await queryTyped(
      db,
      listSelfNoteRepliesJson(JSON.stringify([...byId.keys()]), afterId, limit),
      SelfReplyRow,
    );
    const notesById = new Map(notes.map((note) => [note.id, note]));
    for (const row of rows) {
      const note = notesById.get(row.note_id);
      if (note) {
        byId.get(note.id)?.push({
          kind: "LocalReply",
          id: row.id,
          uri: localReplyUri(note, note.authorUsername, row.id),
        });
      }
    }
    return byId;
  });

/** Up to `limit` of the replies `page` lists, public and unlisted only, in id order. */
export const listRepliesPage = async (
  db: D1Database,
  note: RepliedNote,
  page: RepliesPage,
  limit: number,
): Promise<Result<ReplyRef[], RepositoryError>> => {
  const afterId = page.afterId ?? "";
  if (page.kind === "SelfReplies") {
    return (await listSelfReplies(db, [note], afterId, limit)).map(
      (replies) => replies.get(note.id) ?? [],
    );
  }
  return runD1(async () =>
    (
      await queryTyped(
        db,
        listOtherNoteRepliesSql(note.id, note.authorId, note.uri, afterId, limit),
        OtherReplyRow,
      )
    ).map((row): ReplyRef =>
      row.username === null
        ? { kind: "RemoteReply", id: row.id, uri: row.object_uri }
        : { kind: "LocalReply", id: row.id, uri: localReplyUri(note, row.username, row.id) },
    ),
  );
};

/** A page of `note`'s replies without its id, `next` linking the page after it. */
export const repliesPageDocument = (
  note: RepliedNote,
  replies: ReadonlyArray<ReplyRef>,
  next: RepliesPage | undefined,
): Omit<ApRepliesPageJSON, "id"> => ({
  type: "CollectionPage",
  ...(next ? { next: repliesPageUri(note.uri, next) } : {}),
  partOf: repliesCollectionUri(note.uri),
  items: replies.map((reply) => reply.uri),
});

/**
 * The `replies` each note document carries, keyed by note id: the collection
 * with its first page embedded, up to `RepliesPage.EMBEDDED_LIMIT` of the
 * author's own replies, as Mastodon's `NoteSerializer#replies`. One query,
 * however many notes.
 */
export const loadNotesReplies = async (
  db: D1Database,
  notes: ReadonlyArray<RepliedNote>,
): Promise<Result<ReadonlyMap<string, ApRepliesJSON>, RepositoryError>> =>
  (await listSelfReplies(db, notes, "", RepliesPage.EMBEDDED_LIMIT)).map(
    (byId) =>
      new Map(
        notes.map((note): [string, ApRepliesJSON] => {
          const replies = byId.get(note.id) ?? [];
          return [
            note.id,
            {
              id: repliesCollectionUri(note.uri),
              type: "Collection",
              first: repliesPageDocument(
                note,
                replies,
                RepliesPage.embeddedNext(replies.map((reply) => reply.id)),
              ),
            },
          ];
        }),
      ),
  );

/** The `replies` of a note that has none yet: what a new note's `Create` carries. */
export const emptyNoteReplies = (noteUri: string): ApRepliesJSON => ({
  id: repliesCollectionUri(noteUri),
  type: "Collection",
  first: {
    type: "CollectionPage",
    next: repliesPageUri(noteUri, RepliesPage.embeddedNext([])),
    partOf: repliesCollectionUri(noteUri),
    items: [],
  },
});
