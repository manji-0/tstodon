import { InstanceLimits } from "@tstodon/core";
import type { ApiStatusJSON } from "@tstodon/api";
import { afterResponse } from "./after-response";
import type {
  LocalAccount,
  LocalNote,
  RemoteActor,
  StatusTargetValue,
  ThreadStatus,
  ValidatedStatusDraft,
} from "@tstodon/domain";
import {
  InstanceIdentity,
  LocalStatus,
  NoteThread,
  StatusId,
  StatusNotificationAudience,
  StatusTarget,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { nowInstant } from "./clock";
import type { RepositoryError } from "./d1";
import { enqueueLocalActivity } from "./delivery";
import { synchronizesFollowers } from "./followers-synchronization";
import { formatPostText } from "./html";
import { newEntityId } from "./ids";
import { findMediaById, parseMediaFocus, updateMediaMetadata } from "./media-store";
import { replaceStatusMentions, replaceStatusRemoteMentions } from "./mention-store";
import { mentionLinks, resolveMentions } from "./mention-resolve";
import { noteCreateActivity } from "./activitypub";
import { readNoteObject, requestQuoteApproval } from "./local-note-object";
import { deferStatusActivity } from "./pending-status-federation";
import { mentionedPost, notifyAccount } from "./notify";
import { insertPoll } from "./poll-store";
import { startLinkCard } from "./link-card";
import type { MediaAttribute } from "./status-body-schema";
import { notifyingFollowers } from "./follow-store";
import { mastodonStatus } from "./local-status-documents";
import { insertStatusQuote, setStatusQuotePolicy, type QuotePolicy } from "./quote-store";
import { insertLocalNote, setStatusReplyUri } from "./status-store";
import { startHomeFanOut } from "./home-fan-out";
import { startPublicFanOut } from "./public-fan-out";
import { publishConversationUpdate } from "./conversation-stream";
import { publishToAccount } from "./stream-publish";
import { localOwnAncestryOfParent } from "./own-ancestry";

/** Inline media metadata accepted on create (`media_attributes`). */
export type PublishMediaAttributes = ReadonlyArray<MediaAttribute>;

export type PublishPoll = Readonly<{
  options: ReadonlyArray<string>;
  expiresIn: number;
  multiple: boolean;
  hideTotals: boolean;
}>;

/**
 * Who wrote a quoted status: a local account, whose acceptance is implicit, or
 * a remote actor, who is asked with a `QuoteRequest`.
 */
export type QuotedAuthor =
  | Readonly<{ kind: "Local"; accountId: string }>
  | Readonly<{ kind: "Remote"; actor: RemoteActor }>;

export type PublishNoteInput = Readonly<{
  draft: ValidatedStatusDraft;
  /** The status answered, local or cached remote. */
  replyTo: ThreadStatus | null;
  mediaAttributes: ReadonlyArray<MediaAttribute>;
  poll: PublishPoll | null;
  /** The quoted status, its author, and the `quote-inline` paragraph. */
  quote: Readonly<{
    quoted: StatusTargetValue;
    quotedAuthor: QuotedAuthor;
    inlineHtml: string;
  }> | null;
  /** Who may quote the new status; `null` keeps the account default. */
  quotePolicy: QuotePolicy | null;
}>;

export type MediaMetadataUpdate = Parameters<typeof updateMediaMetadata>[1];

/**
 * What `media_attributes` change of the status's media (`mediaIds`): a
 * description or a focus that differs from the stored one, as Mastodon's
 * `MediaAttachment#significantly_changed?`. An attribute for other media,
 * or one that repeats what is stored, changes nothing. The caller has
 * checked each description against the limit (`mediaDescriptionsFit`).
 */
export const mediaAttributeChanges = async (
  db: D1Database,
  accountId: string,
  mediaIds: ReadonlyArray<string>,
  attributes: PublishMediaAttributes,
): Promise<Result<ReadonlyArray<MediaMetadataUpdate>, RepositoryError>> => {
  const changes: MediaMetadataUpdate[] = [];
  for (const attribute of attributes) {
    const found = await findMediaById(db, attribute.id);
    if (found.isErr()) {
      return err(found.error);
    }
    const media = found.value;
    if (!media || media.account_id !== accountId || !mediaIds.includes(media.id)) {
      continue;
    }
    const focus = attribute.focus === undefined ? undefined : parseMediaFocus(attribute.focus);
    const focusX = focus?.x ?? media.focus_x;
    const focusY = focus?.y ?? media.focus_y;
    const description =
      attribute.description === undefined
        ? media.description
        : attribute.description.trim().length > 0
          ? attribute.description
          : null;
    if (description !== media.description || focusX !== media.focus_x || focusY !== media.focus_y) {
      changes.push({ id: media.id, accountId, description, focusX, focusY });
    }
  }
  return ok(changes);
};

/** Store the media metadata `mediaAttributeChanges` found. */
export const writeMediaAttributes = async (
  db: D1Database,
  changes: ReadonlyArray<MediaMetadataUpdate>,
): Promise<Result<void, RepositoryError>> => {
  for (const change of changes) {
    const updated = await updateMediaMetadata(db, change);
    if (updated.isErr()) {
      return err(updated.error);
    }
  }
  return ok(undefined);
};

/**
 * Where a new local note sits in its thread, as Mastodon's
 * `in_reply_to_account_id` reads: a reply to its author's own status carries
 * that status's answer over ({@link NoteThread.of}).
 */
const noteThread = async (
  db: D1Database,
  replyTo: ThreadStatus | null,
  authorId: string,
): Promise<Result<NoteThread, RepositoryError>> => {
  if (replyTo === null) {
    return ok({ kind: "Root" });
  }
  if (replyTo.kind !== "Local" || replyTo.status.accountId !== authorId) {
    return ok({ kind: "ReplyToOther" });
  }
  return (await localOwnAncestryOfParent(db, replyTo.status.id)).map(NoteThread.of);
};

/** A published note and its author's view of it (as `GET /api/v1/statuses/:id` renders it). */
export type PublishedNote = Readonly<{
  note: LocalNote;
  document: Result<ApiStatusJSON | undefined, RepositoryError>;
}>;

/**
 * Publish a validated local note: row, poll, preview card, inline media
 * metadata, mentions and their notifications, `notify` followers, the
 * ActivityPub `Create`, and the streaming event. Shared by `POST
 * /api/v1/statuses` and the scheduled-status publisher so both behave the same.
 */
export const publishLocalNote = async (
  env: Env,
  identity: InstanceIdentity,
  user: LocalAccount,
  input: PublishNoteInput,
): Promise<Result<PublishedNote, RepositoryError>> => {
  const id = StatusId.parse(newEntityId());
  if (id.isErr()) {
    return err({ kind: "RepositoryError", message: "invalid status id" });
  }
  // Resolved before the note is written: its HTML links the mentions that resolve.
  const resolved = await resolveMentions(env, identity, input.draft.text);
  if (resolved.isErr()) {
    return err(resolved.error);
  }
  const mentionedAccounts = resolved.value.locals;
  const remoteMentions = resolved.value.remotes;
  const html = formatPostText(input.draft.text, {
    identity,
    mentions: mentionLinks(identity, resolved.value),
  });
  const note = LocalStatus.publish(
    id.value,
    user.id,
    input.draft,
    nowInstant(),
    input.quote ? `${input.quote.inlineHtml}${html}` : html,
    input.replyTo?.kind === "Local" ? input.replyTo.status.id : null,
  );
  const inserted = await insertLocalNote(env.DB, note);
  if (inserted.isErr()) {
    return err(inserted.error);
  }
  // `in_reply_to_id` references local statuses only; a remote parent is kept by URI.
  if (input.replyTo?.kind === "Remote") {
    const linked = await setStatusReplyUri(env.DB, note.id, input.replyTo.status.objectUri);
    if (linked.isErr()) {
      return err(linked.error);
    }
  }
  const actor = InstanceIdentity.actorUrl(identity, user.username);
  // A local quoted author's acceptance is implicit; a remote one is asked, by
  // a `QuoteRequest` whose id the quote keeps to match the answer.
  const quoteId = newEntityId();
  const quotedAuthor = input.quote?.quotedAuthor;
  if (input.quote) {
    const quote = await insertStatusQuote(env.DB, {
      id: quoteId,
      quoting: StatusTarget.local(note.id),
      quoted: input.quote.quoted,
      state:
        input.quote.quotedAuthor.kind === "Local"
          ? { kind: "Accepted", approval: { kind: "Implicit" } }
          : { kind: "Pending" },
      legacy: false,
      activityUri:
        input.quote.quotedAuthor.kind === "Local"
          ? undefined
          : `${actor}/quote_requests/${quoteId}`,
      createdAt: nowInstant(),
    });
    if (quote.isErr()) {
      return err(quote.error);
    }
  }
  if (quotedAuthor?.kind === "Local" && quotedAuthor.accountId !== user.id) {
    const notified = await notifyAccount(env, {
      accountId: quotedAuthor.accountId,
      fromAccountId: user.id,
      kind: "quote",
      statusId: note.id,
    });
    if (notified.isErr()) {
      return err(notified.error);
    }
  }
  // The policy is frozen with the status, so a later account default change
  // cannot loosen or tighten quotes that already exist.
  const policy = input.quotePolicy;
  if (policy) {
    const stored = await setStatusQuotePolicy(env.DB, note.id, policy);
    if (stored.isErr()) {
      return err(stored.error);
    }
  }
  if (input.poll && input.poll.options.length >= 2) {
    const expiresIn = Number.isFinite(input.poll.expiresIn)
      ? Math.min(
          Math.max(input.poll.expiresIn, InstanceLimits.poll.minExpirationSeconds),
          InstanceLimits.poll.maxExpirationSeconds,
        )
      : 86400;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const poll = await insertPoll(env.DB, {
      statusId: note.id,
      multiple: input.poll.multiple,
      expiresAt,
      options: [...input.poll.options],
      hideTotals: input.poll.hideTotals,
    });
    if (poll.isErr()) {
      return err(poll.error);
    }
  }
  startLinkCard(env, "Status", note.id, note.text);
  const attributes = await mediaAttributeChanges(
    env.DB,
    user.id,
    note.mediaIds,
    input.mediaAttributes,
  );
  const attributesWritten = attributes.isOk()
    ? await writeMediaAttributes(env.DB, attributes.value)
    : err(attributes.error);
  if (attributesWritten.isErr()) {
    return err(attributesWritten.error);
  }
  // Persist mention rows before side-effect notifies (D1 write strategy / Create saga).
  const mentionsSaved = await replaceStatusMentions(
    env.DB,
    note.id,
    mentionedAccounts.map((account) => account.id),
  );
  if (mentionsSaved.isErr()) {
    return err(mentionsSaved.error);
  }
  const remoteSaved = await replaceStatusRemoteMentions(
    env.DB,
    note.id,
    remoteMentions.map((actor) => actor.actorUri),
  );
  if (remoteSaved.isErr()) {
    return err(remoteSaved.error);
  }
  const post = mentionedPost(
    [
      ...mentionedAccounts.map((account) => account.id),
      ...remoteMentions.map((actor) => actor.actorUri),
    ],
    input.replyTo ?? undefined,
  );
  for (const mentioned of mentionedAccounts) {
    if (mentioned.id === user.id) {
      continue;
    }
    await notifyAccount(
      env,
      { accountId: mentioned.id, fromAccountId: user.id, kind: "mention", statusId: note.id },
      post,
    );
  }
  // Followers who asked for notifications on this account's posts get a
  // `status` notification when the note reaches their home. The
  // notification policy still decides delivery.
  const notifying = await notifyingFollowers(env.DB, user.id, note.id);
  if (notifying.isErr()) {
    return err(notifying.error);
  }
  const thread = await noteThread(env.DB, input.replyTo, user.id);
  if (thread.isErr()) {
    return err(thread.error);
  }
  const notified = StatusNotificationAudience.recipients(
    {
      visibility: note.visibility,
      thread: thread.value,
      language: note.language,
      addressed: new Set(mentionedAccounts.map((account) => account.id)),
    },
    notifying.value,
  );
  for (const followerId of notified) {
    await notifyAccount(env, {
      accountId: followerId,
      fromAccountId: user.id,
      kind: "status",
      statusId: note.id,
    });
  }
  // A direct note goes only to the remote accounts it mentions or quotes; with
  // none, nothing leaves the instance.
  const federates = !(
    note.visibility.kind === "Direct" &&
    remoteMentions.length === 0 &&
    quotedAuthor?.kind !== "Remote"
  );
  // The note, its media and its quote are already stored, so a failure to
  // read them back neither federates it without them nor fails it half
  // done: its `Create` is retried later (FED-14).
  const federated = federates ? await readNoteObject(env, identity, user, note) : undefined;
  if (federated?.isErr()) {
    console.error(
      JSON.stringify({
        kind: "StatusNotFederated",
        statusId: note.id,
        cause: federated.error.cause,
      }),
    );
    await deferStatusActivity(env, note.id, "Create");
  }
  const enqueued =
    federated === undefined || federated.isErr()
      ? ok(undefined)
      : await enqueueLocalActivity(
          env,
          user,
          "Create",
          noteCreateActivity(identity, user, federated.value.object),
          { synchronizeFollowers: await synchronizesFollowers(env.DB, user.id, note.visibility) },
        );
  if (enqueued.isErr()) {
    return err(
      enqueued.error.kind === "RepositoryError"
        ? enqueued.error
        : {
            kind: "RepositoryError" as const,
            message:
              enqueued.error.kind === "QueueSendFailed"
                ? enqueued.error.message
                : "invalid activity id",
          },
    );
  }
  if (federated?.isOk() && quotedAuthor?.kind === "Remote") {
    await requestQuoteApproval(env, identity, user, note, federated.value, {
      uri: `${actor}/quote_requests/${quoteId}`,
      inboxUri: quotedAuthor.actor.inboxUri,
    });
  }
  // The author's own view of the note: the response and the author's stream
  // event both send it. A render that fails sends no event.
  const document = await mastodonStatus(env, identity, note, user.id);
  // Stream events and fan-outs wait until the response is ready.
  afterResponse("LocalNoteFanOutFailed", async () => {
    if (document.isOk() && document.value) {
      await publishToAccount(env, user.id, { kind: "update", payload: document.value });
    }
    if (note.visibility.kind === "Direct") {
      await publishConversationUpdate(
        env,
        identity,
        [user.id, ...mentionedAccounts.map((account) => account.id)],
        note.id,
      );
    }
    await startHomeFanOut(env, {
      event: "update",
      entryId: note.id,
      author: { kind: "LocalAccount", accountId: user.id },
    });
    if (note.visibility.kind === "Public") {
      await startPublicFanOut(env, { event: "update", entryId: note.id });
    }
  });
  return ok({ note, document });
};
