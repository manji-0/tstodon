import type { ApRepliesJSON, ApStatusDocumentJSON } from "@tstodon/api/activitypub";
import type { InstanceIdentity, LocalAccount, LocalNote } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { noteDocument } from "./activitypub";
import type { RepositoryError } from "./d1";
import type { CustomEmoji } from "./emoji";
import { loadNoteMentions, loadNotesMentions } from "./mention-resolve";
import { loadNoteMedia, loadNotesMedia } from "./note-attachments";
import { loadNotesReplies, repliedNote } from "./note-replies";
import { findPollsByStatusIds, loadNotePoll } from "./poll-store";
import { loadNoteQuotePolicies, loadNoteQuotePolicy } from "./quote-policy-name";
import { noteQuote, noteQuotes } from "./quote-uri";
import { loadNoteReplies, loadNoteReply } from "./reply-target";

/**
 * A stored local note as it is now, the way its URI serves it: with its
 * media, mentions, parent, poll, quote and quote policy read back. `emojis`
 * is the instance's custom emoji (read once for several notes); `replies`
 * embeds the note's replies collection.
 */
export const loadLocalNoteDocument = async (
  env: Env,
  identity: InstanceIdentity,
  author: LocalAccount,
  note: LocalNote,
  extras: Readonly<{ emojis: ReadonlyArray<CustomEmoji>; replies?: ApRepliesJSON | undefined }>,
): Promise<Result<ApStatusDocumentJSON, RepositoryError>> => {
  const [media, quote, mentions, reply, poll, quotePolicy] = await Promise.all([
    loadNoteMedia(env.DB, identity, note),
    noteQuote(env, identity, note.id),
    loadNoteMentions(env.DB, identity, note.id),
    loadNoteReply(env.DB, identity, note),
    loadNotePoll(env.DB, note.id),
    loadNoteQuotePolicy(env.DB, author, note),
  ]);
  if (media.isErr()) {
    return err(media.error);
  }
  if (quote.isErr()) {
    return err(quote.error);
  }
  return ok(
    noteDocument(identity, author, note, {
      quote: quote.value,
      mentions,
      reply,
      replies: extras.replies,
      poll,
      media: media.value,
      quotePolicy,
      emojis: extras.emojis,
    }),
  );
};

/** A local note with its author, as {@link loadLocalNoteDocuments} reads it. */
export type AuthoredNote = Readonly<{ author: LocalAccount; note: LocalNote }>;

/**
 * {@link loadLocalNoteDocument} for several notes, of one author or several,
 * keyed by note id, each with the first page of its replies collection. The
 * media, mentions, parents, replies, polls, quotes and quote policies of all
 * the notes are read at once, so the statements do not grow with the notes.
 */
export const loadLocalNoteDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  authored: ReadonlyArray<AuthoredNote>,
  emojis: ReadonlyArray<CustomEmoji>,
): Promise<Result<ReadonlyMap<string, ApStatusDocumentJSON>, RepositoryError>> => {
  const notes = authored.map(({ note }) => note);
  const ids = notes.map((note) => note.id);
  const [media, quotes, mentions, parents, replies, polls, quotePolicies] = await Promise.all([
    loadNotesMedia(env.DB, identity, notes),
    noteQuotes(env, identity, ids),
    loadNotesMentions(env.DB, identity, ids),
    loadNoteReplies(env.DB, identity, notes),
    loadNotesReplies(
      env.DB,
      authored.map(({ author, note }) => repliedNote(identity, author, note.id)),
    ),
    findPollsByStatusIds(env.DB, ids, undefined),
    loadNoteQuotePolicies(env.DB, authored),
  ]);
  if (media.isErr()) {
    return err(media.error);
  }
  if (quotes.isErr()) {
    return err(quotes.error);
  }
  if (replies.isErr()) {
    return err(replies.error);
  }
  return ok(
    new Map(
      authored.map(({ author, note }) => [
        note.id,
        noteDocument(identity, author, note, {
          quote: quotes.value.get(note.id),
          mentions: mentions.get(note.id) ?? [],
          reply: parents.get(note.id),
          replies: replies.value.get(note.id),
          poll: polls.isOk() ? polls.value.get(note.id) : undefined,
          media: media.value.get(note.id) ?? { attachments: [], authorSensitized: false },
          quotePolicy: quotePolicies.get(note.id) ?? "nobody",
          emojis,
        }),
      ]),
    ),
  );
};
