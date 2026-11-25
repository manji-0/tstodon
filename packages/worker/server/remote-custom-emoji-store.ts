import type { Hostname } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { parseRows, runD1, type RepositoryError } from "./d1";

/**
 * The admin's side of the remote custom emoji (`remote_custom_emojis`), as
 * Mastodon v4.7.5's `/admin/custom_emojis` lists and changes them:
 * `CustomEmojiFilter` with `remote` or `by_domain` and `shortcode`, in
 * `CustomEmoji.alphabetic` order (domain, then shortcode), and the batch
 * `enable`, `disable`, `copy` and `delete` actions (`Form::CustomEmojiBatch`).
 */

/** One remote emoji, named by its account domain and its shortcode as written. */
export type RemoteEmojiKey = Readonly<{ domain: string; shortcode: string }>;

export type RemoteEmojiEntry = RemoteEmojiKey & Readonly<{ imageUrl: string; disabled: boolean }>;

/** `by_domain` (the account domain, as written) and `shortcode` (a part of it). */
export type RemoteEmojiFilter = Readonly<{ domain: string; shortcode: string }>;

/** Kaminari's default page, which Mastodon's list uses. */
export const REMOTE_EMOJI_PAGE = 25;

/** The most a batch changes at once; a page lists far fewer. */
const MAX_BATCH = 100;

const Row = z.object({
  domain: z.string(),
  shortcode: z.string(),
  image_url: z.string(),
  disabled: z.number(),
});

const entryOf = (row: z.infer<typeof Row>): RemoteEmojiEntry => ({
  domain: row.domain,
  shortcode: row.shortcode,
  imageUrl: row.image_url,
  disabled: row.disabled !== 0,
});

const COLUMNS = "SELECT domain, shortcode, image_url, disabled FROM remote_custom_emojis";
const MATCHES = "(?3 IS NULL OR shortcode LIKE ?3 ESCAPE '\\')";

/** A page of every domain's emoji after `(?1, ?2)`, `?3` a shortcode pattern, `?4` rows. */
export const REMOTE_EMOJI_PAGE_SQL = `${COLUMNS} WHERE (domain, shortcode) > (?1, ?2) AND ${MATCHES}
  ORDER BY domain, shortcode LIMIT ?4`;

/** A page of domain `?1`'s emoji after shortcode `?2`, `?3` a shortcode pattern, `?4` rows. */
export const REMOTE_EMOJI_DOMAIN_PAGE_SQL = `${COLUMNS} WHERE domain = ?1 AND shortcode > ?2 AND ${MATCHES}
  ORDER BY shortcode LIMIT ?4`;

/** `value` as a `LIKE` pattern that matches it anywhere, as `sanitize_sql_like`. */
const containing = (value: string): string => `%${value.replace(/[\\%_]/g, "\\$&")}%`;

/**
 * The remote emoji `filter` lists after `after` (from the start when
 * undefined), a page of {@link REMOTE_EMOJI_PAGE}, and the key the next page
 * starts after when there is one. Each page walks the primary key from
 * `after`: within the domain when `filter` names one.
 */
export const pageRemoteCustomEmojis = (
  db: D1Database,
  filter: RemoteEmojiFilter,
  after: RemoteEmojiKey | undefined,
): Promise<
  Result<
    Readonly<{ entries: ReadonlyArray<RemoteEmojiEntry>; next: RemoteEmojiKey | undefined }>,
    RepositoryError
  >
> =>
  runD1(async () => {
    const pattern = filter.shortcode === "" ? null : containing(filter.shortcode);
    const statement =
      filter.domain === ""
        ? db
            .prepare(REMOTE_EMOJI_PAGE_SQL)
            .bind(after?.domain ?? "", after?.shortcode ?? "", pattern, REMOTE_EMOJI_PAGE + 1)
        : db
            .prepare(REMOTE_EMOJI_DOMAIN_PAGE_SQL)
            .bind(
              filter.domain,
              after?.domain === filter.domain ? after.shortcode : "",
              pattern,
              REMOTE_EMOJI_PAGE + 1,
            );
    const rows = parseRows(Row, (await statement.all()).results);
    const entries = rows.slice(0, REMOTE_EMOJI_PAGE).map(entryOf);
    const last = entries.at(-1);
    return {
      entries,
      next:
        rows.length > REMOTE_EMOJI_PAGE && last !== undefined
          ? { domain: last.domain, shortcode: last.shortcode }
          : undefined,
    };
  });

/** The rows `?1` names, a JSON array of `[domain, shortcode]` pairs. */
const NAMED = `(domain, shortcode) IN (
  SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?1)
)`;

/** `keys` as {@link NAMED} binds them, the first {@link MAX_BATCH}. */
const namedKeys = (keys: ReadonlyArray<RemoteEmojiKey>): string =>
  JSON.stringify(keys.slice(0, MAX_BATCH).map((key) => [key.domain, key.shortcode]));

/**
 * Disable or enable the remote emoji `keys` names, as `disable!` and
 * `enable!` set `disabled`; one that is not held is skipped.
 */
export const setRemoteCustomEmojisDisabled = (
  db: D1Database,
  keys: ReadonlyArray<RemoteEmojiKey>,
  disabled: boolean,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(`UPDATE remote_custom_emojis SET disabled = ?2 WHERE ${NAMED}`)
      .bind(namedKeys(keys), disabled ? 1 : 0)
      .run();
  });

/** The remote emoji `keys` names that are held, as `Form::CustomEmojiBatch#custom_emojis` finds them. */
export const findRemoteCustomEmojis = (
  db: D1Database,
  keys: ReadonlyArray<RemoteEmojiKey>,
): Promise<Result<ReadonlyArray<RemoteEmojiEntry>, RepositoryError>> =>
  runD1(async () =>
    parseRows(
      Row,
      (await db.prepare(`${COLUMNS} WHERE ${NAMED}`).bind(namedKeys(keys)).all()).results,
    ).map(entryOf),
  );

/**
 * Delete the remote emoji `keys` names, as `delete!` destroys them. A post or
 * profile that writes one shows its shortcode as text, since emoji are read
 * when they are rendered, until a document that declares it stores it again.
 */
export const deleteRemoteCustomEmojis = (
  db: D1Database,
  keys: ReadonlyArray<RemoteEmojiKey>,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db.prepare(`DELETE FROM remote_custom_emojis WHERE ${NAMED}`).bind(namedKeys(keys)).run();
  });

/**
 * Delete the emoji of `host` and its subdomains, as Mastodon's
 * `ClearDomainMediaService#clear_emojos!` (a block that rejects media) and
 * `PurgeCustomEmojiWorker` (a suspension) delete them
 * (`CustomEmoji.by_domain_and_subdomains`).
 */
export const deleteRemoteCustomEmojisOfDomain = (
  db: D1Database,
  host: Hostname,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `DELETE FROM remote_custom_emojis
         WHERE domain = ?1 OR substr(domain, -length(?1) - 1) = '.' || ?1`,
      )
      .bind(host)
      .run();
  });
