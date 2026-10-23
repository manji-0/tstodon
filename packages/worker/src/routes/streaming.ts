import type { Context } from "hono";
import { jsonAuthError, requireUser } from "../http";

export const getV1Streaming = async (c: Context<{ Bindings: Env }, "/api/v1/streaming">) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const stub = c.env.STREAM_HUB.get(c.env.STREAM_HUB.idFromName(user.value.id));
  return stub.fetch(c.req.raw);
};
