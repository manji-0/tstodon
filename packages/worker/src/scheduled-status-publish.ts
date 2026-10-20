import { StatusComposition, StatusId, Visibility } from "@tstodon/domain";
import { nowIso } from "./clock";
import { findAccountById } from "./account-store";
import { getAccountModeration } from "./account-moderation-store";
import { disabledAccountIds } from "./account-flag-store";
import { publishLocalNote } from "./local-status-publish";
import { parseInstanceIdentity } from "./runtime-config";
import {
  deleteScheduledStatus,
  listDueScheduledStatuses,
  type ScheduledStatusRow,
} from "./scheduled-status-store";
import { findStatusById } from "./status-store";

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
  const moderation = await getAccountModeration(env.DB, row.accountId);
  const disabled = await disabledAccountIds(env.DB, [row.accountId]);
  if (
    (moderation.isOk() && moderation.value === "Suspended") ||
    (disabled.isOk() && disabled.value.has(row.accountId))
  ) {
    // A blocked login cannot publish; Mastodon drops the job the same way.
    await deleteScheduledStatus(env.DB, row.accountId, row.id);
    return;
  }
  const visibility = Visibility.fromMastodon(row.params.visibility);
  if (visibility.isErr()) {
    await deleteScheduledStatus(env.DB, row.accountId, row.id);
    return;
  }
  const composing = StatusComposition.composing({
    text: row.params.text,
    visibility: visibility.value,
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
  if (draft.isErr()) {
    await deleteScheduledStatus(env.DB, row.accountId, row.id);
    return;
  }
  const inReplyToId =
    row.params.in_reply_to_id === null ? null : StatusId.parse(row.params.in_reply_to_id);
  if (inReplyToId !== null && inReplyToId.isErr()) {
    await deleteScheduledStatus(env.DB, row.accountId, row.id);
    return;
  }
  if (inReplyToId !== null) {
    const parent = await findStatusById(env.DB, inReplyToId.value);
    if (parent.isErr() || !parent.value) {
      await deleteScheduledStatus(env.DB, row.accountId, row.id);
      return;
    }
  }
  const published = await publishLocalNote(env, identity.value, account.value, {
    draft: draft.value,
    inReplyToId: inReplyToId === null ? null : inReplyToId.value,
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
    // Scheduled quotes are refused at create time, and the policy was frozen
    // with the params.
    quote: null,
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
