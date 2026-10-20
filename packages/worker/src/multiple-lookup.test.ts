import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { RemoteAccountId } from "./remote-account-id";

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const IdSchema = z.object({ id: z.string().min(1) });
const IdListSchema = z.array(IdSchema);

const verify = async (email: string): Promise<string> =>
  read(
    IdSchema,
    (await json("/api/v1/accounts/verify_credentials", { headers: await accessAuthHeaders(email) }))
      .body,
  ).id;

const post = async (email: string, status: string, visibility: string): Promise<string> =>
  read(
    IdSchema,
    (
      await json("/api/v1/statuses", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await accessAuthHeaders(email)) },
        body: JSON.stringify({ status, visibility }),
      })
    ).body,
  ).id;

describe("multiple lookups", () => {
  it("returns the requested accounts in order and skips unknown ids", async () => {
    const first = await verify("multi-account-1@example.com");
    const second = await verify("multi-account-2@example.com");
    const listed = await json(
      `/api/v1/accounts?id[]=${second}&id[]=missing-account&id[]=${first}&id[]=${second}`,
    );
    expect(listed.status).toBe(200);
    expect(read(IdListSchema, listed.body).map((account) => account.id)).toEqual([second, first]);
    expect(read(IdListSchema, (await json("/api/v1/accounts")).body)).toEqual([]);
  });

  it("returns only the statuses the viewer may see", async () => {
    const email = "multi-status@example.com";
    const open = await post(email, "public multi", "public");
    const hidden = await post(email, "private multi", "private");
    const path = `/api/v1/statuses?id[]=${hidden}&id[]=${open}&id[]=missing-status`;

    const anonymous = await json(path);
    expect(anonymous.status).toBe(200);
    expect(read(IdListSchema, anonymous.body).map((status) => status.id)).toEqual([open]);

    const author = await json(path, { headers: await accessAuthHeaders(email) });
    expect(read(IdListSchema, author.body).map((status) => status.id)).toEqual([hidden, open]);
  });

  it("caps the status batch at twenty ids", async () => {
    const email = "multi-status-cap@example.com";
    const ids: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      ids.push(await post(email, `cap ${index}`, "public"));
    }
    const listed = await json(`/api/v1/statuses?${ids.map((id) => `id[]=${id}`).join("&")}`);
    expect(read(IdListSchema, listed.body).map((status) => status.id)).toEqual(ids.slice(0, 20));
  });

  it("includes remote accounts and statuses and leaves out suspended accounts", async () => {
    const actorUri = "https://remote.example/users/multi";
    await env.DB.prepare(
      `INSERT INTO remote_actors (actor_uri, username, domain, inbox_uri, public_key_id, public_key_pem, display_name, fetched_at)
       VALUES (?, 'multi', 'remote.example', ?, ?, 'pem', 'Multi Remote', '2026-01-01T00:00:00.000Z')`,
    )
      .bind(actorUri, `${actorUri}/inbox`, `${actorUri}#main-key`)
      .run();
    await env.DB.prepare(
      `INSERT INTO remote_statuses (id, actor_uri, object_uri, content_html, visibility, published_at)
       VALUES (?, ?, ?, '<p>remote</p>', ?, '2026-01-01T00:00:00.000Z')`,
    )
      .bind("multi-remote-public", actorUri, `${actorUri}/statuses/1`, "public")
      .run();
    await env.DB.prepare(
      `INSERT INTO remote_statuses (id, actor_uri, object_uri, content_html, visibility, published_at)
       VALUES (?, ?, ?, '<p>remote</p>', ?, '2026-01-01T00:00:00.000Z')`,
    )
      .bind("multi-remote-private", actorUri, `${actorUri}/statuses/2`, "private")
      .run();

    const local = await verify("multi-mixed@example.com");
    const suspended = await verify("multi-suspended@example.com");
    const suspendedAction = await json(`/api/v1/admin/accounts/${suspended}/action`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await accessAuthHeaders("multi-admin@example.com", { admin: true })),
      },
      body: JSON.stringify({ type: "suspend" }),
    });
    expect(suspendedAction.status).toBe(200);

    const remoteId = RemoteAccountId.encode(actorUri);
    const accounts = await json(
      `/api/v1/accounts?id[]=${remoteId}&id[]=${suspended}&id[]=${local}`,
    );
    expect(read(IdListSchema, accounts.body).map((account) => account.id)).toEqual([
      remoteId,
      local,
    ]);

    const localStatus = await post("multi-mixed@example.com", "mixed local", "public");
    const statuses = await json(
      `/api/v1/statuses?id[]=multi-remote-private&id[]=multi-remote-public&id[]=${localStatus}`,
    );
    expect(read(IdListSchema, statuses.body).map((status) => status.id)).toEqual([
      "multi-remote-public",
      localStatus,
    ]);
  });
});
