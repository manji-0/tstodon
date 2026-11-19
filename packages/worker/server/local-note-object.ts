import type { ApActivityDocumentOf, ApStatusDocumentJSON } from "@tstodon/api/activitypub";
import { InstanceIdentity, type LocalAccount, type LocalNote } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { type NoteQuote, noteDocument, quoteRequestActivity } from "./activitypub";
import { loadCustomEmojis } from "./custom-emoji-store";
import { enqueueTargetedActivity } from "./delivery";
import { newEntityId } from "./ids";
import { loadNoteMentions } from "./mention-resolve";
import { loadNoteMedia } from "./note-attachments";
import { loadNotePoll } from "./poll-store";
import { loadNoteQuotePolicy } from "./quote-policy-name";
import { noteQuote } from "./quote-uri";
import { loadNoteReply } from "./reply-target";

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
  cause: "media" | "quote";
}>;

/** The note's ActivityPub object, read from what is stored about it. */
export const readNoteObject = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  note: LocalNote,
): Promise<Result<NoteObject, NoteObjectUnreadable>> => {
  const media = await loadNoteMedia(env.DB, identity, note);
  if (media.isErr()) {
    return err({ kind: "NoteObjectUnreadable", cause: "media" });
  }
  const quote = await noteQuote(env, identity, note.id);
  if (quote.isErr()) {
    return err({ kind: "NoteObjectUnreadable", cause: "quote" });
  }
  return ok({
    quote: quote.value,
    object: noteDocument(identity, account, note, {
      quote: quote.value,
      mentions: await loadNoteMentions(env.DB, identity, note.id),
      reply: await loadNoteReply(env.DB, identity, note),
      poll: await loadNotePoll(env.DB, note.id),
      media: media.value,
      quotePolicy: await loadNoteQuotePolicy(env.DB, account, note),
      emojis: await loadCustomEmojis(env, identity.mediaPublicBaseUrl),
    }),
  });
};

/**
 * The `Update` of a note's object, made at `updatedAt`. The object is read
 * with the note stamped edited then, so a receiver takes it as newer than
 * its copy.
 */
export const noteUpdateActivity = (
  identity: InstanceIdentity,
  account: LocalAccount,
  note: LocalNote,
  object: ApStatusDocumentJSON,
  updatedAt: string,
): ApActivityDocumentOf<"Update"> => {
  const actor = InstanceIdentity.actorUrl(identity, account.username);
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${actor}/statuses/${note.id}/updates/${newEntityId()}`,
    type: "Update",
    actor,
    published: updatedAt,
    object,
  };
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
    account.id,
    "QuoteRequest",
    noteQuoteRequest(identity, account, { ...federated, quote }, target.uri),
    target.inboxUri,
  );
  if (requested.isErr()) {
    console.error(JSON.stringify({ kind: "QuoteRequestNotSent", statusId: note.id }));
  }
};
