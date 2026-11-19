import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { ALL_SCOPES, authHeaders, signedInAccount } from "../test/auth-fixture";

// Mastodon v4.7.5's `Api::V1::Statuses::InteractionPoliciesController`.

const send = async (
  email: string | undefined,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  scopes: ReadonlyArray<string> = ALL_SCOPES,
) => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(email === undefined ? {} : await authHeaders(email, { scopes })),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
};

const post = async (email: string, body: Record<string, unknown>) => {
  const response = await send(email, "POST", "/api/v1/statuses", body);
  expect(response.status).toBe(200);
  return expectContract(ApiStatus, response.body);
};

const setPolicy = (email: string, id: string, body: Record<string, unknown> = {}) =>
  send(email, "PUT", `/api/v1/statuses/${id}/interaction_policy`, body);

const UpdateActivity = z.object({
  type: z.literal("Update"),
  published: z.string(),
  object: z.looseObject({
    id: z.string(),
    updated: z.string().optional(),
    interactionPolicy: z.object({
      canQuote: z.object({ automaticApproval: z.array(z.string()) }),
    }),
  }),
});

/** The `Update`s queued for the author's followers, oldest first. */
const updates = async (accountId: string) => {
  const rows = await env.DB.prepare(
    "SELECT payload_json FROM outbound_activities WHERE account_id = ? AND kind = 'Update' ORDER BY rowid",
  )
    .bind(accountId)
    .all();
  return rows.results.map((row) =>
    UpdateActivity.parse(
      JSON.parse(z.object({ payload_json: z.string() }).parse(row).payload_json),
    ),
  );
};

describe("PUT /api/v1/statuses/:id/interaction_policy", () => {
  it("changes a published status's quote policy and federates an Update without an edit", async () => {
    const author = "policy-put-author@example.com";
    const other = "policy-put-other@example.com";
    const account = await signedInAccount(author);
    const status = await post(author, { status: "quote me, then do not" });
    expect(status.quote_approval.automatic).toEqual(["public"]);
    const before = (await updates(account.id)).length;

    const changed = await setPolicy(author, status.id, { quote_approval_policy: "nobody" });
    expect(changed.status).toBe(200);
    const rendered = expectContract(ApiStatus, changed.body);
    expect(rendered).toMatchObject({ id: status.id, edited_at: null });
    expect(rendered.quote_approval).toEqual({
      automatic: [],
      manual: [],
      current_user: "automatic",
    });
    expect(
      (await send(other, "POST", "/api/v1/statuses", { status: "no", quoted_status_id: status.id }))
        .status,
    ).toBe(404);

    const sent = await updates(account.id);
    expect(sent).toHaveLength(before + 1);
    const update = sent.at(-1);
    expect(update?.object.id).toBe(status.uri);
    expect(update?.object.interactionPolicy.canQuote.automaticApproval).toEqual([
      `https://example.com/users/${account.username}`,
    ]);
    // The note was never edited, so its `Update` claims no edit.
    expect(update?.object.updated).toBeUndefined();

    // The same policy again changes nothing and sends nothing.
    const same = await setPolicy(author, status.id, { quote_approval_policy: "nobody" });
    expect(same.status).toBe(200);
    expect(await updates(account.id)).toHaveLength(before + 1);

    // Without a policy the author's default applies.
    const reset = await setPolicy(author, status.id);
    expect(expectContract(ApiStatus, reset.body).quote_approval.automatic).toEqual(["public"]);
    expect(await updates(account.id)).toHaveLength(before + 2);
    expect((await updates(account.id)).at(-1)?.object.interactionPolicy).toEqual({
      canQuote: expect.objectContaining({
        automaticApproval: ["https://www.w3.org/ns/activitystreams#Public"],
      }),
    });
    const fan = await send(other, "POST", "/api/v1/statuses", {
      status: "now I may",
      quoted_status_id: status.id,
    });
    expect(fan.status).toBe(200);
  });

  it("keeps an edited note's own edit time in the Update", async () => {
    const author = "policy-put-edited@example.com";
    const account = await signedInAccount(author);
    const status = await post(author, { status: "first" });
    const edited = await send(author, "PUT", `/api/v1/statuses/${status.id}`, { status: "second" });
    const editedAt = expectContract(ApiStatus, edited.body).edited_at;
    expect(editedAt).not.toBeNull();

    const changed = await setPolicy(author, status.id, { quote_approval_policy: "followers" });
    expect(expectContract(ApiStatus, changed.body)).toMatchObject({
      edited_at: editedAt,
      quote_approval: { automatic: ["followers"] },
    });
    const update = (await updates(account.id)).at(-1);
    expect(update?.object.updated).toBe(editedAt);
    expect(update?.published).not.toBe(editedAt);
  });

  it("keeps a followers-only or direct status unquotable and sends nothing", async () => {
    const author = "policy-put-private@example.com";
    const account = await signedInAccount(author);
    const before = (await updates(account.id)).length;
    for (const visibility of ["private", "direct"]) {
      const status = await post(author, { status: `only some (${visibility})`, visibility });
      const changed = await setPolicy(author, status.id, { quote_approval_policy: "public" });
      expect(changed.status).toBe(200);
      expect(expectContract(ApiStatus, changed.body).quote_approval.automatic).toEqual([]);
    }
    expect(await updates(account.id)).toHaveLength(before);
  });

  it("answers 422 for a policy Mastodon does not know", async () => {
    const author = "policy-put-invalid@example.com";
    const status = await post(author, { status: "strict" });
    for (const policy of ["everyone", "Public"]) {
      const refused = await setPolicy(author, status.id, { quote_approval_policy: policy });
      expect(refused).toEqual({ status: 422, body: { error: "Record invalid" } });
    }
  });

  it("refuses another account's status with 403 and one the account cannot see with 404", async () => {
    const author = "policy-put-owner@example.com";
    const other = "policy-put-intruder@example.com";
    const open = await post(author, { status: "mine" });
    const hidden = await post(author, { status: "mine alone", visibility: "private" });

    const forbidden = await setPolicy(other, open.id, { quote_approval_policy: "nobody" });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toMatchObject({ error: "This action is not allowed" });
    expect((await setPolicy(other, hidden.id)).status).toBe(404);
    expect((await setPolicy(other, "999999999")).status).toBe(404);
  });

  it("needs write:statuses", async () => {
    const author = "policy-put-scopes@example.com";
    const status = await post(author, { status: "scoped" });
    const path = `/api/v1/statuses/${status.id}/interaction_policy`;
    expect((await send(undefined, "PUT", path, {})).status).toBe(401);
    expect((await send(author, "PUT", path, {}, ["read"])).status).toBe(403);
    expect((await send(author, "PUT", path, {}, ["write:statuses"])).status).toBe(200);
  });
});
