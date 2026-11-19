import type { ApRepliesJSON, ApStatusDocumentJSON } from "@tstodon/api/activitypub";
import type { InstanceIdentity, LocalAccount, LocalNote } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { noteDocument } from "./activitypub";
import type { RepositoryError } from "./d1";
import type { CustomEmoji } from "./emoji";
import { loadNoteMentions, loadNotesMentions } from "./mention-resolve";
import { loadNoteMedia, loadNotesMedia } from "./note-attachments";
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

/**
 * {@link loadLocalNoteDocument} for several notes of `author`, keyed by note
 * id, without their replies collections. The media, mentions, parents,
 * polls, quotes and quote policies of all the notes are read at once, so
 * the statements do not grow with the notes.
 */
export const loadLocalNoteDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  author: LocalAccount,
  notes: ReadonlyArray<LocalNote>,
  emojis: ReadonlyArray<CustomEmoji>,
): Promise<Result<ReadonlyMap<string, ApStatusDocumentJSON>, RepositoryError>> => {
  const ids = notes.map((note) => note.id);
  const [media, quotes, mentions, replies, polls, quotePolicies] = await Promise.all([
    loadNotesMedia(env.DB, identity, notes),
    noteQuotes(env, identity, ids),
    loadNotesMentions(env.DB, identity, ids),
    loadNoteReplies(env.DB, identity, notes),
    findPollsByStatusIds(env.DB, ids, undefined),
    loadNoteQuotePolicies(env.DB, author, notes),
  ]);
  if (media.isErr()) {
    return err(media.error);
  }
  if (quotes.isErr()) {
    return err(quotes.error);
  }
  return ok(
    new Map(
      notes.map((note) => [
        note.id,
        noteDocument(identity, author, note, {
          quote: quotes.value.get(note.id),
          mentions: mentions.get(note.id) ?? [],
          reply: replies.get(note.id),
          replies: undefined,
          poll: polls.isOk() ? polls.value.get(note.id) : undefined,
          media: media.value.get(note.id) ?? { attachments: [], authorSensitized: false },
          quotePolicy: quotePolicies.get(note.id) ?? "nobody",
          emojis,
        }),
      ]),
    ),
  );
};
