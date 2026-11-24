import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { withQueueDrained } from "../test/queue-hold";
import { parseRows } from "./d1";

/**
 * As Mastodon's `UpdateStatusService`, which runs
 * `FanOutOnWriteService#notify_about_update!`: every local account that
 * boosted an edited local post gets an `update` notification, and only the
 * latest one (`LocalNotificationWorker` deletes the older ones first).
 */

const IdSchema = z.object({ id: z.string() });

const call = async (
  email: string,
  method: "POST" | "PUT",
  path: string,
  body: Record<string, unknown> = {},
): Promise<string> => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  const parsed = schemaResult(IdSchema)(await response.json());
  expect(response.status).toBe(200);
  if (parsed.isErr()) {
    throw new Error(`${method} ${path} answered no id`);
  }
  return parsed.value.id;
};

const updates = async (statusId: string) =>
  parseRows(
    z.object({ id: z.string(), account_id: z.string(), from_account_id: z.string() }),
    (
      await env.DB.prepare(
        "SELECT id, account_id, from_account_id FROM notifications WHERE status_id = ? AND kind = 'update'",
      )
        .bind(statusId)
        .all()
    ).results,
  );

describe("update notifications of an edited local post", () => {
  it("reach each local booster once, for the latest edit, and not the author", async () => {
    const authorEmail = "lnb-author@example.com";
    const boosterEmail = "lnb-booster@example.com";
    const author = await signedInAccount(authorEmail);
    const booster = await signedInAccount(boosterEmail);
    await signedInAccount("lnb-bystander@example.com");
    const statusId = await call(authorEmail, "POST", "/api/v1/statuses", { status: "v1" });
    await call(boosterEmail, "POST", `/api/v1/statuses/${statusId}/reblog`);
    await call(authorEmail, "POST", `/api/v1/statuses/${statusId}/reblog`);

    await withQueueDrained(["NotifyLocalNoteBoosters"], () =>
      call(authorEmail, "PUT", `/api/v1/statuses/${statusId}`, { status: "v2" }),
    );
    const afterFirst = await updates(statusId);
    expect(afterFirst).toEqual([
      expect.objectContaining({ account_id: booster.id, from_account_id: author.id }),
    ]);

    await withQueueDrained(["NotifyLocalNoteBoosters"], () =>
      call(authorEmail, "PUT", `/api/v1/statuses/${statusId}`, { status: "v3" }),
    );
    const afterSecond = await updates(statusId);
    expect(afterSecond).toEqual([
      expect.objectContaining({ account_id: booster.id, from_account_id: author.id }),
    ]);
    expect(afterSecond[0]?.id).not.toBe(afterFirst[0]?.id);
  });

  it("reach the boosters of a quote its quoted author revokes", async () => {
    const quotedEmail = "lnb-quoted@example.com";
    const quoterEmail = "lnb-quoter@example.com";
    const boosterEmail = "lnb-quote-booster@example.com";
    await signedInAccount(quotedEmail);
    const quoter = await signedInAccount(quoterEmail);
    const booster = await signedInAccount(boosterEmail);
    const quotedId = await call(quotedEmail, "POST", "/api/v1/statuses", { status: "quote me" });
    const quotingId = await call(quoterEmail, "POST", "/api/v1/statuses", {
      status: "quoting",
      quoted_status_id: quotedId,
    });
    await call(boosterEmail, "POST", `/api/v1/statuses/${quotingId}/reblog`);

    await withQueueDrained(["NotifyLocalNoteBoosters"], () =>
      call(quotedEmail, "POST", `/api/v1/statuses/${quotedId}/quotes/${quotingId}/revoke`),
    );
    expect(await updates(quotingId)).toEqual([
      expect.objectContaining({ account_id: booster.id, from_account_id: quoter.id }),
    ]);
  });
});
