import { InstanceLimits, characterCount } from "@tstodon/core";
import type { LocalAccount, LocalNote, ValidatedStatusDraft } from "@tstodon/domain";
import { InstanceIdentity, LocalStatus, StatusId } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountsByUsernames } from "./account-store";
import { nowInstant } from "./clock";
import type { RepositoryError } from "./d1";
import { enqueueLocalActivity } from "./delivery";
import { mentionUsernames, textToHtml } from "./html";
import { newEntityId } from "./ids";
import { findMediaById, parseMediaFocus, updateMediaMetadata } from "./media-store";
import { replaceStatusMentions, replaceStatusRemoteMentions } from "./mention-store";
import { loadNoteMentions, resolveRemoteMentions } from "./mention-resolve";
import { loadNoteReply, type ReplyTarget } from "./reply-target";
import { noteDocument } from "./activitypub";
import { notifyAccount } from "./notify";
import { insertPoll } from "./poll-store";
import { enqueueLinkCard } from "./link-card";
import type { MediaAttribute } from "./schemas";
import { notifyingFollowerIds } from "./social-store";
import { mastodonStatus } from "./mastodon";
import { insertStatusQuote, setStatusQuotePolicy, type QuotePolicy } from "./quote-store";
import { insertLocalNote, setStatusReplyUri } from "./status-store";
import { publishToAccount } from "./stream-publish";

/** Inline media metadata accepted on create (`media_attributes`). */
export type PublishMediaAttributes = ReadonlyArray<MediaAttribute>;

export type PublishPoll = Readonly<{
  options: ReadonlyArray<string>;
  expiresIn: number;
  multiple: boolean;
  hideTotals: boolean;
}>;

export type PublishNoteInput = Readonly<{
  draft: ValidatedStatusDraft;
  /** The status answered, local or cached remote. */
  replyTo: ReplyTarget | null;
  mediaAttributes: ReadonlyArray<MediaAttribute>;
  poll: PublishPoll | null;
  /** The quoted status, with its URI and the `quote-inline` paragraph. */
  quote: Readonly<{
    quotedStatusId: string;
    quotedAccountId: string;
    inlineHtml: string;
    uri: string;
  }> | null;
  /** Who may quote the new status; `null` keeps the account default. */
  quotePolicy: QuotePolicy | null;
}>;

/** Apply `media_attributes` to media already attached to this status. */
export const applyMediaAttributes = async (
  env: Env,
  accountId: string,
  statusId: string,
  attributes: PublishMediaAttributes,
): Promise<string | undefined> => {
  for (const attribute of attributes) {
    const found = await findMediaById(env.DB, attribute.id);
    if (found.isErr()) {
      return found.error.message;
    }
    const media = found.value;
    if (!media || media.account_id !== accountId || media.status_id !== statusId) {
      continue;
    }
    let focusX = media.focus_x;
    let focusY = media.focus_y;
    if (attribute.focus !== undefined) {
      const focus = parseMediaFocus(attribute.focus);
      if (focus) {
        focusX = focus.x;
        focusY = focus.y;
      }
    }
    if (
      attribute.description !== undefined &&
      characterCount(attribute.description) > InstanceLimits.media.maxDescriptionCharacters
    ) {
      return "media description is too long";
    }
    const description =
      attribute.description === undefined
        ? media.description
        : attribute.description.trim().length > 0
          ? attribute.description
          : null;
    const updated = await updateMediaMetadata(env.DB, {
      id: media.id,
      accountId,
      description,
      focusX,
      focusY,
    });
    if (updated.isErr()) {
      return updated.error.message;
    }
  }
  return undefined;
};

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
): Promise<Result<LocalNote, RepositoryError>> => {
  const id = StatusId.parse(newEntityId());
  if (id.isErr()) {
    return err({ kind: "RepositoryError", message: "invalid status id" });
  }
  const html = textToHtml(input.draft.text);
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
  if (input.quote) {
    const quote = await insertStatusQuote(env.DB, note.id, input.quote.quotedStatusId);
    if (quote.isErr()) {
      return err(quote.error);
    }
    if (input.quote.quotedAccountId !== user.id) {
      const notified = await notifyAccount(env, {
        accountId: input.quote.quotedAccountId,
        fromAccountId: user.id,
        kind: "quote",
        statusId: note.id,
      });
      if (notified.isErr()) {
        return err(notified.error);
      }
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
  await enqueueLinkCard(env, "Status", note.id, note.text);
  const attributeError = await applyMediaAttributes(env, user.id, note.id, input.mediaAttributes);
  if (attributeError !== undefined) {
    return err({ kind: "RepositoryError", message: attributeError });
  }
  const mentionNames = mentionUsernames(note.text, identity.domain);
  const mentionedAccounts = await findAccountsByUsernames(env.DB, [...mentionNames]);
  if (mentionedAccounts.isErr()) {
    return err(mentionedAccounts.error);
  }
  // Persist mention rows before side-effect notifies (D1 write strategy / Create saga).
  const mentionsSaved = await replaceStatusMentions(
    env.DB,
    note.id,
    mentionedAccounts.value.map((account) => account.id),
  );
  if (mentionsSaved.isErr()) {
    return err(mentionsSaved.error);
  }
  const remoteMentions = await resolveRemoteMentions(env, identity, note.text);
  const remoteSaved = await replaceStatusRemoteMentions(
    env.DB,
    note.id,
    remoteMentions.map((actor) => actor.actorUri),
  );
  if (remoteSaved.isErr()) {
    return err(remoteSaved.error);
  }
  for (const mentioned of mentionedAccounts.value) {
    if (mentioned.id === user.id) {
      continue;
    }
    await notifyAccount(env, {
      accountId: mentioned.id,
      fromAccountId: user.id,
      kind: "mention",
      statusId: note.id,
    });
  }
  // Followers who asked for notifications on this account's posts get a
  // `status` notification; the notification policy still decides delivery.
  const notifying = await notifyingFollowerIds(env.DB, user.id);
  if (notifying.isErr()) {
    return err(notifying.error);
  }
  for (const followerId of notifying.value) {
    if (followerId === user.id) {
      continue;
    }
    await notifyAccount(env, {
      accountId: followerId,
      fromAccountId: user.id,
      kind: "status",
      statusId: note.id,
    });
  }
  const actor = InstanceIdentity.actorUrl(identity, user.username);
  // A direct note goes only to the remote accounts it mentions; with none,
  // nothing leaves the instance.
  const enqueued =
    note.visibility.kind === "Direct" && remoteMentions.length === 0
      ? ok(undefined)
      : await enqueueLocalActivity(env, user.id, "Create", {
          "@context": "https://www.w3.org/ns/activitystreams",
          id: `${actor}/statuses/${note.id}/activity`,
          type: "Create",
          actor,
          object: noteDocument(identity, user, note, {
            quoteUri: input.quote?.uri,
            mentions: await loadNoteMentions(env.DB, identity, note.id),
            reply: await loadNoteReply(env.DB, identity, note),
          }),
        });
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
  const document = (await mastodonStatus(env, identity, note, user.id)) ?? {};
  await publishToAccount(env, user.id, { kind: "update", payload: document });
  return ok(note);
};
