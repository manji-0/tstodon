import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { readBodyBytes } from "./body-limit";
import { fetchActivityJson, fetchWebfinger, unsignedFetch } from "./federated-fetch";
import { parseInstanceIdentity } from "./runtime-config";
import { authHeaders } from "../test/auth-fixture";

const MB = 1024 * 1024;

/**
 * A body of `totalBytes` with no declared length, as a chunked upload sends
 * it, counting the bytes the reader pulled.
 */
const chunkedBody = (totalBytes: number, chunkBytes = 64 * 1024) => {
  const pulled = { bytes: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled.bytes >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - pulled.bytes);
      pulled.bytes += size;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
  });
  return { stream, pulled };
};

describe("readBodyBytes", () => {
  it("reads a body within the cap", async () => {
    const read = await readBodyBytes(new Response("hello"), 5);
    expect(read.isOk() && new TextDecoder().decode(read.value)).toBe("hello");
  });

  it("refuses a declared Content-Length over the cap without reading the body", async () => {
    const { stream, pulled } = chunkedBody(10 * MB);
    const response = new Response(stream, { headers: { "content-length": String(10 * MB) } });
    const read = await readBodyBytes(response, MB);
    expect(read.isErr() && read.error).toEqual({ kind: "BodyTooLarge", limitBytes: MB });
    expect(pulled.bytes).toBeLessThanOrEqual(64 * 1024);
  });

  it("stops reading a chunked body once it passes the cap", async () => {
    const { stream, pulled } = chunkedBody(1024 * MB);
    const read = await readBodyBytes(new Response(stream), MB);
    expect(read.isErr()).toBe(true);
    expect(pulled.bytes).toBeLessThan(2 * MB);
  });
});

const chunkedRequest = async (
  path: string,
  totalBytes: number,
  headers: Record<string, string>,
  method = "POST",
) => {
  const { stream } = chunkedBody(totalBytes);
  return SELF.fetch(`https://example.com${path}`, { method, headers, body: stream });
};

describe("request body caps", () => {
  it("answers 413 to a declared Content-Length over 1 MB before the handler runs", async () => {
    const response = await SELF.fetch("https://example.com/api/v1/statuses", {
      method: "POST",
      headers: {
        ...(await authHeaders("body-limit-declared@example.com")),
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "x".repeat(2 * MB) }),
    });
    expect(response.status).toBe(413);
  });

  it("still reads a chunked body within its cap", async () => {
    const { stream } = chunkedBody(1024);
    const response = await SELF.fetch("https://example.com/inbox", {
      method: "POST",
      headers: { "content-type": "application/activity+json" },
      body: stream,
    });
    // 1 KB of spaces is not an activity: refused as such, not as too large.
    expect(response.status).toBe(400);
  });

  it("answers 413 to an inbox delivery over 1 MB, before any signature check", async () => {
    const response = await chunkedRequest("/inbox", MB + 1, {
      "content-type": "application/activity+json",
    });
    expect(response.status).toBe(413);
  });

  it("answers 413 to a JSON API body over 1 MB", async () => {
    const response = await chunkedRequest("/api/v1/statuses", MB + 1, {
      ...(await authHeaders("body-limit-json@example.com")),
      "content-type": "application/json",
    });
    expect(response.status).toBe(413);
  });

  it("answers 413 to a media upload over the largest upload limit", async () => {
    const response = await chunkedRequest("/api/v2/media", 100 * MB, {
      ...(await authHeaders("body-limit-media@example.com")),
      "content-type": "multipart/form-data; boundary=x",
    });
    expect(response.status).toBe(413);
  });

  it("answers 413 to profile images over twice their limit", async () => {
    const response = await chunkedRequest(
      "/api/v1/accounts/update_credentials",
      11 * MB,
      {
        ...(await authHeaders("body-limit-profile@example.com")),
        "content-type": "multipart/form-data; boundary=x",
      },
      "PATCH",
    );
    expect(response.status).toBe(413);
  });

  it("answers 413 to a custom emoji upload over its limit", async () => {
    const response = await chunkedRequest("/api/v1/admin/custom_emojis", MB, {
      ...(await authHeaders("body-limit-emoji@example.com", { admin: true })),
      "content-type": "multipart/form-data; boundary=x",
    });
    expect(response.status).toBe(413);
  });
});

/** A JSON document of about `totalBytes`, streamed with no declared length. */
const largeDocument = (
  totalBytes: number,
  prefix = '{"id":"https://remote.example/big","pad":"',
) => {
  const head = new TextEncoder().encode(prefix);
  const tail = new TextEncoder().encode('"}');
  const { stream, pulled } = chunkedBody(totalBytes);
  let started = false;
  const body = stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!started) {
          started = true;
          controller.enqueue(head);
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        controller.enqueue(tail);
      },
    }),
  );
  return { body, pulled };
};

describe("fetched document caps", () => {
  const identity = () => parseInstanceIdentity(env)._unsafeUnwrap();

  it("refuses an ActivityPub document over 1 MB, and stops reading it", async () => {
    const { body, pulled } = largeDocument(8 * MB);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(body, { status: 200 }));
    try {
      const fetched = await fetchActivityJson(identity(), "https://remote.example/big", {
        fetchSigner: unsignedFetch,
      });
      expect(fetched.isErr() && fetched.error.kind).toBe("InvalidSignature");
      expect(pulled.bytes).toBeLessThan(2 * MB);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("refuses a WebFinger answer over 1 MB", async () => {
    const { body } = largeDocument(
      2 * MB,
      '{"subject":"acct:big@remote.example","links":[{"rel":"self","type":"application/activity+json","href":"https://remote.example/users/big"}],"pad":"',
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(body, { status: 200 }));
    try {
      const answer = await fetchWebfinger(identity(), "big@remote.example");
      expect(answer.isErr() && answer.error.kind).toBe("InvalidSignature");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
