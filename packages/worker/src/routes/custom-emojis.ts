import { Hono } from "hono";
import { customEmojiJson } from "../emoji";
import { loadCustomEmojis } from "../custom-emoji-store";
import { parseInstanceIdentity } from "../runtime-config";

export const customEmojiRoutes = new Hono<{ Bindings: Env }>();

customEmojiRoutes.get("/api/v1/custom_emojis", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const emojis = await loadCustomEmojis(c.env, identity.value.mediaPublicBaseUrl);
  return c.json(emojis.map(customEmojiJson));
});
