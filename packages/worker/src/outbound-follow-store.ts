import { OutboundFollow, type OutboundFollowAnswer } from "@tstodon/domain";
import { schemaResult, warmSchemas } from "@tstodon/core";
import type { Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { type RepositoryError, runD1 } from "./d1";
import type { FollowOptions } from "./follow-store";
import { parseJsonColumn } from "./json-column";
import { CountedRow, queryTyped, runTyped } from "./typed-sql";
import {
  acceptOutboundFollow as acceptOutboundFollowSql,
  deleteOutboundFollow as deleteOutboundFollowSql,
  findOutboundFollow as findOutboundFollowSql,
  insertOutboundFollow as insertOutboundFollowSql,
  listOutboundFollowsByActor as listOutboundFollowsByActorSql,
  rejectOutboundFollow as rejectOutboundFollowSql,
  updateOutboundFollowOptions as updateOutboundFollowOptionsSql,
} from "./generated/prisma/sql";

const FollowActivityIdRow = z.object({ follow_activity_id: z.string() });

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

const followFromRow = (
  row: z.infer<typeof OutboundFollowRowSchema>,
): OutboundFollow | undefined => {
  const followed = OutboundFollow.parse({
    id: row.id,
    accountId: row.account_id,
    actorUri: row.actor_uri,
    followActivityId: row.follow_activity_id,
    state: { kind: row.state },
    reblogs: row.reblogs !== 0,
    notify: row.notify !== 0,
    languages: parseJsonColumn(z.array(z.string()), row.languages_json).unwrapOr([]),
    createdAt: row.created_at,
  });
  return followed.isOk() ? followed.value : undefined;
};

/** An `outbound_follows` row as the domain model; `undefined` for anything unreadable. */
export const outboundFollowFromRow = (raw: unknown): OutboundFollow | undefined => {
  const row = parseOutboundFollowRow(raw);
  return row.isOk() ? followFromRow(row.value) : undefined;
};

export const findOutboundFollow = async (
  db: D1Database,
  accountId: string,
  actorUri: string,
): Promise<Result<OutboundFollow | undefined, RepositoryError>> =>
  runD1(async () => {
    const [row] = await queryTyped(
      db,
      findOutboundFollowSql(accountId, actorUri),
      OutboundFollowRowSchema,
    );
    return row === undefined ? undefined : followFromRow(row);
  });

/** Up to `limit` follows of `actorUri` with an id after `afterId`, in id order. */
export const listOutboundFollowsByActor = async (
  db: D1Database,
  actorUri: string,
  afterId: string,
  limit: number,
): Promise<Result<OutboundFollow[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      listOutboundFollowsByActorSql(actorUri, afterId, limit),
      OutboundFollowRowSchema,
    );
    return rows.flatMap((row) => {
      const follow = followFromRow(row);
      return follow ? [follow] : [];
    });
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
      CountedRow,
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

export const acceptOutboundFollow = async (
  db: D1Database,
  answer: OutboundFollowAnswer,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      acceptOutboundFollowSql(answer.actorUri, answer.followActivityId, answer.accountId ?? ""),
      CountedRow,
    );
    return rows.length > 0;
  });

export const rejectOutboundFollow = async (
  db: D1Database,
  answer: OutboundFollowAnswer,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      rejectOutboundFollowSql(answer.actorUri, answer.followActivityId, answer.accountId ?? ""),
      CountedRow,
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
    const rows = await queryTyped(
      db,
      deleteOutboundFollowSql(accountId, actorUri),
      FollowActivityIdRow,
    );
    return rows[0]?.follow_activity_id;
  });

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([OutboundFollowRowSchema]);
