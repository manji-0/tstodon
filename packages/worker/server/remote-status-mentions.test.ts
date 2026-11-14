import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";
import { RemoteAccountId } from "./remote-account-id";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const call = async (email: string, path: string, init: RequestInit = {}) => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
  });
  expect(response.status, path).toBe(200);
  return response.json();
};

/** Follow `remote` as `email`, and have it accept. */
const followRemote = async (email: string, remote: Remote): Promise<void> => {
  await call(email, `/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/follow`, {
    method: "POST",
    body: "{}",
  });
  const viewer = await signedInAccount(email);
  const [row] = parseRows(
    z.object({ follow_activity_id: z.string() }),
    (
      await env.DB.prepare(
        "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
      )
        .bind(viewer.id, remote.actorUri)
        .all()
    ).results,
  );
  expect(
    await remote.send({
      id: `${remote.actorUri}/accepts/${viewer.id}`,
      type: "Accept",
      object: row?.follow_activity_id,
    }),
  ).toBe(202);
};

const storedId = async (objectUri: string): Promise<string> => {
  const [row] = parseRows(
    z.object({ id: z.string() }),
    (
      await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
        .bind(objectUri)
        .all()
    ).results,
  );
  if (!row) {
    throw new Error(`remote note ${objectUri} was not stored`);
  }
  return row.id;
};

describe("a remote note's mentions", () => {
  it("render as Mention entities, local and remote, on the status and in the home timeline", async () => {
    const viewer = "rsm-viewer@example.com";
    const mentionedEmail = "rsm-mentioned@example.com";
    const mentioned = await signedInAccount(mentionedEmail);
    const author = await remoteActor("rsmauthor", "mentions.example");
    const bystander = await remoteActor("rsmbystander", "elsewhere.example");
    await followRemote(viewer, author);

    const noteUri = "https://mentions.example/notes/rsm-both";
    const localActorUri = `https://example.com/users/${mentioned.username}`;
    expect(
      await author.send({
        id: `${noteUri}/create`,
        type: "Create",
        object: {
          id: noteUri,
          type: "Note",
          attributedTo: author.actorUri,
          content: "<p>hello both</p>",
          published: new Date().toISOString(),
          to: [PUBLIC],
          cc: [`${author.actorUri}/followers`, bystander.actorUri, localActorUri],
          tag: [
            { type: "Mention", href: bystander.actorUri, name: "@rsmbystander@elsewhere.example" },
            { type: "Mention", href: localActorUri, name: `@${mentioned.username}@example.com` },
            { type: "Hashtag", name: "#rsmtag", href: "https://mentions.example/tags/rsmtag" },
          ],
        },
      }),
    ).toBe(202);
    const id = await storedId(noteUri);

    // What a local post renders for the same local account.
    const local = expectContract(
      ApiStatus,
      await call(mentionedEmail, "/api/v1/statuses", {
        method: "POST",
        body: JSON.stringify({ status: `@${mentioned.username} a local mention` }),
      }),
    );
    expect(local.mentions).toHaveLength(1);

    const expected = [
      ...local.mentions,
      {
        id: RemoteAccountId.encode(bystander.actorUri),
        username: "rsmbystander",
        url: bystander.actorUri,
        acct: "rsmbystander@elsewhere.example",
      },
    ];
    const status = expectContract(ApiStatus, await call(viewer, `/api/v1/statuses/${id}`));
    expect(status.mentions).toEqual(expected);
    expect(local.mentions[0]?.id).toBe(mentioned.id);

    const home = expectContract(z.array(ApiStatus), await call(viewer, "/api/v1/timelines/home"));
    expect(home.find((entry) => entry.id === id)?.mentions).toEqual(expected);

    const notifications = expectContract(
      z.array(z.object({ type: z.string(), status: ApiStatus.nullish() })),
      await call(mentionedEmail, "/api/v1/notifications?types[]=mention"),
    );
    expect(notifications.find((entry) => entry.status?.id === id)?.status?.mentions).toEqual(
      expected,
    );
  });

  it("leave out an account a quote only granted access to", async () => {
    const author = await remoteActor("rsmsilent", "mentions.example");
    const reader = await signedInAccount("rsm-silent-reader@example.com");
    const noteUri = "https://mentions.example/notes/rsm-silent";
    expect(
      await author.send({
        id: `${noteUri}/create`,
        type: "Create",
        object: {
          id: noteUri,
          type: "Note",
          attributedTo: author.actorUri,
          content: "<p>no mention here</p>",
          published: new Date().toISOString(),
          to: [PUBLIC],
        },
      }),
    ).toBe(202);
    const id = await storedId(noteUri);
    await env.DB.prepare(
      "INSERT INTO remote_status_mentions (status_id, account_id, silent) VALUES (?, ?, 1)",
    )
      .bind(id, reader.id)
      .run();
    const status = expectContract(
      ApiStatus,
      await call("rsm-silent-reader@example.com", `/api/v1/statuses/${id}`),
    );
    expect(status.mentions).toEqual([]);
  });
});

const mentionNotified = async (email: string, statusId: string): Promise<boolean> =>
  expectContract(
    z.array(z.object({ type: z.string(), status: ApiStatus.nullish() })),
    await call(email, "/api/v1/notifications?types[]=mention"),
  ).some((entry) => entry.status?.id === statusId);

const statusAs = async (email: string, id: string): Promise<Response> =>
  SELF.fetch(`https://example.com/api/v1/statuses/${id}`, { headers: await authHeaders(email) });

describe("an account a remote note only addresses", () => {
  // Mastodon's `Create#process_audience`: an audience member with no Mention tag is a silent mention.
  it("is not listed in a public note's mentions, and is not notified", async () => {
    const email = "rsm-audience@example.com";
    const addressed = await signedInAccount(email);
    const author = await remoteActor("rsmaudience", "mentions.example");
    const noteUri = "https://mentions.example/notes/rsm-audience-only";
    expect(
      await author.send({
        id: `${noteUri}/create`,
        type: "Create",
        object: {
          id: noteUri,
          type: "Note",
          attributedTo: author.actorUri,
          content: "<p>public, and cc'd</p>",
          published: new Date().toISOString(),
          to: [PUBLIC],
          cc: [`https://example.com/users/${addressed.username}`],
        },
      }),
    ).toBe(202);
    const id = await storedId(noteUri);
    const status = expectContract(ApiStatus, await call(email, `/api/v1/statuses/${id}`));
    expect(status.mentions).toEqual([]);
    expect(await mentionNotified(email, id)).toBe(false);
  });

  it("reads a direct note sent to it, without a mention or a notification", async () => {
    const email = "rsm-direct-audience@example.com";
    const addressed = await signedInAccount(email);
    const author = await remoteActor("rsmdirect", "mentions.example");
    const noteUri = "https://mentions.example/notes/rsm-direct-audience";
    expect(
      await author.send({
        id: `${noteUri}/create`,
        type: "Create",
        object: {
          id: noteUri,
          type: "Note",
          attributedTo: author.actorUri,
          content: "<p>to you, with no tag</p>",
          published: new Date().toISOString(),
          to: [`https://example.com/users/${addressed.username}`],
        },
      }),
    ).toBe(202);
    const id = await storedId(noteUri);
    const read = await statusAs(email, id);
    expect(read.status).toBe(200);
    expect(expectContract(ApiStatus, await read.json()).mentions).toEqual([]);
    expect(await mentionNotified(email, id)).toBe(false);
    expect((await statusAs("rsm-direct-stranger@example.com", id)).status).toBe(404);
  });
});
