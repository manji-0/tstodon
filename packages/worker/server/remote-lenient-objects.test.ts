import { SELF, env } from "cloudflare:test";
import { ApiStatus, type ApiStatusJSON } from "@tstodon/api";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";
import { answerLinkPreviews } from "../test/link-card-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";
import { RemoteAccountId } from "./remote-account-id";

// Shapes Mastodon v4.7.5 reads leniently, as other software sends them.

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const storedId = async (objectUri: string): Promise<string | undefined> =>
  parseRows(
    z.object({ id: z.string() }),
    (
      await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
        .bind(objectUri)
        .all()
    ).results,
  )[0]?.id;

const status = async (objectUri: string): Promise<ApiStatusJSON> => {
  const id = await storedId(objectUri);
  expect(id).toBeDefined();
  const response = await SELF.fetch(`https://example.com/api/v1/statuses/${id}`);
  expect(response.status).toBe(200);
  return expectContract(ApiStatus, await response.json());
};

const note = (author: Remote, slug: string, extra: Record<string, unknown> = {}) => ({
  id: `${author.actorUri}/notes/${slug}`,
  type: "Note",
  attributedTo: author.actorUri,
  content: `<p>${slug}</p>`,
  published: new Date().toISOString(),
  to: [PUBLIC],
  ...extra,
});

const create = (author: Remote, object: Readonly<{ id: string }>) =>
  author.send({ id: `${object.id}#create`, type: "Create", object });

/** Serve `documents` by URL to the Worker's outbound fetches while `run` runs. */
const serving = async <T>(
  documents: Readonly<Record<string, unknown>>,
  run: () => Promise<T>,
): Promise<T> => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const document = documents[href];
    return document === undefined
      ? original(input, init)
      : new Response(JSON.stringify(document), {
          headers: { "content-type": "application/activity+json" },
        });
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
};

describe("a note's attachment", () => {
  it("is read when it is one object rather than a list (as_array)", async () => {
    const author = await remoteActor("lenient-single-attachment");
    const object = note(author, "single", {
      attachment: {
        type: "Document",
        mediaType: "image/png",
        url: "https://remote.example/media/single.png",
        name: "one picture",
      },
    });
    expect(await create(author, object)).toBe(202);
    expect((await status(object.id)).media_attachments).toMatchObject([
      {
        type: "image",
        remote_url: "https://remote.example/media/single.png",
        description: "one picture",
      },
    ]);
  });

  it("takes the href of a url that is a Link (url_to_href)", async () => {
    const author = await remoteActor("lenient-link-url");
    const object = note(author, "link-url", {
      attachment: [
        {
          type: "Document",
          url: {
            type: "Link",
            href: "https://remote.example/media/linked.png",
            mediaType: "image/png",
          },
        },
      ],
    });
    expect(await create(author, object)).toBe(202);
    expect((await status(object.id)).media_attachments).toMatchObject([
      { type: "image", remote_url: "https://remote.example/media/linked.png" },
    ]);
  });

  it("that is a Link names the preview card's URL, as Mastodon's @links.first", async () => {
    const previews = answerLinkPreviews(["https://lenient.example/linked-article"]);
    const author = await remoteActor("lenient-link-attachment");
    const object = note(author, "link-attachment", {
      attachment: [{ type: "Link", href: "https://lenient.example/linked-article" }],
    });
    expect(await create(author, object)).toBe(202);
    expect((await status(object.id)).media_attachments).toEqual([]);
    await previews.settled();
  });
});

describe("an object type given as a list", () => {
  it("is read as the Note it lists", async () => {
    const author = await remoteActor("lenient-type-list");
    const object = note(author, "type-list", { type: ["Note"] });
    expect(await create(author, object)).toBe(202);
    expect((await status(object.id)).content).toBe("<p>type-list</p>");
  });

  it("is read in an Update as the Note it lists", async () => {
    const author = await remoteActor("lenient-type-list-update");
    const object = note(author, "type-list-update");
    expect(await create(author, object)).toBe(202);
    expect(
      await author.send({
        id: `${object.id}#update`,
        type: "Update",
        object: {
          ...object,
          type: ["Note"],
          content: "<p>edited</p>",
          updated: new Date(Date.now() + 1000).toISOString(),
        },
      }),
    ).toBe(202);
    expect((await status(object.id)).content).toBe("<p>edited</p>");
  });

  it("is converted when it lists a converted type, as StatusParser#converted_object_type?", async () => {
    const author = await remoteActor("lenient-type-converted");
    const object = note(author, "type-converted", { type: ["Note", "Article"], name: "A title" });
    // A converted object's text links to it, and that link is unfurled.
    const previews = answerLinkPreviews([object.id]);
    expect(await create(author, object)).toBe(202);
    const { content } = await status(object.id);
    expect(content).toContain("A title");
    expect(content).not.toContain("<p>type-converted</p>");
    await previews.settled();
  });
});

describe("an Announce whose object is a Create", () => {
  /** A Lemmy community, the user who posts in it, and a local follower of the community. */
  const lemmy = async (name: string) => {
    const host = `${name}.lemmy.example`;
    const community = await remoteActor(name, host, { path: `/c/${name}` });
    const user = await remoteActor("poster", host, { path: "/u/poster" });
    const email = `${name}-follower@example.com`;
    const headers = await authHeaders(email);
    const followed = await SELF.fetch(
      `https://example.com/api/v1/accounts/${RemoteAccountId.encode(community.actorUri)}/follow`,
      { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" },
    );
    expect(followed.status).toBe(200);
    const follow = parseRows(
      z.object({ follow_activity_id: z.string() }),
      (
        await env.DB.prepare("SELECT follow_activity_id FROM outbound_follows WHERE actor_uri = ?")
          .bind(community.actorUri)
          .all()
      ).results,
    )[0];
    expect(
      await community.send({
        id: `${community.actorUri}/accepts/1`,
        type: "Accept",
        object: follow?.follow_activity_id,
      }),
    ).toBe(202);
    const page = {
      id: `https://${host}/post/1`,
      type: "Page",
      attributedTo: user.actorUri,
      to: [community.actorUri, PUBLIC],
      name: "A post in the community",
      content: "<p>body</p>",
      published: new Date().toISOString(),
    };
    const createActivity = {
      id: `https://${host}/activities/create/1`,
      type: "Create",
      actor: user.actorUri,
      to: [PUBLIC],
      object: page,
    };
    const home = async (): Promise<ReadonlyArray<string | undefined>> =>
      parseRows(
        z.object({ reblog: z.object({ uri: z.string() }).nullable() }),
        await (await SELF.fetch("https://example.com/api/v1/timelines/home", { headers })).json(),
      ).map((entry) => entry.reblog?.uri);
    return { community, page, createActivity, home };
  };

  it("stores the Create's object, fetched by the Create's id, and boosts it", async () => {
    const { community, page, createActivity, home } = await lemmy("announced-create");
    const previews = answerLinkPreviews([page.id]);
    expect(
      await serving({ [createActivity.id]: createActivity }, () =>
        community.send({
          id: `${community.actorUri}/activities/announce/1`,
          type: "Announce",
          to: [PUBLIC],
          cc: [`${community.actorUri}/followers`],
          object: createActivity.id,
        }),
      ),
    ).toBe(202);
    expect(await storedId(page.id)).toBeDefined();
    expect(await home()).toContain(page.id);
    await previews.settled();
  });

  it("fetches an embedded Create by its id, as Mastodon does", async () => {
    const { community, page, createActivity, home } = await lemmy("embedded-create");
    const previews = answerLinkPreviews([page.id]);
    expect(
      await serving({ [createActivity.id]: createActivity }, () =>
        community.send({
          id: `${community.actorUri}/activities/announce/2`,
          type: "Announce",
          to: [PUBLIC],
          cc: [`${community.actorUri}/followers`],
          object: createActivity,
        }),
      ),
    ).toBe(202);
    expect(await home()).toContain(page.id);
    await previews.settled();
  });

  it("stores nothing when the Create's id is on another host than its actor", async () => {
    const { community, page, createActivity } = await lemmy("forged-create");
    const forged = { ...createActivity, id: "https://elsewhere.example/activities/create/1" };
    expect(
      await serving({ [forged.id]: forged }, () =>
        community.send({
          id: `${community.actorUri}/activities/announce/3`,
          type: "Announce",
          to: [PUBLIC],
          object: forged.id,
        }),
      ),
    ).toBe(202);
    expect(await storedId(page.id)).toBeUndefined();
  });
});
