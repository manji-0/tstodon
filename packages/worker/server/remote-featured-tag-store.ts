import { isHashtagName, normalizeHashtag, schemaResult } from "@tstodon/core";
import type { Result } from "neverthrow";
import { z } from "zod";
import { type RepositoryError, runD1 } from "./d1";
import {
  addRemoteFeaturedTag as addRemoteFeaturedTagSql,
  deleteRemoteFeaturedTag as deleteRemoteFeaturedTagSql,
  deleteRemoteFeaturedTags as deleteRemoteFeaturedTagsSql,
  insertRemoteFeaturedTag as insertRemoteFeaturedTagSql,
  listRemoteFeaturedTags as listRemoteFeaturedTagsSql,
} from "./generated/prisma/sql";
import { queryTyped, runTyped, runTypedBatch } from "./typed-sql";

/**
 * The featured hashtags kept per remote actor, as Mastodon's
 * `FeaturedTag::LIMIT`: its collection read keeps the first ten, and an
 * `Add` past ten is dropped.
 */
export const REMOTE_FEATURED_TAG_LIMIT = 10;

/** A hashtag a remote actor features: its normalized tag and the spelling the actor gave. */
export type FeaturedHashtag = Readonly<{ tagName: string; name: string }>;

const HashtagSchema = z.looseObject({ type: z.literal("Hashtag"), name: z.string() });
const parseHashtag = schemaResult(HashtagSchema);

/**
 * A `Hashtag` object as a featured hashtag (Mastodon reads its `name`
 * without the `#`); `undefined` for any other object or a name that is no
 * hashtag.
 */
export const featuredHashtag = (object: unknown): FeaturedHashtag | undefined => {
  const hashtag = parseHashtag(object);
  if (hashtag.isErr()) {
    return undefined;
  }
  const name = hashtag.value.name.trim().replace(/^[#＃]/u, "");
  const tagName = normalizeHashtag(name);
  return isHashtagName(tagName) ? { tagName, name } : undefined;
};

/** Feature `tag` last among `actorUri`'s hashtags, unless it is featured or ten are. */
export const addRemoteFeaturedTag = async (
  db: D1Database,
  actorUri: string,
  tag: FeaturedHashtag,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(
      db,
      addRemoteFeaturedTagSql(actorUri, tag.tagName, tag.name, REMOTE_FEATURED_TAG_LIMIT),
    );
  });

/** Stop featuring the hashtag `tagName` (normalized) for `actorUri`. */
export const removeRemoteFeaturedTag = async (
  db: D1Database,
  actorUri: string,
  tagName: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, deleteRemoteFeaturedTagSql(actorUri, tagName));
  });

/** Make the first ten of `tags`, in this order, the hashtags `actorUri` features. */
export const replaceRemoteFeaturedTags = async (
  db: D1Database,
  actorUri: string,
  tags: ReadonlyArray<FeaturedHashtag>,
): Promise<Result<void, RepositoryError>> =>
  (
    await runTypedBatch(db, [
      deleteRemoteFeaturedTagsSql(actorUri),
      ...tags
        .slice(0, REMOTE_FEATURED_TAG_LIMIT)
        .map((tag, position) =>
          insertRemoteFeaturedTagSql(actorUri, tag.tagName, tag.name, position),
        ),
    ])
  ).map(() => undefined);

const RemoteFeaturedTagRow = z.object({
  tag_name: z.string(),
  name: z.string(),
  statuses_count: z.coerce.number().int().nonnegative(),
  last_status_at: z.string().nullable(),
});

export type RemoteFeaturedTag = Readonly<{
  tagName: string;
  name: string;
  statusesCount: number;
  lastStatusAt: string | null;
}>;

/** The hashtags `actorUri` features, in its order, each with its public and unlisted posts held here. */
export const listRemoteFeaturedTags = async (
  db: D1Database,
  actorUri: string,
): Promise<Result<RemoteFeaturedTag[], RepositoryError>> =>
  runD1(async () =>
    (await queryTyped(db, listRemoteFeaturedTagsSql(actorUri), RemoteFeaturedTagRow)).map(
      (row) => ({
        tagName: row.tag_name,
        name: row.name,
        statusesCount: row.statuses_count,
        lastStatusAt: row.last_status_at,
      }),
    ),
  );
