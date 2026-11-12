import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";
import { notifyFromRemoteOnce } from "./notify";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

/** A public note `author` sent, as the id it is stored under. */
const storedNote = async (author: Remote, slug: string): Promise<string> => {
  const object = {
    id: `https://remote.example/notes/${slug}`,
    type: "Note",
    attributedTo: author.actorUri,
    content: "<p>hello</p>",
    published: "2026-10-20T00:00:00.000Z",
    to: [PUBLIC],
  };
  expect(await author.send({ id: `${object.id}/create`, type: "Create", object })).toBe(202);
  const row = parseRows(
    z.object({ id: z.string() }),
    (
      await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
        .bind(object.id)
        .all()
    ).results,
  )[0];
  if (!row) {
    throw new Error(`remote note ${slug} was not stored`);
  }
  return row.id;
};

const notified = async (email: string, kind: string, statusId: string): Promise<number> =>
  expectContract(
    z.array(z.object({ status: z.object({ id: z.string() }) })),
    await (
      await SELF.fetch(`https://example.com/api/v1/notifications?types[]=${kind}`, {
        headers: await authHeaders(email),
      })
    ).json(),
  ).filter((entry) => entry.status.id === statusId).length;

describe("notifyFromRemoteOnce", () => {
  it("notifies an account once when the same mention is requested twice", async () => {
    const email = "notify-once-mention@example.com";
    const recipient = await signedInAccount(email);
    const author = await remoteActor("notify-once-mention");
    const statusId = await storedNote(author, "notify-once-mention");
    const mention = {
      accountId: recipient.id,
      actorUri: author.actorUri,
      kind: "mention",
      statusId,
    };

    expect((await notifyFromRemoteOnce(env, mention)).isOk()).toBe(true);
    expect((await notifyFromRemoteOnce(env, mention)).isOk()).toBe(true);

    expect(await notified(email, "mention", statusId)).toBe(1);
  });

  it("notifies an account once when the same mention is requested twice at once", async () => {
    const email = "notify-once-concurrent@example.com";
    const recipient = await signedInAccount(email);
    const author = await remoteActor("notify-once-concurrent");
    const statusId = await storedNote(author, "notify-once-concurrent");
    const mention = {
      accountId: recipient.id,
      actorUri: author.actorUri,
      kind: "mention",
      statusId,
    };

    const sent = await Promise.all([
      notifyFromRemoteOnce(env, mention),
      notifyFromRemoteOnce(env, mention),
      notifyFromRemoteOnce(env, mention),
    ]);

    expect(sent.every((result) => result.isOk())).toBe(true);
    expect(await notified(email, "mention", statusId)).toBe(1);
  });

  it("notifies again when the stored notification is older than `since`", async () => {
    const email = "notify-once-since@example.com";
    const recipient = await signedInAccount(email);
    const author = await remoteActor("notify-once-since");
    const statusId = await storedNote(author, "notify-once-since");
    const update = { accountId: recipient.id, actorUri: author.actorUri, kind: "update", statusId };

    expect((await notifyFromRemoteOnce(env, update)).isOk()).toBe(true);
    await env.DB.prepare(
      "UPDATE notifications SET created_at = '2026-10-20T00:00:00.000Z' WHERE account_id = ? AND status_id = ?",
    )
      .bind(recipient.id, statusId)
      .run();
    expect((await notifyFromRemoteOnce(env, update, "2026-10-20T00:00:00.000Z")).isOk()).toBe(true);
    expect(await notified(email, "update", statusId)).toBe(1);

    expect((await notifyFromRemoteOnce(env, update, "2026-10-21T00:00:00.000Z")).isOk()).toBe(true);
    expect(await notified(email, "update", statusId)).toBe(2);
  });
});
