import { SELF, env } from "cloudflare:test";
import { schemaResult } from "@tstodon/core";
import {
  StatusId,
  type StatusIdValue,
  StreamChannel,
  type StreamChannelValue,
} from "@tstodon/domain";
import { expect } from "vite-plus/test";
import { z } from "zod";
import { ANONYMOUS_HUB } from "../src/stream-access";
import { publishToHub } from "../src/stream-publish";
import { authHeaders, signedInAccount } from "./auth-fixture";

const ORIGIN = "https://example.com";

const EventSchema = z.object({
  stream: z.array(z.string()),
  event: z.string(),
  payload: z.string(),
});

const ErrorSchema = z.object({ error: z.string(), status: z.number() });

const MessageSchema = z.union([EventSchema, ErrorSchema]);

export type Heard = z.infer<typeof EventSchema>;

type Message = z.infer<typeof MessageSchema>;

type StreamCommand = Readonly<{ stream: string; tag?: string; list?: string }>;

const parseMessage = (raw: unknown): Message => {
  const parsed = schemaResult(MessageSchema)(typeof raw === "string" ? JSON.parse(raw) : raw);
  if (parsed.isErr()) {
    throw new Error("stream message rejected");
  }
  return parsed.value;
};

let markers = 0;

/** A status id nobody posts, for probing a socket. */
const markerId = (): StatusIdValue => {
  markers += 1;
  const id = StatusId.parse(`9${Date.now()}${markers}`);
  if (id.isErr()) {
    throw new Error("marker id rejected");
  }
  return id.value;
};

const channelOf = (command: StreamCommand): StreamChannelValue => {
  const channel = StreamChannel.fromWire(command);
  if (channel.isErr()) {
    throw new Error(`unknown stream ${command.stream}`);
  }
  return channel.value;
};

/**
 * A streaming socket, signed in as `email` or anonymous, opened at
 * `/api/v1/streaming` with `query`, and read one message at a time.
 */
export const openStream = async (options: Readonly<{ email?: string; query?: string }>) => {
  const account = options.email ? await signedInAccount(options.email) : undefined;
  const upgrade = await SELF.fetch(`${ORIGIN}/api/v1/streaming${options.query ?? ""}`, {
    headers: {
      ...(options.email ? await authHeaders(options.email) : {}),
      Upgrade: "websocket",
    },
  });
  expect(upgrade.status).toBe(101);
  const socket = upgrade.webSocket;
  if (!socket) {
    throw new Error("missing websocket");
  }
  socket.accept();
  const hub = account?.id ?? ANONYMOUS_HUB;
  const label = options.email ?? "anonymous";
  const probes = new Set<string>();
  let probeHeard = false;
  const heard: Message[] = [];
  const waiting: ((message: Message) => void)[] = [];
  socket.addEventListener("message", (message) => {
    const parsed = parseMessage(message.data);
    if ("event" in parsed && parsed.event === "delete" && probes.has(parsed.payload)) {
      probeHeard = true;
      return;
    }
    const waiter = waiting.shift();
    if (waiter) {
      waiter(parsed);
    } else {
      heard.push(parsed);
    }
  });
  const nextMessage = (): Promise<Message> => {
    const queued = heard.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} heard nothing`)), 10_000);
      waiting.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  };
  /** The next event; an error message fails the test. */
  const next = async (): Promise<Heard> => {
    const message = await nextMessage();
    if (!("event" in message)) {
      throw new Error(`${label} was refused: ${message.error}`);
    }
    return message;
  };
  /** The next message, which must be a streaming error. */
  const nextError = async (): Promise<z.infer<typeof ErrorSchema>> => {
    const message = await nextMessage();
    if ("event" in message) {
      throw new Error(`${label} heard ${message.event} instead of an error`);
    }
    return message;
  };
  /**
   * Whether `channel` stayed quiet until now: a marker published to it after
   * the events under test have reached others must be the next thing heard.
   */
  const heardNothing = async (channel: StreamChannelValue = { kind: "User" }): Promise<boolean> => {
    const marker = markerId();
    await publishToHub(env, hub, {
      channels: [channel],
      event: { kind: "delete", statusId: marker },
    });
    const first = await next();
    return first.event === "delete" && first.payload === marker;
  };
  /** Subscribe with a message, and wait until the hub has taken it. */
  const subscribe = async (command: StreamCommand): Promise<void> => {
    socket.send(JSON.stringify({ type: "subscribe", ...command }));
    const channel = channelOf(command);
    probeHeard = false;
    for (let attempt = 0; attempt < 100 && !probeHeard; attempt += 1) {
      const marker = markerId();
      probes.add(marker);
      await publishToHub(env, hub, {
        channels: [channel],
        event: { kind: "delete", statusId: marker },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(probeHeard, `${label} subscribed to ${command.stream}`).toBe(true);
  };
  /**
   * Unsubscribe. A later subscription the hub has taken proves it handled
   * this one; that subscription's channel comes back for `heardNothing`.
   */
  const unsubscribe = async (command: StreamCommand): Promise<StreamChannelValue> => {
    socket.send(JSON.stringify({ type: "unsubscribe", ...command }));
    const barrier = { stream: "hashtag", tag: `barrier${markerId()}` };
    await subscribe(barrier);
    return channelOf(barrier);
  };
  return {
    account,
    next,
    nextError,
    heardNothing,
    subscribe,
    unsubscribe,
    send: (message: unknown) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  };
};
