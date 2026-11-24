import { RemoteActor, type RemoteEmoji, type RemoteStatusValue } from "@tstodon/domain";
import { mediaRejectedDomains } from "./admin-domain-block-store";
import { runD1 } from "./d1";
import { declaredEmojis } from "./remote-emoji-document";
import { remoteStatusEmojiTexts } from "./remote-status-document";

/**
 * The custom emoji of a remote server, as Mastodon v4.7.5 stores them: one
 * `CustomEmoji` per shortcode and account domain, which every post and
 * profile of the domain renders with (`CustomEmoji.from_text`, read when they
 * are rendered: `remote-emoji-catalog.ts`). `process_emoji` (`Create`,
 * `ProcessStatusUpdateService#update_emojis!`, `ProcessAccountService`)
 * stores each `Emoji` tag a note or an actor declares, used or not, fetches
 * the image again when a tag names another URL than the stored one, and
 * skips a domain whose media is rejected (`skip_download?`).
 *
 * `remote_custom_emojis` holds the image last read for each. A document that
 * names another image replaces it unless it is dated before the stored one,
 * so a late or retried delivery does not bring back a replaced image
 * (Mastodon keeps its stored file when the new one does not download). An
 * admin's `disabled` is kept.
 */

/**
 * Store the images `actor`'s note or profile declares for its domain's
 * emoji. A tag without `updated` is dated `dated`. Best effort, as the
 * document is stored already: a failure is logged.
 */
const recordRemoteEmojiImages = async (
  db: D1Database,
  actor: RemoteActor,
  declared: ReadonlyArray<RemoteEmoji>,
  dated: string,
): Promise<void> => {
  if (declared.length === 0 || RemoteActor.onAnyHost(actor, await mediaRejectedDomains(db))) {
    return;
  }
  const recorded = await runD1(async () => {
    await db
      .prepare(
        `INSERT INTO remote_custom_emojis (domain, shortcode, image_url, updated_at)
         SELECT a.domain, json_extract(e.value, '$.shortcode'), json_extract(e.value, '$.url'),
           coalesce(json_extract(e.value, '$.updated'), ?3)
         FROM remote_actors a, json_each(?2) e WHERE a.actor_uri = ?1
         ON CONFLICT (domain, shortcode) DO UPDATE SET
           image_url = excluded.image_url,
           updated_at = excluded.updated_at
         WHERE excluded.image_url IS NOT image_url AND excluded.updated_at >= updated_at`,
      )
      .bind(actor.actorUri, JSON.stringify(declared), dated)
      .run();
  });
  if (recorded.isErr()) {
    console.error(
      JSON.stringify({
        kind: "RemoteEmojisNotRecorded",
        actorUri: actor.actorUri,
        error: recorded.error.message,
      }),
    );
  }
};

/**
 * {@link recordRemoteEmojiImages} for the note `raw` that `actor` wrote,
 * stored as `status`. A tag without `updated` is dated as the note's last
 * edit, else its publication.
 */
export const recordNoteEmojis = (
  db: D1Database,
  actor: RemoteActor,
  raw: unknown,
  status: Pick<
    RemoteStatusValue,
    "publishedAt" | "editedAt" | "spoilerText" | "contentHtml" | "poll"
  >,
): Promise<void> =>
  recordRemoteEmojiImages(
    db,
    actor,
    declaredEmojis(raw, remoteStatusEmojiTexts(status)),
    status.editedAt.kind === "Edited" ? status.editedAt.at : status.publishedAt,
  );

/**
 * {@link recordRemoteEmojiImages} for the emoji `actor`'s document declares,
 * as it was just read, by a fetch or from its own `Update`, as
 * `ProcessAccountService#process_emojis` on every fetch of an account. A tag
 * without `updated` is dated as the fetch.
 */
export const recordProfileEmojis = (
  db: D1Database,
  actor: RemoteActor,
  declared: ReadonlyArray<RemoteEmoji>,
): Promise<void> => recordRemoteEmojiImages(db, actor, declared, actor.fetchedAt);
