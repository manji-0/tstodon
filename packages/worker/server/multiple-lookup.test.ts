import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { newEntityId } from "./ids";
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

const CAP_STAMP = "2026-01-01T00:00:00.000Z";

const IdSchema = z.object({ id: z.string().min(1) });
const IdListSchema = z.array(IdSchema);

const verify = async (email: string): Promise<string> =>
  read(
    IdSchema,
    (await json("/api/v1/accounts/verify_credentials", { headers: await authHeaders(email) })).body,
  ).id;

const post = async (email: string, status: string, visibility: string): Promise<string> =>
  read(
    IdSchema,
    (
      await json("/api/v1/statuses", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeaders(email)) },
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

    const author = await json(path, { headers: await authHeaders(email) });
    expect(read(IdListSchema, author.body).map((status) => status.id)).toEqual([hidden, open]);
  });

  it("shows each restricted status to whoever may open it alone", async () => {
    const author = "multi-restricted-author@example.com";
    const addressed = "multi-restricted-addressed@example.com";
    const follower = "multi-restricted-follower@example.com";
    const stranger = "multi-restricted-stranger@example.com";
    const username = async (email: string): Promise<string> =>
      read(
        z.object({ username: z.string() }),
        (await json("/api/v1/accounts/verify_credentials", { headers: await authHeaders(email) }))
          .body,
      ).username;
    const authorId = await verify(author);
    const addressedId = await verify(addressed);
    const followerName = await username(follower);
    const addressedName = await username(addressed);
    expect(
      (
        await json(`/api/v1/accounts/${authorId}/follow`, {
          method: "POST",
          headers: await authHeaders(follower),
        })
      ).status,
    ).toBe(200);
    const postAs = async (email: string, body: Record<string, unknown>): Promise<string> =>
      read(
        IdSchema,
        (
          await json("/api/v1/statuses", {
            method: "POST",
            headers: { "content-type": "application/json", ...(await authHeaders(email)) },
            body: JSON.stringify(body),
          })
        ).body,
      ).id;
    const open = await postAs(author, { status: "restricted open", visibility: "public" });
    const followersOnly = await postAs(author, { status: "restricted ff", visibility: "private" });
    const direct = await postAs(author, {
      status: `@${addressedName} @${followerName} restricted dm`,
      visibility: "direct",
    });
    // The reply names no one; the follower sees it through the note it answers.
    const directReply = await postAs(addressed, {
      status: "restricted dm reply",
      visibility: "direct",
      in_reply_to_id: direct,
    });

    const actorUri = "https://remote.example/users/multi-restricted";
    await env.DB.prepare(
      `INSERT INTO remote_actors (actor_uri, username, domain, inbox_uri, public_key_id, public_key_pem, display_name, fetched_at)
       VALUES (?, 'multi-restricted', 'remote.example', ?, ?, 'pem', 'Restricted Remote', '2026-01-01T00:00:00.000Z')`,
    )
      .bind(actorUri, `${actorUri}/inbox`, `${actorUri}#main-key`)
      .run();
    for (const [id, visibility] of [
      ["multi-restricted-remote-dm", "direct"],
      ["multi-restricted-remote-ff", "private"],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO remote_statuses (id, actor_uri, object_uri, content_html, visibility, published_at)
         VALUES (?, ?, ?, '<p>remote</p>', ?, '2026-01-01T00:00:00.000Z')`,
      )
        .bind(id, actorUri, `${actorUri}/statuses/${id}`, visibility)
        .run();
    }
    await env.DB.prepare("INSERT INTO remote_status_mentions (status_id, account_id) VALUES (?, ?)")
      .bind("multi-restricted-remote-dm", addressedId)
      .run();

    const ids = [
      open,
      followersOnly,
      direct,
      directReply,
      "multi-restricted-remote-dm",
      "multi-restricted-remote-ff",
    ];
    const seen = new Map<string | undefined, string[]>();
    for (const viewer of [author, addressed, follower, stranger, undefined]) {
      const init = viewer ? { headers: await authHeaders(viewer) } : {};
      const alone: string[] = [];
      for (const id of ids) {
        if ((await json(`/api/v1/statuses/${id}`, init)).status === 200) {
          alone.push(id);
        }
      }
      const listed = await json(
        `/api/v1/statuses?${ids.map((id) => `id[]=${id}`).join("&")}`,
        init,
      );
      expect(read(IdListSchema, listed.body).map((status) => status.id)).toEqual(alone);
      seen.set(viewer, alone);
    }
    expect(seen.get(follower)).toEqual([open, followersOnly, direct, directReply]);
    expect(seen.get(addressed)).toEqual([open, direct, directReply, "multi-restricted-remote-dm"]);
    expect(seen.get(stranger)).toEqual([open]);
  });

  it("caps the status batch at twenty ids", async () => {
    // Posting 21 statuses through the API took most of this test's time;
    // the cap is on the lookup, so store the rows directly.
    const accountId = await verify("multi-status-cap@example.com");
    const ids = Array.from({ length: 21 }, () => newEntityId());
    await env.DB.batch(
      ids.map((id, index) =>
        env.DB.prepare(
          `INSERT INTO statuses (id, account_id, kind, content_text, content_html, visibility, created_at, updated_at)
           VALUES (?, ?, 'LocalNote', ?, ?, 'public', ?, ?)`,
        ).bind(id, accountId, `cap ${index}`, `<p>cap ${index}</p>`, CAP_STAMP, CAP_STAMP),
      ),
    );
    const listed = await json(`/api/v1/statuses?${ids.map((id) => `id[]=${id}`).join("&")}`);
    expect(read(IdListSchema, listed.body).map((status) => status.id)).toEqual(ids.slice(0, 20));
  });

  it("includes remote accounts and statuses and renders suspended accounts suspended", async () => {
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
        ...(await authHeaders("multi-admin@example.com", { admin: true })),
      },
      body: JSON.stringify({ type: "suspend" }),
    });
    expect(suspendedAction.status).toBe(200);

    const remoteId = RemoteAccountId.encode(actorUri);
    const accounts = await json(
      `/api/v1/accounts?id[]=${remoteId}&id[]=${suspended}&id[]=${local}`,
    );
    // As Mastodon's `set_accounts`, a suspended account is listed, rendered suspended.
    const listed = read(
      z.array(z.object({ id: z.string(), suspended: z.boolean().optional() })),
      accounts.body,
    );
    expect(listed.map((account) => [account.id, account.suspended ?? false])).toEqual([
      [remoteId, false],
      [suspended, true],
      [local, false],
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
