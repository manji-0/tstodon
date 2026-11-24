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

/**
 * How many due posts one run publishes. A plain post costs about 45 D1
 * statements and each local account it mentions about 35 more, and the run
 * shares its queue invocation's 1000 with up to four other jobs, so a full
 * backlog is published by chained runs of 5 rather than by one of 20.
 */
export const PUBLISH_BATCH = 5;

/**
 * Replay one scheduled post through the normal publish path. A row whose
 * params no longer validate is dropped; a repository failure keeps the row so
 * the next run retries it. Resolves to whether the row is gone, published
 * or dropped.
 */
const publishScheduled = async (env: Env, row: ScheduledStatusRow): Promise<boolean> => {
  const drop = async (): Promise<boolean> =>
    (await deleteScheduledStatus(env.DB, row.accountId, row.id)).isOk();
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return false;
  }
  const account = await findAccountById(env.DB, row.accountId);
  if (account.isErr() || !account.value) {
    // The account is gone (cascade would have removed the row); drop a stray.
    return drop();
  }
  const moderation = await findLocalAccountModeration(env.DB, row.accountId);
  if (moderation.isOk() && LocalAccountModeration.isBarred(moderation.value)) {
    // A blocked login cannot publish; Mastodon drops the job the same way.
    return drop();
  }
  const visibility = Visibility.fromParam(row.params.visibility);
  if (visibility.isErr()) {
    return drop();
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
      return resolved.error.kind === "Rejected" ? drop() : false;
    }
    if (resolved.value.quote === null) {
      return drop();
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
    return drop();
  }
  // Mastodon checks media again when it publishes: another status may hold it by now.
  const unattachable = await findUnattachableMediaIds(
    env.DB,
    row.accountId,
    draft.value.mediaIds,
    null,
  );
  if (unattachable.isErr()) {
    return false;
  }
  if (unattachable.value.length > 0) {
    return drop();
  }
  const inReplyToId =
    row.params.in_reply_to_id === null ? null : StatusId.parse(row.params.in_reply_to_id);
  if (inReplyToId !== null && inReplyToId.isErr()) {
    return drop();
  }
  let replyTo: ThreadStatus | null = null;
  if (inReplyToId !== null) {
    const parent = await findReplyTarget(env, inReplyToId.value, account.value.id);
    // A failed read keeps the post for the next run, as the media check does.
    if (parent.isErr()) {
      return false;
    }
    if (!parent.value) {
      return drop();
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
  return published.isOk() && drop();
};

/** Whether a scheduled post is due now. A failed read answers yes. */
export const hasDueScheduledStatuses = async (env: Env): Promise<boolean> => {
  const due = await listDueScheduledStatuses(env.DB, nowIso(), 1);
  return due.isErr() || due.value.length > 0;
};

/**
 * Cron path: publish the posts that are due, a bounded batch per run. Resolves
 * to whether another run should follow at once: the batch was full and at
 * least one row is gone, so a backlog drains without repeating rows that keep
 * failing until the next cron.
 */
export const publishDueScheduledStatuses = async (env: Env): Promise<boolean> => {
  const due = await listDueScheduledStatuses(env.DB, nowIso(), PUBLISH_BATCH);
  if (due.isErr()) {
    return false;
  }
  let settled = 0;
  for (const row of due.value) {
    settled += (await publishScheduled(env, row)) ? 1 : 0;
  }
  return due.value.length === PUBLISH_BATCH && settled > 0;
};
