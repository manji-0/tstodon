import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const json = async (path: string): Promise<unknown> =>
  (await SELF.fetch(`https://example.com${path}`)).json();

/** Mastodon renders a hashtag as `#<span>name</span>` inside a link. */
const hashtagHtml = (tag: string): string =>
  `<a class="mention hashtag" rel="tag" href="https://remote.example/tags/${tag}">#<span>${tag}</span></a>`;

const hashtag = (name: string) => ({
  type: "Hashtag",
  name,
  href: `https://remote.example/tags/${encodeURIComponent(name.replace(/^#/, ""))}`,
});

const note = (author: Remote, slug: string, extra: Record<string, unknown>) => ({
  id: `https://remote.example/notes/${slug}`,
  type: "Note",
  attributedTo: author.actorUri,
  published: "2026-10-20T00:00:00.000Z",
  to: [PUBLIC],
  ...extra,
});

const deliver = async (
  author: Remote,
  type: "Create" | "Update",
  object: ReturnType<typeof note>,
  serial: number = 0,
): Promise<string> => {
  expect(await author.send({ id: `${object.id}/${type}-${serial}`, type, object })).toBe(202);
  const rows = parseRows(
    z.object({ id: z.string() }),
    (
      await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
        .bind(object.id)
        .all()
    ).results,
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error(`remote note ${object.id} was not stored`);
  }
  return id;
};

const tagsOf = async (id: string) =>
  expectContract(ApiStatus, await json(`/api/v1/statuses/${id}`)).tags;

const timelineIds = async (tag: string): Promise<string[]> =>
  expectContract(
    z.array(ApiStatus),
    await json(`/api/v1/timelines/tag/${encodeURIComponent(tag)}?remote=true`),
  ).map((status) => status.id);

describe("a remote note's hashtags", () => {
  it("are its Hashtag tag objects, not the hashtags its content reads as", async () => {
    const author = await remoteActor("hashtag-objects");
    const id = await deliver(
      author,
      "Create",
      note(author, "rsh-objects", {
        content: `<p>${hashtagHtml("rshinhtml")} and #rshplain</p>`,
        tag: [
          hashtag("#RshCafé"),
          hashtag("#2024"),
          hashtag("rshbare"),
          hashtag("#rshcafe"),
          { type: "Mention", name: "@rshmention", href: "https://remote.example/users/x" },
          { type: ["Hashtag", "Custom"], name: "#rshlisted" },
          { type: "Hashtag" },
          null,
          "https://remote.example/tags/rshstring",
        ],
      }),
    );

    expect(await tagsOf(id)).toEqual([
      { name: "rshcafe", url: "https://example.com/tags/rshcafe" },
      { name: "rshbare", url: "https://example.com/tags/rshbare" },
      { name: "rshlisted", url: "https://example.com/tags/rshlisted" },
    ]);
    expect(await timelineIds("rshcafe")).toEqual([id]);
    expect(await timelineIds("RshCafé")).toEqual([id]);
    expect(await timelineIds("rshinhtml")).toEqual([]);
    expect(await timelineIds("rshplain")).toEqual([]);
    expect(await timelineIds("rshmention")).toEqual([]);
  });

  it("reads a tag that is one object, not an array", async () => {
    const author = await remoteActor("hashtag-single");
    const id = await deliver(
      author,
      "Create",
      note(author, "rsh-single", { content: "<p>one</p>", tag: hashtag("#rshsingle") }),
    );
    expect(await tagsOf(id)).toEqual([
      { name: "rshsingle", url: "https://example.com/tags/rshsingle" },
    ]);
  });

  it("are replaced by an Update's", async () => {
    const author = await remoteActor("hashtag-update");
    const content = `<p>${hashtagHtml("rshkept")}</p>`;
    const id = await deliver(
      author,
      "Create",
      note(author, "rsh-update", { content, tag: [hashtag("#rshkept"), hashtag("#rshdropped")] }),
    );
    expect((await tagsOf(id)).map((tag) => tag.name)).toEqual(["rshkept", "rshdropped"]);

    await deliver(
      author,
      "Update",
      note(author, "rsh-update", {
        content,
        tag: [hashtag("#rshadded"), hashtag("#rshkept")],
        updated: "2026-10-21T00:00:00.000Z",
      }),
      1,
    );
    expect((await tagsOf(id)).map((tag) => tag.name)).toEqual(["rshadded", "rshkept"]);
    expect(await timelineIds("rshdropped")).toEqual([]);
    expect(await timelineIds("rshadded")).toEqual([id]);

    await deliver(
      author,
      "Update",
      note(author, "rsh-update", { content, updated: "2026-10-22T00:00:00.000Z" }),
      2,
    );
    expect(await tagsOf(id)).toEqual([]);
    expect(await timelineIds("rshkept")).toEqual([]);
  });

  /** Makes D1 refuse to store `tag` for any status until the returned function is called. */
  const refuseTag = async (tag: string): Promise<() => Promise<void>> => {
    await env.DB.prepare(
      `CREATE TRIGGER rsh_refuse_tag BEFORE INSERT ON remote_status_tags
       WHEN NEW.tag = '${tag}' BEGIN SELECT RAISE(ABORT, 'tag write refused'); END`,
    ).run();
    return async () => {
      await env.DB.prepare("DROP TRIGGER rsh_refuse_tag").run();
    };
  };

  const storedContent = async (objectUri: string): Promise<string | undefined> =>
    parseRows(
      z.object({ content_html: z.string() }),
      (
        await env.DB.prepare("SELECT content_html FROM remote_statuses WHERE object_uri = ?")
          .bind(objectUri)
          .all()
      ).results,
    )[0]?.content_html;

  it("stores no note when its tags cannot be written, so a later Create writes both", async () => {
    const author = await remoteActor("hashtag-atomic-create");
    const object = note(author, "rsh-atomic-create", {
      content: `<p>${hashtagHtml("rshatomichtml")}</p>`,
      tag: [hashtag("#rshatomic")],
    });

    const allow = await refuseTag("rshatomic");
    try {
      await author.send({ id: `${object.id}/create`, type: "Create", object });
      expect(await storedContent(object.id)).toBeUndefined();
    } finally {
      await allow();
    }

    // A later Create under a new activity id; inbox-retry.test.ts covers the redelivery of the same one.
    const id = await deliver(author, "Create", object, 1);
    expect((await tagsOf(id)).map((tag) => tag.name)).toEqual(["rshatomic"]);
  });

  it("leaves a note as it was when an Update's tags cannot be written, so a later Update is an edit", async () => {
    const author = await remoteActor("hashtag-atomic-update");
    const original = note(author, "rsh-atomic-update", { content: "<p>before</p>" });
    const id = await deliver(author, "Create", original);
    const edited = note(author, "rsh-atomic-update", {
      content: "<p>after</p>",
      tag: [hashtag("#rshatomicedit")],
      updated: "2026-10-21T00:00:00.000Z",
    });

    const allow = await refuseTag("rshatomicedit");
    try {
      await author.send({ id: `${edited.id}/update`, type: "Update", object: edited });
      expect(await storedContent(edited.id)).toBe("<p>before</p>");
    } finally {
      await allow();
    }

    await deliver(author, "Update", edited, 1);
    const status = expectContract(ApiStatus, await json(`/api/v1/statuses/${id}`));
    expect(status.content).toBe("<p>after</p>");
    expect(status.edited_at).toBe("2026-10-21T00:00:00.000Z");
    expect(status.tags.map((tag) => tag.name)).toEqual(["rshatomicedit"]);
  });
});
