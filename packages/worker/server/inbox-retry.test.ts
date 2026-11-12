import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus, ApiStatusEdit } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";
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

/**
 * Makes D1 refuse an insert into `table` whose `column` is `value`, until the
 * returned function is called. `name` is the trigger's, one per test, so a
 * trigger a test failed to drop does not reach the next one.
 */
const refuseInsert = async (
  name: string,
  table: "remote_status_tags" | "remote_status_remote_mentions",
  column: "tag" | "actor_uri",
  value: string,
): Promise<() => Promise<void>> => {
  await env.DB.prepare(
    `CREATE TRIGGER ${name} BEFORE INSERT ON ${table}
     WHEN NEW.${column} = '${value}' BEGIN SELECT RAISE(ABORT, 'write refused'); END`,
  ).run();
  return async () => {
    await env.DB.prepare(`DROP TRIGGER ${name}`).run();
  };
};

const refuseTag = (tag: string) =>
  refuseInsert(`inbox_retry_${tag}`, "remote_status_tags", "tag", tag);

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

  it("answers an Update with a server error, and applies the edit when the same Update is redelivered", async () => {
    const author = await remoteActor("retry-update");
    const original = note(author, "retry-update", { content: "<p>before</p>" });
    expect(
      await author.send({ id: `${original.id}/create`, type: "Create", object: original }),
    ).toBe(202);
    const id = (await storedId(original.id)) ?? "";
    const edited = note(author, "retry-update", {
      content: "<p>after</p>",
      tag: [hashtag("retryupdate")],
      updated: "2026-10-21T00:00:00.000Z",
    });
    const activity = { id: `${edited.id}/update`, type: "Update", object: edited };

    const allow = await refuseTag("retryupdate");
    try {
      expect(await author.send(activity)).toBe(500);
      expect((await status(id)).content).toBe("<p>before</p>");
    } finally {
      await allow();
    }

    expect(await author.send(activity)).toBe(202);
    expect(await status(id)).toMatchObject({
      content: "<p>after</p>",
      edited_at: "2026-10-21T00:00:00.000Z",
    });
  });

  it("keeps the replaced version once in the history when a failed Update is redelivered", async () => {
    const author = await remoteActor("retry-history");
    const original = note(author, "retry-history", { content: "<p>original</p>" });
    expect(
      await author.send({ id: `${original.id}/create`, type: "Create", object: original }),
    ).toBe(202);
    const id = (await storedId(original.id)) ?? "";
    const edited = note(author, "retry-history", {
      content: "<p>edited</p>",
      tag: [hashtag("retryhistory")],
      updated: "2026-10-21T00:00:00.000Z",
    });
    const activity = { id: `${edited.id}/update`, type: "Update", object: edited };

    const allow = await refuseTag("retryhistory");
    try {
      expect(await author.send(activity)).toBe(500);
    } finally {
      await allow();
    }
    expect(await author.send(activity)).toBe(202);

    const history = expectContract(
      z.array(ApiStatusEdit),
      await (await SELF.fetch(`https://example.com/api/v1/statuses/${id}/history`)).json(),
    );
    expect(history.map((version) => version.content)).toEqual(["<p>original</p>", "<p>edited</p>"]);
  });

  it("notifies a newly mentioned account once when an Update that failed after its mention was recorded is redelivered", async () => {
    const headers = await authHeaders("inbox-retry-mention@example.com");
    const account = expectContract(
      z.object({ username: z.string() }),
      await (
        await SELF.fetch("https://example.com/api/v1/accounts/verify_credentials", { headers })
      ).json(),
    );
    const actorUrl = `https://example.com/users/${account.username}`;
    const elsewhere = "https://elsewhere.example/users/retry-mentioned";
    const author = await remoteActor("retry-mention");
    const original = note(author, "retry-mention", { content: "<p>hi</p>" });
    expect(
      await author.send({ id: `${original.id}/create`, type: "Create", object: original }),
    ).toBe(202);
    const id = (await storedId(original.id)) ?? "";
    const edited = note(author, "retry-mention", {
      content: "<p>hi @you @them</p>",
      tag: [
        { type: "Mention", href: actorUrl },
        { type: "Mention", href: elsewhere },
      ],
      cc: [actorUrl],
      updated: "2026-10-21T00:00:00.000Z",
    });
    const activity = { id: `${edited.id}/update`, type: "Update", object: edited };

    const allow = await refuseInsert(
      "inbox_retry_remote_mention",
      "remote_status_remote_mentions",
      "actor_uri",
      elsewhere,
    );
    try {
      expect(await author.send(activity)).toBe(500);
    } finally {
      await allow();
    }
    expect(await author.send(activity)).toBe(202);

    const mentions = expectContract(
      z.array(z.object({ status: z.object({ id: z.string() }) })),
      await (
        await SELF.fetch("https://example.com/api/v1/notifications?types[]=mention", { headers })
      ).json(),
    );
    expect(mentions.filter((entry) => entry.status.id === id)).toHaveLength(1);
  });
});
