import { StreamChannel } from "@tstodon/domain";
import type { Context } from "hono";
import { bearerToken } from "../auth";
import { jsonAuthError, requireSession } from "../http";
import {
  requestStreamChannel,
  type SocketState,
  streamAccess,
  streamRefusalError,
} from "../stream-access";
import { eventStreamResponse } from "../sse-bridge";
import { EVENT_STREAM_HEADER, SOCKET_STATE_HEADER } from "../stream-hub";

/**
 * The streaming API over WebSocket. A socket subscribes to the stream named
 * by `stream` (with `tag` or `list`), and to more with `subscribe` messages,
 * as the web UI does over one shared socket. As in Mastodon 4.2 and later,
 * every stream needs a user's token: a request without one is refused
 * before its stream is read. Each stream also needs the scope Mastodon asks
 * for it (see `streamAccess`), checked here and on each `subscribe`. A
 * browser passes the token as the WebSocket subprotocol
 * (`Sec-WebSocket-Protocol`), which the handshake must echo back.
 *
 * A request without an upgrade is Mastodon's SSE form: the path names the one
 * stream (`/api/v1/streaming/user`, `/public/local`, `/hashtag?tag=`, ...) and
 * the response is a `text/event-stream` this request writes from a socket to
 * the hub (see `eventStreamResponse`). The same token and scope rules apply;
 * only `/api/v1/streaming/health` answers anyone.
 */
export const getV1Streaming = async (c: Context<{ Bindings: Env }>) => {
  const subPath = c.req.path.replace(/^\/api\/v1\/streaming\/?/, "");
  const isUpgrade = c.req.header("Upgrade") === "websocket";
  if (!isUpgrade && subPath.replace(/\/+$/, "") === "health") {
    return c.text("OK");
  }
  if (!bearerToken(c.req.raw)) {
    return c.json({ error: "Missing access token", status: 401 }, 401);
  }
  const session = await requireSession(c);
  if (session.isErr()) {
    return jsonAuthError(c, session.error);
  }
  const accountId = session.value.account.id;
  const access = streamAccess(session.value.token.scopes);
  const pathStream = StreamChannel.streamFromPath(subPath, c.req.query("only_media") === "true");
  if (!isUpgrade && pathStream === undefined) {
    return subPath === "" ? c.text("Expected WebSocket", 426) : c.json({ error: "Not found" }, 404);
  }
  const stream = pathStream ?? c.req.query("stream");
  const state: SocketState = { accountId, access, channels: [] };
  if (stream) {
    const channel = await requestStreamChannel(c.env, accountId, access, {
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
  // Set here, never taken from the client: the hub trusts them.
  const headers = new Headers(c.req.raw.headers);
  headers.set(SOCKET_STATE_HEADER, JSON.stringify(state));
  headers.set("Upgrade", "websocket");
  if (isUpgrade) {
    headers.delete(EVENT_STREAM_HEADER);
  } else {
    headers.set(EVENT_STREAM_HEADER, "1");
  }
  const stub = c.env.STREAM_HUB.get(c.env.STREAM_HUB.idFromName(accountId));
  const upstream = await stub.fetch(new Request(c.req.raw.url, { headers }));
  if (!isUpgrade) {
    if (upstream.status !== 101 || !upstream.webSocket) {
      // The hub's response has immutable headers; middleware may add to these.
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    }
    return eventStreamResponse(upstream.webSocket);
  }
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
