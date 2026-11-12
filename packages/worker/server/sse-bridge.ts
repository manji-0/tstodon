/** Mastodon sends a `:thump` comment this often so proxies keep an idle connection open. */
export const SSE_HEARTBEAT_MS = 15_000;

/** Frames queued for a client that stopped reading before its connection is dropped. */
const MAX_SSE_BACKLOG = 256;

/**
 * Mastodon's SSE response over a hub socket that carries ready SSE frames.
 * The Worker, not the hub, holds the open response and its heartbeat, so the
 * hub hibernates between events as it does for WebSocket clients. The
 * response ends when the hub closes the socket, and the socket closes when
 * the client goes, which lets the hub drop the stream's subscription rows.
 */
export const eventStreamResponse = (socket: WebSocket): Response => {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let open = true;
  const finish = (): void => {
    if (!open) {
      return;
    }
    open = false;
    clearInterval(heartbeat);
    try {
      socket.close(1000, "event stream closed");
    } catch {
      // Already closed by the hub.
    }
  };
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const end = (): void => {
        finish();
        try {
          controller.close();
        } catch {
          // The client already cancelled the stream.
        }
      };
      const write = (text: string): void => {
        if (!open) {
          return;
        }
        if ((controller.desiredSize ?? 0) < -MAX_SSE_BACKLOG) {
          end();
          return;
        }
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          end();
        }
      };
      socket.addEventListener("message", (message) => {
        if (typeof message.data === "string") {
          write(message.data);
        }
      });
      socket.addEventListener("close", end);
      socket.addEventListener("error", end);
      socket.accept();
      heartbeat = setInterval(() => write(":thump\n\n"), SSE_HEARTBEAT_MS);
      write(":)\n\n");
    },
    cancel: finish,
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
};
