import { DurableObject } from "cloudflare:workers";
import { StreamEvent } from "@tstodon/domain";

export class StreamHub extends DurableObject<Env> {
  async publish(raw: unknown): Promise<void> {
    const parsed = StreamEvent.parse(raw);
    if (parsed.isErr()) {
      return;
    }
    const payload = JSON.stringify(parsed.value);
    for (const socket of this.ctx.getWebSockets()) {
      socket.send(payload);
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}
