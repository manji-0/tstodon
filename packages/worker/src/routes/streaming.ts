import type { Context } from "hono";
import { jsonAuthError, requireUser } from "../http";

/**
 * The streaming API. Each connection gets the account's `user` stream from
 * its `StreamHub`. A browser passes the token as the WebSocket subprotocol
 * (`Sec-WebSocket-Protocol`), which the handshake must echo back.
 */
export const getV1Streaming = async (c: Context<{ Bindings: Env }>) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const stub = c.env.STREAM_HUB.get(c.env.STREAM_HUB.idFromName(user.value.id));
  const upstream = await stub.fetch(c.req.raw);
  const protocol = c.req.header("Sec-WebSocket-Protocol");
  if (upstream.status !== 101 || !protocol || !upstream.webSocket) {
    return upstream;
  }
  return new Response(null, {
    status: 101,
    webSocket: upstream.webSocket,
    headers: { "Sec-WebSocket-Protocol": protocol },
  });
};
