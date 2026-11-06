import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const json = async (path: string, init?: RequestInit) => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  return { status: response.status, body: await response.json() };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const QuoteApprovalSchema = z.object({
  automatic: z.array(z.string()),
  manual: z.array(z.string()),
  current_user: z.string(),
});

const note = async (
  author: Remote,
  slug: string,
  extra: Record<string, unknown> = {},
): Promise<{ uri: string; id: string }> => {
  const uri = `https://remote.example/notes/${slug}`;
  const object = {
    id: uri,
    type: "Note",
    attributedTo: author.actorUri,
    content: `<p>${slug}</p>`,
    published: "2026-11-01T00:00:00.000Z",
    to: [PUBLIC],
    cc: [`${author.actorUri}/followers`],
    ...extra,
  };
  expect(await author.send({ id: `${uri}/activity`, type: "Create", object })).toBe(202);
  const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
    .bind(uri)
    .first<{ id: string }>();
  if (!row) {
    throw new Error("remote note was not stored");
  }
  return { uri, id: row.id };
};

const quoteApproval = async (statusId: string, email: string | undefined) => {
  const response = await json(`/api/v1/statuses/${statusId}`, {
    headers: email === undefined ? {} : await authHeaders(email),
  });
  expect(response.status).toBe(200);
  return read(z.object({ quote_approval: QuoteApprovalSchema }), response.body).quote_approval;
};

const canQuote = (canQuote: Record<string, unknown>) => ({ interactionPolicy: { canQuote } });

/** Follow `remote` as `email`; it stays requested until `remote` accepts. */
const followRemote = async (email: string, remote: Remote): Promise<string> => {
  const followed = await json(
    `/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/follow`,
    { method: "POST", headers: await authHeaders(email) },
  );
  expect(followed.status).toBe(200);
  const account = await signedInAccount(email);
  const row = await env.DB.prepare(
    "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
  )
    .bind(account.id, remote.actorUri)
    .first<{ follow_activity_id: string }>();
  if (!row) {
    throw new Error("no Follow was recorded");
  }
  return row.follow_activity_id;
};

describe("remote quote policies", () => {
  it("lets anyone quote under a public automatic policy", async () => {
    const bob = await remoteActor("quote-policy-public");
    const status = await note(
      bob,
      "quote-policy-public",
      canQuote({ automaticApproval: [PUBLIC] }),
    );

    expect(await quoteApproval(status.id, "quote-policy-public@example.com")).toEqual({
      automatic: ["public"],
      manual: [],
      current_user: "automatic",
    });
  });

  it("lets the author's followers quote once the follow is accepted", async () => {
    const bob = await remoteActor("quote-policy-followers");
    const email = "quote-policy-followers@example.com";
    const status = await note(
      bob,
      "quote-policy-followers",
      canQuote({ automaticApproval: [`${bob.actorUri}/followers`] }),
    );

    expect(await quoteApproval(status.id, email)).toEqual({
      automatic: ["followers"],
      manual: [],
      current_user: "denied",
    });
    const followId = await followRemote(email, bob);
    expect((await quoteApproval(status.id, email)).current_user).toBe("denied");

    expect(
      await bob.send({
        id: `${bob.actorUri}/accepts/quote-policy`,
        type: "Accept",
        object: followId,
      }),
    ).toBe(202);
    expect((await quoteApproval(status.id, email)).current_user).toBe("automatic");
  });

  it("lets the accounts the author follows quote under a following policy", async () => {
    const bob = await remoteActor("quote-policy-following");
    const email = "quote-policy-following@example.com";
    const viewer = await signedInAccount(email);
    const status = await note(
      bob,
      "quote-policy-following",
      canQuote({ automaticApproval: [`${bob.actorUri}/following`] }),
    );
    expect((await quoteApproval(status.id, email)).current_user).toBe("denied");

    expect(
      await bob.send({
        id: `${bob.actorUri}/follows/quote-policy`,
        type: "Follow",
        object: `https://example.com/users/${viewer.username}`,
      }),
    ).toBe(202);
    expect(await quoteApproval(status.id, email)).toEqual({
      automatic: ["following"],
      manual: [],
      current_user: "automatic",
    });
  });

  it("answers manual under a manual approval policy", async () => {
    const bob = await remoteActor("quote-policy-manual");
    const status = await note(bob, "quote-policy-manual", canQuote({ manualApproval: [PUBLIC] }));

    expect(await quoteApproval(status.id, "quote-policy-manual@example.com")).toEqual({
      automatic: [],
      manual: ["public"],
      current_user: "manual",
    });
  });

  it("answers unknown for an audience this server cannot check", async () => {
    const bob = await remoteActor("quote-policy-unknown");
    const status = await note(
      bob,
      "quote-policy-unknown",
      canQuote({ automaticApproval: ["https://other.example/users/carol", bob.actorUri] }),
    );

    expect(await quoteApproval(status.id, "quote-policy-unknown@example.com")).toEqual({
      automatic: ["unsupported_policy"],
      manual: [],
      current_user: "unknown",
    });
  });

  it("lets nobody quote a note without a policy", async () => {
    const bob = await remoteActor("quote-policy-none");
    const status = await note(bob, "quote-policy-none");

    expect(await quoteApproval(status.id, "quote-policy-none@example.com")).toEqual({
      automatic: [],
      manual: [],
      current_user: "denied",
    });
  });

  it("follows an Update that drops the policy", async () => {
    const bob = await remoteActor("quote-policy-update");
    const email = "quote-policy-update@example.com";
    const status = await note(
      bob,
      "quote-policy-update",
      canQuote({ automaticApproval: [PUBLIC] }),
    );
    expect((await quoteApproval(status.id, email)).current_user).toBe("automatic");

    expect(
      await bob.send({
        id: `${status.uri}/updates/1`,
        type: "Update",
        object: {
          id: status.uri,
          type: "Note",
          attributedTo: bob.actorUri,
          content: "<p>quote-policy-update</p>",
          published: "2026-11-01T00:00:00.000Z",
          updated: "2026-11-02T00:00:00.000Z",
          to: [PUBLIC],
          cc: [`${bob.actorUri}/followers`],
        },
      }),
    ).toBe(202);
    expect(await quoteApproval(status.id, email)).toEqual({
      automatic: [],
      manual: [],
      current_user: "denied",
    });
  });

  it("denies an anonymous viewer, as Mastodon does", async () => {
    const bob = await remoteActor("quote-policy-anonymous");
    const status = await note(
      bob,
      "quote-policy-anonymous",
      canQuote({ automaticApproval: [PUBLIC] }),
    );

    expect(await quoteApproval(status.id, undefined)).toEqual({
      automatic: ["public"],
      manual: [],
      current_user: "denied",
    });
  });
});
