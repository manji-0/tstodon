import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const note = (author: Remote, slug: string, extra: Record<string, unknown>) => ({
  id: `https://remote.example/notes/${slug}`,
  type: "Note",
  attributedTo: author.actorUri,
  published: "2026-10-20T00:00:00.000Z",
  to: [PUBLIC],
  ...extra,
});

const hashtag = (name: string) => ({ type: "Hashtag", name: `#${name}` });

/** Makes D1 refuse to store `tag` for any status until the returned function is called. */
const refuseTag = async (tag: string): Promise<() => Promise<void>> => {
  await env.DB.prepare(
    `CREATE TRIGGER inbox_retry_refuse_tag BEFORE INSERT ON remote_status_tags
     WHEN NEW.tag = '${tag}' BEGIN SELECT RAISE(ABORT, 'tag write refused'); END`,
  ).run();
  return async () => {
    await env.DB.prepare("DROP TRIGGER inbox_retry_refuse_tag").run();
  };
};

const storedId = async (objectUri: string): Promise<string | undefined> =>
  parseRows(
    z.object({ id: z.string() }),
    (
      await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
        .bind(objectUri)
        .all()
    ).results,
  )[0]?.id;

const status = async (id: string) =>
  expectContract(
    ApiStatus,
    await (await SELF.fetch(`https://example.com/api/v1/statuses/${id}`)).json(),
  );

describe("an inbox activity whose write failed", () => {
  it("answers a Create with a server error, and stores the note when the same Create is redelivered", async () => {
    const author = await remoteActor("retry-create");
    const object = note(author, "retry-create", {
      content: "<p>hello</p>",
      tag: [hashtag("retrycreate")],
    });
    const activity = { id: `${object.id}/create`, type: "Create", object };

    const allow = await refuseTag("retrycreate");
    try {
      expect(await author.send(activity)).toBe(500);
      expect(await storedId(object.id)).toBeUndefined();
    } finally {
      await allow();
    }

    expect(await author.send(activity)).toBe(202);
    const id = await storedId(object.id);
    expect(id).toBeDefined();
    expect((await status(id ?? "")).content).toBe("<p>hello</p>");
  });
});
