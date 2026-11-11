import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  LOCAL_ACCESS_JWKS,
  LOCAL_ACCESS_PUBLIC_JWK,
  signAccessJwt,
} from "../test/access-jwt-fixture";
import { envWith } from "../test/env-fixture";
import { accessIdentity, forgetAccessJwks } from "./access-jwt";

const EMAIL = "jwks@example.com";
/** The fixture's key under another `kid`, as a set Access has since rotated away from. */
const ROTATED_OUT_JWKS = { keys: [{ ...LOCAL_ACCESS_PUBLIC_JWK, kid: "rotated-out" }] };

let urlCount = 0;
/** An env that fetches its keys from a URL of its own, so tests share no cache. */
const remoteEnv = (): Readonly<{ env: Env; url: string }> => {
  urlCount += 1;
  const url = `https://jwks-${urlCount}.example/cdn-cgi/access/certs`;
  return { env: envWith({ CF_ACCESS_JWKS_JSON: "", CF_ACCESS_JWKS_URL: url }), url };
};

const jwksResponse = (jwks: unknown): Response =>
  new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json" } });

/** Answer each fetch with the next of `answers`, then with the last one. */
const stubFetch = (...answers: ReadonlyArray<() => Promise<Response>>) => {
  let calls = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    const answer = answers[Math.min(calls, answers.length - 1)];
    calls += 1;
    return answer === undefined ? Promise.reject(new Error("no answer")) : answer();
  });
};

const keysAnswer = (jwks: unknown) => () => Promise.resolve(jwksResponse(jwks));

beforeEach(() => {
  forgetAccessJwks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("accessIdentity with fetched keys", () => {
  it("does not make a request wait on another request's key fetch", async () => {
    // jose's remote set shares one reload in flight between callers unless it
    // detects Workers from these globals. Hide them, so this would hang if a
    // request still awaited a fetch another request started.
    vi.stubGlobal("WebSocketPair", undefined);
    vi.stubGlobal("navigator", { userAgent: "not-workers" });
    const { env } = remoteEnv();
    // A fetch that never settles, as one does when workerd cancels the
    // request that started it (its client went away).
    const fetchSpy = stubFetch(
      () => new Promise<Response>(() => undefined),
      keysAnswer(LOCAL_ACCESS_JWKS),
    );
    const token = await signAccessJwt({ email: EMAIL });

    void accessIdentity(token, env, "localhost");
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const other = await accessIdentity(token, env, "localhost");
    expect(other.isOk() && other.value.email).toBe(EMAIL);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("reuses fetched keys until they are stale", async () => {
    const { env, url } = remoteEnv();
    const fetchSpy = stubFetch(keysAnswer(LOCAL_ACCESS_JWKS));
    const token = await signAccessJwt({ email: EMAIL });

    expect((await accessIdentity(token, env, "localhost", 1_000)).isOk()).toBe(true);
    expect((await accessIdentity(token, env, "localhost", 300_000)).isOk()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(url);

    // Ten minutes after the load.
    expect((await accessIdentity(token, env, "localhost", 601_000)).isOk()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("refetches once for an unknown kid, then waits out the cooldown", async () => {
    const { env } = remoteEnv();
    const fetchSpy = stubFetch(
      keysAnswer(ROTATED_OUT_JWKS),
      () => Promise.resolve(new Response("unavailable", { status: 503 })),
      keysAnswer(LOCAL_ACCESS_JWKS),
    );
    const token = await signAccessJwt({ email: EMAIL });

    // This request just fetched the set, so it does not fetch it again.
    expect((await accessIdentity(token, env, "localhost", 0))._unsafeUnwrapErr()).toEqual({
      kind: "InvalidToken",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Within 30 s of the load: no refetch.
    expect((await accessIdentity(token, env, "localhost", 10_000))._unsafeUnwrapErr()).toEqual({
      kind: "InvalidToken",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // After it: one refetch, which fails here.
    expect((await accessIdentity(token, env, "localhost", 40_000))._unsafeUnwrapErr()).toEqual({
      kind: "VerificationUnavailable",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Within 30 s of that refetch: none, though no set has loaded since.
    expect((await accessIdentity(token, env, "localhost", 50_000))._unsafeUnwrapErr()).toEqual({
      kind: "InvalidToken",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // After it: the rotated set has the key, and is kept.
    expect((await accessIdentity(token, env, "localhost", 75_000)).isOk()).toBe(true);
    expect((await accessIdentity(token, env, "localhost", 80_000)).isOk()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("is unavailable, not an invalid token, when the keys cannot be fetched", async () => {
    const token = await signAccessJwt({ email: EMAIL });
    const failures: ReadonlyArray<() => Promise<Response>> = [
      () => Promise.reject(new TypeError("Network connection lost")),
      () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
      () => Promise.resolve(new Response("unavailable", { status: 503 })),
      () => Promise.resolve(new Response("not json")),
      () => Promise.resolve(jwksResponse({ keys: [] })),
    ];
    for (const failure of failures) {
      const { env } = remoteEnv();
      stubFetch(failure);
      expect((await accessIdentity(token, env, "localhost"))._unsafeUnwrapErr()).toEqual({
        kind: "VerificationUnavailable",
      });
      vi.restoreAllMocks();
    }
  });

  it("does not let an older fetch replace keys a newer one loaded", async () => {
    const { env } = remoteEnv();
    let finishOld: () => void = () => undefined;
    const fetchSpy = stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          finishOld = () => resolve(jwksResponse(ROTATED_OUT_JWKS));
        }),
      keysAnswer(LOCAL_ACCESS_JWKS),
    );
    const token = await signAccessJwt({ email: EMAIL });

    const older = accessIdentity(token, env, "localhost", 1_000);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect((await accessIdentity(token, env, "localhost", 1_000)).isOk()).toBe(true);
    finishOld();
    await older;

    expect((await accessIdentity(token, env, "localhost", 2_000)).isOk()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
