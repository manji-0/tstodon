import type { Context } from "hono";
import { emojiDocument } from "../activitypub";
import { authorizedFetchEnabled } from "../authorized-fetch";
import { customEmojiFromRow, findCustomEmojiRowById } from "../custom-emoji-store";
import { jsonRepositoryError } from "../http";
import { parseInstanceIdentity } from "../runtime-config";

/**
 * `GET /emojis/:id`: an uploaded emoji's ActivityPub document, which the `id`
 * of its `Emoji` tag names, as Mastodon's `EmojisController#show`. It asks
 * for no signature in secure mode either, and is cached for 3 minutes.
 */
export const getEmojisById = async (c: Context<{ Bindings: Env }, "/emojis/:id">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  if (authorizedFetchEnabled(c.env)) {
    c.header("Vary", "Signature");
  }
  const row = await findCustomEmojiRowById(c.env.DB, c.req.param("id"));
  if (row.isErr()) {
    return jsonRepositoryError(c, row.error.message);
  }
  if (row.value === undefined) {
    return c.json({ kind: "NotFound" }, 404);
  }
  const emoji = customEmojiFromRow(row.value, identity.value.mediaPublicBaseUrl);
  c.header("Cache-Control", "max-age=180, public");
  return c.json(emojiDocument(identity.value, emoji), 200, {
    "content-type": "application/activity+json",
  });
};
