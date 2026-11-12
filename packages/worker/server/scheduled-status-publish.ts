import {
  LocalAccountModeration,
  StatusComposition,
  StatusId,
  type ThreadStatus,
  Visibility,
} from "@tstodon/domain";
import { nowIso } from "./clock";
import { findAccountById } from "./account-store";
import { findLocalAccountModeration } from "./account-moderation-store";
import { findReplyTarget } from "./reply-target";
import { publishLocalNote } from "./local-status-publish";
import { findUnattachableMediaIds } from "./media-store";
import { mediaDescriptionsFit } from "./status-body-schema";
import { parseInstanceIdentity } from "./runtime-config";
import { resolveQuote, type ResolvedQuote } from "./quote-resolve";
import {
  deleteScheduledStatus,
  listDueScheduledStatuses,
  type ScheduledStatusRow,
} from "./scheduled-status-store";

/** How many due posts one cron run publishes. */
const PUBLISH_BATCH = 20;

/**
 * Replay one scheduled post through the normal publish path. A row whose
 * params no longer validate is dropped; a repository failure keeps the row so
 * the next run retries it.
 */
const publishScheduled = async (env: Env, row: ScheduledStatusRow): Promise<void> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return;
  }
  const account = await findAccountById(env.DB, row.accountId);
  if (account.isErr() || !account.value) {
    // The account is gone (cascade would have removed the row); drop a stray.
    await deleteScheduledStatus(env.DB, row.accountId, row.id);
    return;
  }
  const moderation = await findLocalAccountModeration(env.DB, row.accountId);
  if (moderation.isOk() && LocalAccountModeration.isBarred(moderation.value)) {
    // A blocked login cannot publish; Mastodon drops the job the same way.
    await deleteScheduledStatus(env.DB, row.accountId, row.id);
    return;
  }
  const visibility = Visibility.fromMastodon(row.params.visibility);
  if (visibility.isErr()) {
    await deleteScheduledStatus(env.DB, row.accountId, row.id);
    return;
  }
  // A scheduled quote is resolved again, as `PostStatusService` does when
  // `PublishScheduledStatusWorker` replays it: a quoted status that is gone,
  // hidden from the author, or whose policy no longer lets them quote drops
  // the post (Mastodon's `RecordNotFound` / `NotPermittedError`).
  const quoteRaw = row.params.quoted_status_id ?? null;
  let quoted: ResolvedQuote = { quote: null, visibility: visibility.value };
  if (quoteRaw !== null) {
    const resolved = await resolveQuote(
      env,
      identity.value,
      account.value.id,
      quoteRaw,
      row.params.text,
      visibility.value,
    );
    if (resolved.isErr()) {
      // A failed read keeps the post for the next run, as the media check does.
      if (resolved.error.kind === "Rejected") {
        await deleteScheduledStatus(env.DB, row.accountId, row.id);
      }
      return;
    }
    if (resolved.value.quote === null) {
      await deleteScheduledStatus(env.DB, row.accountId, row.id);
      return;
    }
    quoted = resolved.value;
  }
  const { quote } = quoted;
  const composing = StatusComposition.composing({
    text: row.params.text,
    visibility: quoted.visibility,
    ...(quote ? { quote: { kind: "Quoted", target: quote.quoted } } : {}),
    spoilerText: row.params.spoiler_text,
    sensitive: row.params.sensitive,
    language:
      row.params.language === null
        ? { kind: "None" }
        : { kind: "Present", value: row.params.language },
    mediaIds: [...row.params.media_ids],
    poll: row.params.poll ? { kind: "Present" } : { kind: "None" },
  });
  const draft = StatusComposition.validate(composing);
  if (draft.isErr() || !mediaDescriptionsFit(row.params.media_attributes)) {
    await deleteScheduledStatus(env.DB, row.accountId, row.id);
    return;
  }
  // Mastodon checks media again when it publishes: another status may hold it by now.
  const unattachable = await findUnattachableMediaIds(
    env.DB,
    row.accountId,
    draft.value.mediaIds,
    null,
  );
  if (unattachable.isErr()) {
    return;
  }
  if (unattachable.value.length > 0) {
    await deleteScheduledStatus(env.DB, row.accountId, row.id);
    return;
  }
  const inReplyToId =
    row.params.in_reply_to_id === null ? null : StatusId.parse(row.params.in_reply_to_id);
  if (inReplyToId !== null && inReplyToId.isErr()) {
    await deleteScheduledStatus(env.DB, row.accountId, row.id);
    return;
  }
  let replyTo: ThreadStatus | null = null;
  if (inReplyToId !== null) {
    const parent = await findReplyTarget(env, inReplyToId.value, account.value.id);
    // A failed read keeps the post for the next run, as the media check does.
    if (parent.isErr()) {
      return;
    }
    if (!parent.value) {
      await deleteScheduledStatus(env.DB, row.accountId, row.id);
      return;
    }
    replyTo = parent.value;
  }
  const published = await publishLocalNote(env, identity.value, account.value, {
    draft: draft.value,
    replyTo,
    mediaAttributes: row.params.media_attributes.map((attribute) => ({
      id: attribute.id,
      ...(attribute.description === undefined ? {} : { description: attribute.description }),
      ...(attribute.focus === undefined ? {} : { focus: attribute.focus }),
    })),
    poll: row.params.poll
      ? {
          options: [...row.params.poll.options],
          expiresIn: row.params.poll.expires_in,
          multiple: row.params.poll.multiple,
          hideTotals: row.params.poll.hide_totals,
        }
      : null,
    quote: quote ? { ...quote, inlineHtml: quote.inlineHtml ?? "" } : null,
    // The policy was frozen with the params.
    quotePolicy:
      row.params.quote_policy === undefined
        ? null
        : row.params.quote_policy === "public" ||
            row.params.quote_policy === "followers" ||
            row.params.quote_policy === "nobody"
          ? row.params.quote_policy
          : null,
  });
  if (published.isOk()) {
    await deleteScheduledStatus(env.DB, row.accountId, row.id);
  }
};

/** Whether a scheduled post is due now. A failed read answers yes. */
export const hasDueScheduledStatuses = async (env: Env): Promise<boolean> => {
  const due = await listDueScheduledStatuses(env.DB, nowIso(), 1);
  return due.isErr() || due.value.length > 0;
};

/** Cron path: publish the posts that are due, a bounded batch per run. */
export const publishDueScheduledStatuses = async (env: Env): Promise<void> => {
  const due = await listDueScheduledStatuses(env.DB, nowIso(), PUBLISH_BATCH);
  if (due.isErr()) {
    return;
  }
  for (const row of due.value) {
    await publishScheduled(env, row);
  }
};
