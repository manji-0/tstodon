import type { ApActivityDocumentOf, ApStatusDocumentJSON } from "@tstodon/api/activitypub";
import { InstanceIdentity, type LocalAccount, type LocalNote } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { type NoteQuote, noteDocument, quoteRequestActivity } from "./activitypub";
import { loadCustomEmojis } from "./custom-emoji-store";
import { enqueueTargetedActivity } from "./delivery";
import { loadNoteMentions } from "./mention-resolve";
import { loadNoteMedia } from "./note-attachments";
import { loadNotesReplies, repliedNote } from "./note-replies";
import { loadNotePoll } from "./poll-store";
import { loadNoteQuotePolicy } from "./quote-policy-name";
import { noteQuote } from "./quote-uri";
import { loadNoteReply } from "./reply-target";
import { loadNotesTaggedCollections } from "./tagged-collection-documents";

/** A note's object as its `Create` or `Update` carries it, and the status it quotes. */
export type NoteObject = Readonly<{
  object: ApStatusDocumentJSON;
  quote: NoteQuote | undefined;
}>;

/**
 * Which part of a note did not read back. Its `Create` or `Update` is not
 * sent without it: a receiver replaces a note's attachments and quote with
 * those an `Update` carries, so one without them deletes them remotely.
 */
export type NoteObjectUnreadable = Readonly<{
  kind: "NoteObjectUnreadable";
  cause: "media" | "quote" | "replies" | "collections";
}>;

/**
 * The note's ActivityPub object for its `activity`, read from what is stored
 * about it. An `Update` carries the first page of the note's `replies` as it
 * is now, as Mastodon's `UpdateNoteSerializer`; a `Create` carries it empty,
 * a new note having no replies yet.
 */
export const readNoteObject = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  note: LocalNote,
  activity: "Create" | "Update",
): Promise<Result<NoteObject, NoteObjectUnreadable>> => {
  const media = await loadNoteMedia(env.DB, identity, note);
  if (media.isErr()) {
    return err({ kind: "NoteObjectUnreadable", cause: "media" });
  }
  const quote = await noteQuote(env, identity, note.id);
  if (quote.isErr()) {
    return err({ kind: "NoteObjectUnreadable", cause: "quote" });
  }
  const replies =
    activity === "Update"
      ? await loadNotesReplies(env.DB, [repliedNote(identity, account, note.id)])
      : ok(undefined);
  if (replies.isErr()) {
    return err({ kind: "NoteObjectUnreadable", cause: "replies" });
  }
  const collections = await loadNotesTaggedCollections(env.DB, identity, [note.id]);
  if (collections.isErr()) {
    return err({ kind: "NoteObjectUnreadable", cause: "collections" });
  }
  return ok({
    quote: quote.value,
    object: noteDocument(identity, account, note, {
      quote: quote.value,
      mentions: await loadNoteMentions(env.DB, identity, note.id),
      reply: await loadNoteReply(env.DB, identity, note),
      replies: replies.value?.get(note.id),
      poll: await loadNotePoll(env.DB, note.id),
      media: media.value,
      quotePolicy: await loadNoteQuotePolicy(env.DB, account, note),
      emojis: await loadCustomEmojis(env, identity.mediaPublicBaseUrl),
      taggedCollections: collections.value.get(note.id) ?? [],
    }),
  });
};

/** Where a quote's `QuoteRequest` goes: the id the quote keeps to match the answer, and the quoted author's inbox. */
export type QuoteRequestTarget = Readonly<{ uri: string; inboxUri: string }>;

/** The `QuoteRequest` that asks the quoted author to approve the note's quote. */
export const noteQuoteRequest = (
  identity: InstanceIdentity,
  account: LocalAccount,
  federated: NoteObject & Readonly<{ quote: NoteQuote }>,
  requestUri: string,
): ApActivityDocumentOf<"QuoteRequest"> =>
  quoteRequestActivity(
    requestUri,
    InstanceIdentity.actorUrl(identity, account.username),
    federated.quote.uri,
    federated.object,
  );

/**
 * Ask the remote author of the status a just-federated note quotes for
 * approval with a `QuoteRequest`. A targeted outbox delivery: its workflow
 * retries a failed attempt with backoff, as Mastodon's `QuoteRequestWorker`
 * delivers through `DeliveryWorker`. As Mastodon, nothing asks again when no
 * answer comes. A failure is logged.
 */
export const requestQuoteApproval = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  note: LocalNote,
  federated: NoteObject,
  target: QuoteRequestTarget,
): Promise<void> => {
  const { quote } = federated;
  if (quote === undefined) {
    return;
  }
  const requested = await enqueueTargetedActivity(
    env,
    account,
    "QuoteRequest",
    noteQuoteRequest(identity, account, { ...federated, quote }, target.uri),
    target.inboxUri,
  );
  if (requested.isErr()) {
    console.error(JSON.stringify({ kind: "QuoteRequestNotSent", statusId: note.id }));
  }
};
