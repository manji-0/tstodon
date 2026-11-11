import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { answerLinkPreviews } from "../test/link-card-fixture";
import { IsoInstant, RemoteActor } from "@tstodon/domain";
import { nowIso } from "./clock";
import { generateAccountKeys } from "./keys";
import { parseInstanceIdentity } from "./runtime-config";
import { upsertRemoteActor } from "./remote-actor-store";
import { persistRemoteObject } from "./remote-status-persist";
import { processOutboxJob } from "./outbox-job";
import { unsignedFetch } from "./federated-fetch";

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

const IdsSchema = z.array(z.object({ id: z.string().min(1) }));

const postLocal = async (email: string, status: string): Promise<string> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify({ status }),
  });
  expect(response.status).toBe(200);
  return read(z.object({ id: z.string().min(1) }), response.body).id;
};

const idsAt = async (path: string): Promise<string[]> => {
  const response = await json(path);
  expect(response.status).toBe(200);
  return read(IdsSchema, response.body).map((status) => status.id);
};

const remoteAuthor = async (username: string, domain: string): Promise<RemoteActor> => {
  const keys = await generateAccountKeys();
  const fetchedAt = IsoInstant.parse(nowIso());
  if (fetchedAt.isErr()) {
    throw new Error("clock");
  }
  const actorUri = `https://${domain}/users/${username}`;
  const actor = RemoteActor.fromFetched({
    actorUri,
    username,
    domain,
    inboxUri: `${actorUri}/inbox`,
    publicKeyId: `${actorUri}#main-key`,
    publicKeyPem: keys.publicKeyPem,
    displayName: username,
    fetchedAt: fetchedAt.value,
  });
  if (actor.isErr()) {
    throw new Error("actor fixture rejected");
  }
  const stored = await upsertRemoteActor(env.DB, actor.value);
  expect(stored.isOk()).toBe(true);
  return actor.value;
};

const remotePost = async (
  actor: RemoteActor,
  objectId: string,
  content: string,
  to: ReadonlyArray<string> = ["https://www.w3.org/ns/activitystreams#Public"],
): Promise<string> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    throw new Error("identity");
  }
  const persisted = await persistRemoteObject(
    env,
    identity.value,
    actor,
    {
      id: objectId,
      type: "Note",
      attributedTo: actor.actorUri,
      content,
      published: new Date().toISOString(),
      to,
    },
    { fetchSigner: unsignedFetch },
  );
  expect(persisted.isOk()).toBe(true);
  return persisted.isOk() && persisted.value ? persisted.value.id : "";
};

/** Mastodon renders a hashtag as `#<span>name</span>` inside a link. */
const hashtagHtml = (tag: string): string =>
  `<a class="mention hashtag" rel="tag" href="https://example.com/tags/${tag}">#<span>${tag}</span></a>`;

describe("tag timeline across the fediverse", () => {
  it("lists local and remote statuses and honors local/remote", async () => {
    const author = "tagfed-author@example.com";
    const localId = await postLocal(author, "local post about #fedtag");
    const actor = await remoteAuthor("rita", "tagfed.example");
    const remoteId = await remotePost(
      actor,
      `${actor.actorUri}/statuses/1`,
      `<p>remote post about ${hashtagHtml("fedtag")}</p>`,
    );

    const both = await idsAt("/api/v1/timelines/tag/fedtag");
    expect(both).toEqual(expect.arrayContaining([localId, remoteId]));

    expect(await idsAt("/api/v1/timelines/tag/fedtag?local=true")).toEqual([localId]);
    expect(await idsAt("/api/v1/timelines/tag/fedtag?remote=true")).toEqual([remoteId]);
    // The public timeline takes the same pair of flags.
    expect(await idsAt("/api/v1/timelines/public?remote=true")).toContain(remoteId);
    expect(await idsAt("/api/v1/timelines/public?local=true")).not.toContain(remoteId);
  });

  it("applies the additional tag filters to remote statuses too", async () => {
    const actor = await remoteAuthor("sam", "tagfed2.example");
    const one = await remotePost(
      actor,
      `${actor.actorUri}/statuses/1`,
      `<p>only ${hashtagHtml("fedtwo")}</p>`,
    );
    const two = await remotePost(
      actor,
      `${actor.actorUri}/statuses/2`,
      `<p>both ${hashtagHtml("fedtwo")} and ${hashtagHtml("extra")}</p>`,
    );

    expect(await idsAt("/api/v1/timelines/tag/fedtwo?remote=true")).toEqual(
      expect.arrayContaining([one, two]),
    );
    expect(await idsAt("/api/v1/timelines/tag/fedtwo?remote=true&all[]=extra")).toEqual([two]);
    expect(await idsAt("/api/v1/timelines/tag/fedtwo?remote=true&none[]=extra")).toEqual([one]);
    expect(await idsAt("/api/v1/timelines/tag/fedtwo?remote=true&any[]=extra")).toEqual([two]);
    // Neither carries an attachment.
    expect(await idsAt("/api/v1/timelines/tag/fedtwo?remote=true&only_media=true")).toEqual([]);
  });

  it("lets hashtag search find a remote note's tags", async () => {
    const actor = await remoteAuthor("sam", "tagsearch.example");
    await remotePost(
      actor,
      `${actor.actorUri}/statuses/1`,
      `<p>${hashtagHtml("remotesearchtag")}</p>`,
    );
    const response = await json("/api/v2/search?q=remotesearch&type=hashtags");
    expect(response.status).toBe(200);
    const found = read(
      z.object({ hashtags: z.array(z.object({ name: z.string() })) }),
      response.body,
    );
    expect(found.hashtags.map((tag) => tag.name)).toEqual(["remotesearchtag"]);
  });

  it("does not let hashtag search find the tags or link fragments of a remote direct or followers-only note", async () => {
    const actor = await remoteAuthor("dana", "tagsearchprivate.example");
    const link = (url: string): string => `<a href="${url}">${url}</a>`;
    // Each note queues a preview of its first link (see `answerLinkPreviews`).
    const previews = answerLinkPreviews([
      "https://app.example/invite#RemoteDmFrag",
      "https://app.example/join#RemotePrivFrag",
      "https://app.example/page#RemotePubFrag",
    ]);
    await remotePost(
      actor,
      `${actor.actorUri}/statuses/1`,
      `<p>${link("https://app.example/invite#RemoteDmFrag")} ${hashtagHtml("remotedmtag")}</p>`,
      ["https://example.com/users/tagsearchremotedm"],
    );
    await remotePost(
      actor,
      `${actor.actorUri}/statuses/2`,
      `<p>${link("https://app.example/join#RemotePrivFrag")} ${hashtagHtml("remoteprivtag")}</p>`,
      [`${actor.actorUri}/followers`],
    );
    // A public note's link fragment is no hashtag either.
    await remotePost(
      actor,
      `${actor.actorUri}/statuses/3`,
      `<p>${link("https://app.example/page#RemotePubFrag")}</p>`,
    );
    await previews.settled();

    for (const query of ["remotedm", "remotepriv", "remotepubfrag"]) {
      const anonymous = await json(`/api/v2/search?q=${query}&type=hashtags`);
      const signedIn = await json(`/api/v2/search?q=${query}&type=hashtags`, {
        headers: await auth("tagsearchremotedm@example.com"),
      });
      for (const response of [anonymous, signedIn]) {
        expect(response.status).toBe(200);
        expect(read(z.object({ hashtags: z.array(z.unknown()) }), response.body).hashtags).toEqual(
          [],
        );
      }
    }
  });

  it("indexes older remote statuses from cron", async () => {
    const actor = await remoteAuthor("tess", "tagbackfill.example");
    const id = await remotePost(
      actor,
      `${actor.actorUri}/statuses/1`,
      `<p>before the index ${hashtagHtml("backfilltag")}</p>`,
    );

    // A row written before the index has no tags and is not marked as indexed.
    await env.DB.prepare("DELETE FROM remote_status_tags WHERE status_id = ?").bind(id).run();
    await env.DB.prepare("UPDATE remote_statuses SET tags_indexed = 0 WHERE id = ?").bind(id).run();
    expect(await idsAt("/api/v1/timelines/tag/backfilltag?remote=true")).toEqual([]);

    expect(await processOutboxJob(env, { kind: "BackfillRemoteTags" })).toBe("ok");
    expect(await idsAt("/api/v1/timelines/tag/backfilltag?remote=true")).toEqual([id]);
    // A second run leaves the index alone.
    expect(await processOutboxJob(env, { kind: "BackfillRemoteTags" })).toBe("ok");
    expect(await idsAt("/api/v1/timelines/tag/backfilltag?remote=true")).toEqual([id]);
  });

  it("indexes every older remote status of a run whose writes span several batches", async () => {
    const actor = await remoteAuthor("tom", "tagbackfillmany.example");
    const ids: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      ids.push(
        await remotePost(
          actor,
          `${actor.actorUri}/statuses/${index}`,
          `<p>${["backfillmanya", "backfillmanyb", "backfillmanyc"].map(hashtagHtml).join(" ")}</p>`,
        ),
      );
    }
    for (const id of ids) {
      await env.DB.prepare("DELETE FROM remote_status_tags WHERE status_id = ?").bind(id).run();
      await env.DB.prepare("UPDATE remote_statuses SET tags_indexed = 0 WHERE id = ?")
        .bind(id)
        .run();
    }
    expect(await idsAt("/api/v1/timelines/tag/backfillmanyc?remote=true&limit=40")).toEqual([]);

    expect(await processOutboxJob(env, { kind: "BackfillRemoteTags" })).toBe("ok");
    const newestFirst = [...ids].reverse();
    for (const tag of ["backfillmanya", "backfillmanyb", "backfillmanyc"]) {
      expect(await idsAt(`/api/v1/timelines/tag/${tag}?remote=true&limit=40`)).toEqual(newestFirst);
    }
  });
});
