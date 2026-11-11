import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiAccount } from "@tstodon/api";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const auth = (email: string): Promise<Record<string, string>> => authHeaders(email);

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

const StatusIdSchema = z.object({ id: z.string().min(1) });

const accountIdFor = async (email: string): Promise<string> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  return read(ApiAccount, response.body).id;
};

const postStatus = async (email: string, status: string): Promise<string> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify({ status }),
  });
  expect(response.status).toBe(200);
  return read(StatusIdSchema, response.body).id;
};

const idsAt = async (path: string, email?: string): Promise<string[]> => {
  const response = await json(path, email ? { headers: await auth(email) } : undefined);
  expect(response.status).toBe(200);
  return read(z.array(StatusIdSchema), response.body).map((status) => status.id);
};

const action = async (path: string, email: string): Promise<void> => {
  const response = await json(path, { method: "POST", headers: await auth(email) });
  expect(response.status).toBe(200);
};

describe("timeline pagination", () => {
  it("pages the home timeline with max_id, since_id, and min_id", async () => {
    const viewerEmail = "page-viewer@example.com";
    const authorEmail = "page-author@example.com";
    const authorId = await accountIdFor(authorEmail);
    await accountIdFor(viewerEmail);
    await action(`/api/v1/accounts/${authorId}/follow`, viewerEmail);

    const first = await postStatus(authorEmail, "page one");
    const second = await postStatus(authorEmail, "page two");
    const third = await postStatus(authorEmail, "page three");

    expect(await idsAt("/api/v1/timelines/home", viewerEmail)).toEqual([third, second, first]);
    expect(await idsAt(`/api/v1/timelines/home?max_id=${second}`, viewerEmail)).toEqual([first]);
    expect(await idsAt(`/api/v1/timelines/home?since_id=${first}`, viewerEmail)).toEqual([
      third,
      second,
    ]);
    // min_id pages upward from the oldest side.
    expect(await idsAt(`/api/v1/timelines/home?min_id=${first}&limit=2`, viewerEmail)).toEqual([
      second,
      third,
    ]);
  });

  it("pages bookmarks and favourites", async () => {
    const email = "page-owner@example.com";
    await accountIdFor(email);
    const first = await postStatus(email, "saved one");
    const second = await postStatus(email, "saved two");
    await action(`/api/v1/statuses/${first}/bookmark`, email);
    await action(`/api/v1/statuses/${second}/bookmark`, email);
    await action(`/api/v1/statuses/${first}/favourite`, email);
    await action(`/api/v1/statuses/${second}/favourite`, email);

    expect(await idsAt("/api/v1/bookmarks", email)).toEqual([second, first]);
    expect(await idsAt(`/api/v1/bookmarks?max_id=${second}`, email)).toEqual([first]);
    expect(await idsAt(`/api/v1/bookmarks?since_id=${first}`, email)).toEqual([second]);
    expect(await idsAt(`/api/v1/favourites?max_id=${second}`, email)).toEqual([first]);
    expect(await idsAt(`/api/v1/favourites?min_id=${first}`, email)).toEqual([second]);

    const accountId = await accountIdFor(email);
    expect(await idsAt(`/api/v1/accounts/${accountId}/statuses?min_id=${first}`)).toEqual([second]);
    expect(await idsAt(`/api/v1/accounts/${accountId}/statuses?max_id=${second}`)).toEqual([first]);
  });

  it("pages a tag timeline", async () => {
    const email = "page-tagger@example.com";
    await accountIdFor(email);
    const first = await postStatus(email, "tag one #pagewave");
    const second = await postStatus(email, "tag two #pagewave");

    expect(await idsAt("/api/v1/timelines/tag/pagewave")).toEqual([second, first]);
    expect(await idsAt(`/api/v1/timelines/tag/pagewave?max_id=${second}`)).toEqual([first]);
    expect(await idsAt(`/api/v1/timelines/tag/pagewave?min_id=${first}`)).toEqual([second]);
  });

  it("lets the next source's entry take the place of a boost that renders away", async () => {
    const viewerEmail = "page-gap-viewer@example.com";
    const authorEmail = "page-gap-author@example.com";
    const authorId = await accountIdFor(authorEmail);
    const viewerId = await accountIdFor(viewerEmail);
    await action(`/api/v1/accounts/${authorId}/follow`, viewerEmail);
    const followed = await remoteActor("page-gap-followed", "gap-followed.example");
    const hidden = await remoteActor("page-gap-hidden", "gap-hidden.example");
    await action(
      `/api/v1/accounts/${RemoteAccountId.encode(followed.actorUri)}/follow`,
      viewerEmail,
    );
    const follow = await env.DB.prepare(
      "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
    )
      .bind(viewerId, followed.actorUri)
      .first<{ follow_activity_id: string }>();
    expect(
      await followed.send({
        id: `${followed.actorUri}/accepts/1`,
        type: "Accept",
        object: follow?.follow_activity_id,
      }),
    ).toBe(202);
    const note = async (actor: Remote, slug: string): Promise<string> => {
      const uri = `${new URL(actor.actorUri).origin}/notes/${slug}`;
      expect(
        await actor.send({
          id: `${uri}/activity`,
          type: "Create",
          object: {
            id: uri,
            type: "Note",
            attributedTo: actor.actorUri,
            content: `<p>${slug}</p>`,
            published: "2026-10-20T00:00:00.000Z",
            to: ["https://www.w3.org/ns/activitystreams#Public"],
            cc: [`${actor.actorUri}/followers`],
          },
        }),
      ).toBe(202);
      const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
        .bind(uri)
        .first<{ id: string }>();
      return row?.id ?? "";
    };

    const hiddenNote = await note(hidden, "hidden");
    const remoteNote = await note(followed, "followed");
    const older = await postStatus(authorEmail, "gap older");
    await action(`/api/v1/statuses/${hiddenNote}/reblog`, authorEmail);
    const newest = await postStatus(authorEmail, "gap newest");
    const page = await idsAt("/api/v1/timelines/home?limit=2", viewerEmail);
    expect(page[0]).toBe(newest);
    expect(page).toHaveLength(2);

    // Once only allow-listed domains federate, the boost of the hidden actor's
    // note renders away after the query picked it. The local query fetched
    // two entries, the boost and the newest, so the followed actor's note,
    // fetched by its own query, fills the page rather than the older note.
    const allowed = await json("/api/v1/admin/domain_allows", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await authHeaders("page-gap-admin@example.com", { admin: true })),
      },
      body: JSON.stringify({ domain: "gap-followed.example" }),
    });
    expect(allowed.status).toBe(200);
    expect(await idsAt("/api/v1/timelines/home?limit=2", viewerEmail)).toEqual([
      newest,
      remoteNote,
    ]);
    expect(await idsAt("/api/v1/timelines/home?limit=4", viewerEmail)).toEqual([
      newest,
      older,
      remoteNote,
    ]);
  });
});
