import { SELF, env } from "cloudflare:test";
import {
  StatusId,
  type StatusIdValue,
  StreamChannel,
  type StreamChannelValue,
} from "@tstodon/domain";
import { expect } from "vite-plus/test";
import { ANONYMOUS_HUB } from "../src/stream-access";
import { publishToHub } from "../src/stream-publish";
import { authHeaders, signedInAccount } from "./auth-fixture";

const ORIGIN = "https://example.com";

/** One SSE frame: its `event:` and `data:` lines, or a `:` comment line. */
export type SseFrame = Readonly<
  { kind: "Event"; event: string; data: string } | { kind: "Comment"; text: string }
>;

const parseFrame = (block: string): SseFrame => {
  const lines = block.split("\n");
  if (lines.every((line) => line.startsWith(":"))) {
    return { kind: "Comment", text: lines.map((line) => line.slice(1)).join("\n") };
  }
  const field = (name: string): string =>
    lines
      .filter((line) => line.startsWith(`${name}: `))
      .map((line) => line.slice(name.length + 2))
      .join("\n");
  return { kind: "Event", event: field("event"), data: field("data") };
};

let markers = 0;

const markerId = (): StatusIdValue => {
  markers += 1;
  const id = StatusId.parse(`9${Date.now()}${markers}`);
  if (id.isErr()) {
    throw new Error("marker id rejected");
  }
  return id.value;
};

/**
 * An SSE request for `path` (under `/api/v1/streaming`), signed in as `email`
 * with a token of `scopes` (every scope by default) or anonymous. The token
 * goes in `Authorization`, or in `access_token` with `tokenInQuery`.
 */
export const requestEventStream = async (
  path: string,
  options: Readonly<{
    email?: string;
    scopes?: ReadonlyArray<string>;
    tokenInQuery?: boolean;
  }> = {},
): Promise<Response> => {
  const headers = options.email
    ? await authHeaders(options.email, options.scopes ? { scopes: options.scopes } : {})
    : {};
  if (options.tokenInQuery) {
    const token = headers.Authorization?.replace(/^Bearer /i, "") ?? "";
    const separator = path.includes("?") ? "&" : "?";
    return SELF.fetch(
      `${ORIGIN}/api/v1/streaming${path}${separator}access_token=${encodeURIComponent(token)}`,
    );
  }
  return SELF.fetch(`${ORIGIN}/api/v1/streaming${path}`, { headers });
};

/** An open SSE stream, read one frame at a time; the first `:)` comment is consumed. */
export const openEventStream = async (
  path: string,
  options: Parameters<typeof requestEventStream>[1] = {},
) => {
  const account = options.email ? await signedInAccount(options.email) : undefined;
  const response = await requestEventStream(path, options);
  expect(response.status, path).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("missing event stream body");
  }
  const decoder = new TextDecoder();
  let buffered = "";
  const hub = account?.id ?? ANONYMOUS_HUB;
  const frame = async (timeoutMs = 10_000): Promise<SseFrame> => {
    const timer = setTimeout(() => {
      void reader.cancel();
    }, timeoutMs);
    try {
      for (;;) {
        const end = buffered.indexOf("\n\n");
        if (end >= 0) {
          const block = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          return parseFrame(block);
        }
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error(`${path} stream ended or timed out`);
        }
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      clearTimeout(timer);
    }
  };
  /** The next event, skipping heartbeats. */
  const next = async (): Promise<Extract<SseFrame, { kind: "Event" }>> => {
    for (;;) {
      const heard = await frame();
      if (heard.kind === "Event") {
        return heard;
      }
    }
  };
  const greeting = await frame();
  expect(greeting).toEqual({ kind: "Comment", text: ")" });
  /** Whether `channel` stayed quiet: a marker published to it must be the next event. */
  const heardNothing = async (channel: StreamChannelValue): Promise<boolean> => {
    const marker = markerId();
    await publishToHub(env, hub, {
      channels: [channel],
      event: { kind: "delete", statusId: marker },
    });
    const heard = await next();
    return heard.event === "delete" && heard.data === marker;
  };
  return {
    account,
    hub,
    frame,
    next,
    heardNothing,
    cancel: () => reader.cancel(),
  };
};

/** The channel Mastodon's wire names, for `heardNothing`. */
export const channelOf = (stream: string, tag?: string): StreamChannelValue => {
  const channel = StreamChannel.fromWire({ stream, tag });
  if (channel.isErr()) {
    throw new Error(`unknown stream ${stream}`);
  }
  return channel.value;
};
