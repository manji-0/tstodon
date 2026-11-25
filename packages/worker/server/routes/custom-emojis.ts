import type { Context } from "hono";
import { customEmojiJson } from "../emoji";
import { loadCustomEmojis } from "../custom-emoji-store";
import { isLimitedFederation, parseInstanceIdentity } from "../runtime-config";

/**
 * `GET /api/v1/custom_emojis`: `CustomEmoji.listed`, the enabled local emoji
 * shown in the picker. An emoji hidden from the picker still renders on
 * posts and profiles. As `cache_even_if_authenticated!`, the answer is public
 * for five minutes unless federation is limited.
 */
export const getV1CustomEmojis = async (c: Context<{ Bindings: Env }, "/api/v1/custom_emojis">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const emojis = await loadCustomEmojis(c.env, identity.value.mediaPublicBaseUrl);
  if (!(await isLimitedFederation(c.env))) {
    c.header(
      "Cache-Control",
      "max-age=300, public, stale-while-revalidate=30, stale-if-error=86400",
    );
  }
  return c.json(emojis.filter((emoji) => emoji.visible_in_picker).map(customEmojiJson));
};
