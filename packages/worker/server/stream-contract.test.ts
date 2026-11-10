import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiStreamingWireEvent } from "@tstodon/api";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { expectContract } from "../test/api-contract";
import { openEventStream } from "../test/sse-fixture";
import { openStream } from "../test/stream-fixture";
import { publishToAccount } from "./stream-publish";

const ORIGIN = "https://example.com";

const json = async (email: string, path: string, init: RequestInit = {}) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
  });
  expect(response.status, path).toBe(200);
  return response.json();
};

const idOf = (body: unknown): string => z.object({ id: z.string() }).parse(body).id;

/**
 * Every event tstodon sends, as a client receives it, parsed with the
 * streaming contract (`ApiStreamingMessage`, `ApiStreamingWireEvent` in
 * `@tstodon/api`): the payload decoded and checked against its entity.
 */
describe("streaming contract", () => {
  it("describes every event the user and direct streams send", async () => {
    const owner = "sc-owner@example.com";
    const friend = "sc-friend@example.com";
    const [ownerAccount, friendAccount] = await Promise.all([
      signedInAccount(owner),
      signedInAccount(friend),
    ]);
    // Followed, so the friend's private mention is not held as a notification request.
    await json(owner, `/api/v1/accounts/${friendAccount.id}/follow`, {
      method: "POST",
      body: "{}",
    });
    const user = await openStream({ email: owner, query: "?stream=user" });
    const direct = await openStream({ email: owner, query: "?stream=direct" });

    const id = idOf(
      await json(owner, "/api/v1/statuses", {
        method: "POST",
        body: JSON.stringify({ status: "contract check" }),
      }),
    );
    const update = await user.nextDecoded();
    expect(update).toMatchObject({ stream: ["user"], event: "update", payload: { id } });

    await json(owner, `/api/v1/statuses/${id}`, {
      method: "PUT",
      body: JSON.stringify({ status: "contract check, edited" }),
    });
    const edited = await user.nextDecoded();
    expect(edited.event).toBe("status.update");
    expect(edited.event === "status.update" && edited.payload.content).toContain("edited");

    await json(owner, `/api/v1/statuses/${id}`, { method: "DELETE" });
    expect(await user.nextDecoded()).toEqual({ stream: ["user"], event: "delete", payload: id });

    await json(friend, `/api/v1/accounts/${ownerAccount.id}/follow`, {
      method: "POST",
      body: "{}",
    });
    expect(await user.nextDecoded()).toMatchObject({
      event: "notification",
      payload: { type: "follow", account: { acct: "sc_friend" } },
    });

    const message = idOf(
      await json(friend, "/api/v1/statuses", {
        method: "POST",
        body: JSON.stringify({ status: `@${ownerAccount.username} a word`, visibility: "direct" }),
      }),
    );
    expect(await direct.nextDecoded()).toMatchObject({
      stream: ["direct"],
      event: "conversation",
      payload: { unread: true, last_status: { id: message } },
    });
    expect(await user.nextDecoded()).toMatchObject({
      event: "notification",
      payload: { type: "mention", status: { id: message } },
    });

    // What `POST /api/v1/notifications/requests/:id/accept` publishes
    // (`notification-policy.test.ts` covers when it is sent).
    await publishToAccount(env, ownerAccount.id, { kind: "notifications_merged" });
    expect(await user.nextDecoded()).toEqual({
      stream: ["user"],
      event: "notifications_merged",
      payload: "1",
    });
    user.close();
    direct.close();
  });

  it("describes the same events as SSE frames", async () => {
    const owner = "sc-sse-owner@example.com";
    const stream = await openEventStream("/user", { email: owner });
    const id = idOf(
      await json(owner, "/api/v1/statuses", {
        method: "POST",
        body: JSON.stringify({ status: "contract check over SSE" }),
      }),
    );
    const frame = await stream.next();
    const decoded = expectContract(ApiStreamingWireEvent, {
      event: frame.event,
      payload: frame.data,
    });
    expect(decoded).toMatchObject({ event: "update", payload: { id } });
    await json(owner, `/api/v1/statuses/${id}`, { method: "DELETE" });
    expect(await stream.next()).toMatchObject({ event: "delete", data: id });
    await stream.cancel();
  });
});
