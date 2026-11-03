import type { Context } from "hono";
import { bearerToken } from "../auth";
import { jsonAuthError, requireUser } from "../http";
import {
  hubName,
  requestStreamChannel,
  type SocketState,
  type StreamViewer,
  streamRefusalError,
} from "../stream-access";
import { SOCKET_STATE_HEADER } from "../stream-hub";

/**
 * The streaming API over WebSocket. A socket subscribes to the stream named
 * by `stream` (with `tag` or `list`), and to more with `subscribe` messages,
 * as the web UI does over one shared socket. Without a token a socket may
 * only take public and hashtag streams, which are as open as their
 * timelines. A browser passes the token as the WebSocket subprotocol
 * (`Sec-WebSocket-Protocol`), which the handshake must echo back.
 */
export const getV1Streaming = async (c: Context<{ Bindings: Env }>) => {
  let viewer: StreamViewer = { kind: "Anonymous" };
  if (bearerToken(c.req.raw)) {
    const user = await requireUser(c);
    if (user.isErr()) {
      return jsonAuthError(c, user.error);
    }
    viewer = { kind: "Account", accountId: user.value.id };
  }
  const stream = c.req.query("stream");
  const state: SocketState = { viewer, channels: [] };
  if (stream) {
    const channel = await requestStreamChannel(c.env, viewer, {
      stream,
      tag: c.req.query("tag"),
      list: c.req.query("list"),
    });
    if (channel.isErr()) {
      const refusal = streamRefusalError(channel.error);
      return c.json(refusal, refusal.status);
    }
    state.channels.push(channel.value);
  }
  // Set here, never taken from the client: the hub trusts it.
  const headers = new Headers(c.req.raw.headers);
  headers.set(SOCKET_STATE_HEADER, JSON.stringify(state));
  const stub = c.env.STREAM_HUB.get(c.env.STREAM_HUB.idFromName(hubName(viewer)));
  const upstream = await stub.fetch(new Request(c.req.raw.url, { headers }));
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
