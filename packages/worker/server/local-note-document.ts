import type { ApRepliesJSON, ApStatusDocumentJSON } from "@tstodon/api/activitypub";
import type { InstanceIdentity, LocalAccount, LocalNote } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { noteDocument } from "./activitypub";
import type { RepositoryError } from "./d1";
import type { CustomEmoji } from "./emoji";
import { loadNoteMentions } from "./mention-resolve";
import { loadNoteMedia } from "./note-attachments";
import { loadNotePoll } from "./poll-store";
import { loadNoteQuotePolicy } from "./quote-policy-name";
import { noteQuote } from "./quote-uri";
import { loadNoteReply } from "./reply-target";

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
