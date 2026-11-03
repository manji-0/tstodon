import { OutboundFollow } from "@tstodon/domain";
import { schemaResult, warmSchemas } from "@tstodon/core";
import type { Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { type RepositoryError, runD1 } from "./d1";
import type { FollowOptions } from "./follow-store";
import { parseJsonColumn } from "./json-column";
import { queryTyped, runTyped } from "./typed-sql";
import {
  acceptOutboundFollow as acceptOutboundFollowSql,
  deleteOutboundFollow as deleteOutboundFollowSql,
  findOutboundFollow as findOutboundFollowSql,
  insertOutboundFollow as insertOutboundFollowSql,
  rejectOutboundFollow as rejectOutboundFollowSql,
  updateOutboundFollowOptions as updateOutboundFollowOptionsSql,
} from "./generated/prisma/sql";

const OutboundFollowRowSchema = z.object({
  id: z.string(),
  account_id: z.string(),
  actor_uri: z.string(),
  follow_activity_id: z.string(),
  state: z.string(),
  reblogs: z.number(),
  notify: z.number(),
  languages_json: z.string(),
  created_at: z.string(),
});

const parseOutboundFollowRow = schemaResult(OutboundFollowRowSchema);

/** An `outbound_follows` row as the domain model; `undefined` for anything unreadable. */
export const outboundFollowFromRow = (raw: unknown): OutboundFollow | undefined => {
  const row = parseOutboundFollowRow(raw);
  if (row.isErr()) {
    return undefined;
  }
  const followed = OutboundFollow.parse({
    id: row.value.id,
    accountId: row.value.account_id,
    actorUri: row.value.actor_uri,
    followActivityId: row.value.follow_activity_id,
    state: { kind: row.value.state },
    reblogs: row.value.reblogs !== 0,
    notify: row.value.notify !== 0,
    languages: parseJsonColumn(z.array(z.string()), row.value.languages_json).unwrapOr([]),
    createdAt: row.value.created_at,
  });
  return followed.isOk() ? followed.value : undefined;
};

export const findOutboundFollow = async (
  db: D1Database,
  accountId: string,
  actorUri: string,
): Promise<Result<OutboundFollow | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, findOutboundFollowSql(accountId, actorUri));
    return outboundFollowFromRow(rows[0]);
  });

/**
 * Record a `Requested` follow of `actorUri`. Resolves to false when the account
 * already follows (or asked to follow) the actor, so the `Follow` is sent once.
 */
export const insertOutboundFollow = async (
  db: D1Database,
  follow: Readonly<{ id: string; accountId: string; actorUri: string; followActivityId: string }>,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const inserted = await queryTyped(
      db,
      insertOutboundFollowSql(
        follow.id,
        follow.accountId,
        follow.actorUri,
        follow.followActivityId,
        nowIso(),
      ),
    );
    return inserted.length > 0;
  });

/** Change the options given; the ones left out keep their stored value. */
export const updateOutboundFollowOptions = async (
  db: D1Database,
  accountId: string,
  actorUri: string,
  options: FollowOptions,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    const flag = (value: boolean | undefined): number | null =>
      value === undefined ? null : value ? 1 : 0;
    await runTyped(
      db,
      updateOutboundFollowOptionsSql(
        accountId,
        actorUri,
        flag(options.reblogs),
        flag(options.notify),
        options.languages === undefined ? null : JSON.stringify(options.languages),
      ),
    );
  });

/**
 * The follow an `Accept` or `Reject` from `actorUri` answers: the one whose
 * `Follow` id it names, or, when the answer embeds a `Follow` from a local
 * account, that account's follow of the actor.
 */
export type OutboundFollowAnswer = Readonly<{
  actorUri: string;
  followActivityId: string;
  accountId: string | undefined;
}>;

/** Mark the answered follow `Accepted`. Resolves to true when a follow matched. */
export const acceptOutboundFollow = async (
  db: D1Database,
  answer: OutboundFollowAnswer,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      acceptOutboundFollowSql(answer.actorUri, answer.followActivityId, answer.accountId ?? ""),
    );
    return rows.length > 0;
  });

/** Drop the answered follow. Resolves to true when a follow matched. */
export const rejectOutboundFollow = async (
  db: D1Database,
  answer: OutboundFollowAnswer,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      rejectOutboundFollowSql(answer.actorUri, answer.followActivityId, answer.accountId ?? ""),
    );
    return rows.length > 0;
  });

/** Remove the follow; resolves to its `Follow` id, or `undefined` when there was none. */
export const deleteOutboundFollow = async (
  db: D1Database,
  accountId: string,
  actorUri: string,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ follow_activity_id: string }>(
      db,
      deleteOutboundFollowSql(accountId, actorUri),
    );
    return rows[0]?.follow_activity_id;
  });

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([OutboundFollowRowSchema]);
