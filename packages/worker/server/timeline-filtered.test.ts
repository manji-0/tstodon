import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { IsoInstant, RemoteActor } from "@tstodon/domain";
import { nowIso } from "./clock";
import { generateAccountKeys } from "./keys";
import { parseInstanceIdentity } from "./runtime-config";
import { upsertRemoteActor } from "./remote-actor-store";
import { persistRemoteObject } from "./remote-status-persist";

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

const TimelineSchema = z.array(
  z.object({
    id: z.string().min(1),
    filtered: z
      .array(
        z.object({
          filter: z.object({ title: z.string() }),
          keyword_matches: z.array(z.string()),
        }),
      )
      .optional(),
  }),
);

const filteredTitles = (timeline: z.infer<typeof TimelineSchema>, statusId: string): string[] =>
  timeline.find((status) => status.id === statusId)?.filtered?.map((entry) => entry.filter.title) ??
  [];

const postStatus = async (email: string, body: Record<string, unknown>): Promise<string> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return read(z.object({ id: z.string().min(1) }), response.body).id;
};

const accountIdFor = async (email: string): Promise<string> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  return read(z.object({ id: z.string().min(1) }), response.body).id;
};

const createFilter = async (email: string, context: string, keyword: string): Promise<void> => {
  const response = await json("/api/v2/filters", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify({ title: keyword, context: [context], keywords: [keyword] }),
  });
  expect(response.status).toBe(200);
};

describe("filtered on timelines", () => {
  it("marks remote statuses from their stored HTML", async () => {
    const viewerEmail = "tl-filtered-remote-viewer@example.com";
    const keys = await generateAccountKeys();
    const fetchedAt = IsoInstant.parse(nowIso());
    if (fetchedAt.isErr()) {
      throw new Error("clock");
    }
    const actorUri = "https://filtered-remote.example/users/frank";
    const actor = RemoteActor.fromFetched({
      actorUri,
      username: "frank",
      domain: "filtered-remote.example",
      inboxUri: `${actorUri}/inbox`,
      publicKeyId: `${actorUri}#main-key`,
      publicKeyPem: keys.publicKeyPem,
      displayName: "frank",
      fetchedAt: fetchedAt.value,
    });
    if (actor.isErr()) {
      throw new Error("actor fixture rejected");
    }
    await upsertRemoteActor(env.DB, actor.value);
    const identity = parseInstanceIdentity(env);
    if (identity.isErr()) {
      throw new Error("identity");
    }
    const persisted = await persistRemoteObject(env, identity.value, actor.value, {
      id: `${actorUri}/statuses/1`,
      type: "Note",
      attributedTo: actorUri,
      content: '<p>remote spoilers from <a href="https://x.example">someone</a></p>',
      published: new Date().toISOString(),
      to: ["https://www.w3.org/ns/activitystreams#Public"],
    });
    expect(persisted.isOk()).toBe(true);
    const remoteId = persisted.isOk() && persisted.value ? persisted.value.id : "";

    await createFilter(viewerEmail, "public", "spoilers");

    const timeline = await json("/api/v1/timelines/public", { headers: await auth(viewerEmail) });
    expect(filteredTitles(read(TimelineSchema, timeline.body), remoteId)).toEqual(["spoilers"]);

    // Anonymous readers get no filtering.
    const anonymous = await json("/api/v1/timelines/public");
    expect(filteredTitles(read(TimelineSchema, anonymous.body), remoteId)).toEqual([]);
  });

  it("marks home, public, and account statuses for the viewer", async () => {
    const viewerEmail = "timeline-filtered-viewer@example.com";
    const authorEmail = "timeline-filtered-author@example.com";
    const authorId = await accountIdFor(authorEmail);
    const viewerId = await accountIdFor(viewerEmail);
    const statusId = await postStatus(authorEmail, { status: "spoilers about finale night" });

    // The viewer follows the author so the post reaches their home timeline.
    await json(`/api/v1/accounts/${authorId}/follow`, {
      method: "POST",
      headers: await auth(viewerEmail),
    });

    const before = await json("/api/v1/timelines/home", { headers: await auth(viewerEmail) });
    expect(filteredTitles(read(TimelineSchema, before.body), statusId)).toEqual([]);

    await createFilter(viewerEmail, "home", "finale");

    const home = await json("/api/v1/timelines/home", { headers: await auth(viewerEmail) });
    expect(filteredTitles(read(TimelineSchema, home.body), statusId)).toEqual(["finale"]);

    // Search-like `public` context filters are separate from home ones.
    const publicTimeline = await json("/api/v1/timelines/public");
    expect(filteredTitles(read(TimelineSchema, publicTimeline.body), statusId)).toEqual([]);

    await createFilter(viewerEmail, "public", "spoilers");
    const publicForViewer = await json("/api/v1/timelines/public", {
      headers: await auth(viewerEmail),
    });
    expect(filteredTitles(read(TimelineSchema, publicForViewer.body), statusId)).toEqual([
      "spoilers",
    ]);

    const accountStatuses = await json(`/api/v1/accounts/${authorId}/statuses`, {
      headers: await auth(viewerEmail),
    });
    expect(filteredTitles(read(TimelineSchema, accountStatuses.body), statusId)).toEqual([
      "spoilers",
    ]);

    // Another viewer sees nothing.
    const other = await json("/api/v1/timelines/public", {
      headers: await auth("timeline-filtered-other@example.com"),
    });
    expect(filteredTitles(read(TimelineSchema, other.body), statusId)).toEqual([]);
    expect(viewerId).not.toBe(authorId);
  });

  it("marks a hide-action filter without dropping the status", async () => {
    const viewerEmail = "timeline-hide-viewer@example.com";
    const authorEmail = "timeline-hide-author@example.com";
    const authorId = await accountIdFor(authorEmail);
    const statusId = await postStatus(authorEmail, { status: "hide-action spoilers here" });
    await json(`/api/v1/accounts/${authorId}/follow`, {
      method: "POST",
      headers: await auth(viewerEmail),
    });

    const created = await json("/api/v2/filters", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(viewerEmail)) },
      body: JSON.stringify({
        title: "spoilers",
        context: ["home"],
        filter_action: "hide",
        keywords: ["spoilers"],
      }),
    });
    expect(created.status).toBe(200);
    expect(read(z.object({ filter_action: z.string() }), created.body).filter_action).toBe("hide");

    // Mastodon matches filters server-side and leaves the action to the client
    // (`hide` is applied by the client from `filtered`), so the status is still
    // present, just marked.
    const timeline = await json("/api/v1/timelines/home", { headers: await auth(viewerEmail) });
    const home = read(TimelineSchema, timeline.body);
    expect(home.some((status) => status.id === statusId)).toBe(true);
    expect(filteredTitles(home, statusId)).toEqual(["spoilers"]);

    // An action tstodon does not store (`blur` is API version 5) reads as warn.
    const unknown = await json("/api/v2/filters", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(viewerEmail)) },
      body: JSON.stringify({ title: "blurred", context: ["home"], filter_action: "blur" }),
    });
    expect(unknown.status).toBe(200);
    expect(read(z.object({ filter_action: z.string() }), unknown.body).filter_action).toBe("warn");
  });
});
