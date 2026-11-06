import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const QuoteApprovalSchema = z.object({
  automatic: z.array(z.string()),
  manual: z.array(z.string()),
  current_user: z.string(),
});

const send = async (email: string, path: string, body?: unknown) => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: { ...(await authHeaders(email)), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status).toBe(200);
  return response.json();
};

const post = async (email: string, body: Record<string, unknown>) =>
  read(z.object({ id: z.string() }), await send(email, "/api/v1/statuses", body)).id;

/** The status's `quote_approval` as `email` sees it, or as an anonymous viewer without one. */
const approvalAs = async (email: string | undefined, statusId: string) => {
  const response = await SELF.fetch(`https://example.com/api/v1/statuses/${statusId}`, {
    headers: email === undefined ? {} : await authHeaders(email),
  });
  expect(response.status).toBe(200);
  return read(z.object({ quote_approval: QuoteApprovalSchema }), await response.json())
    .quote_approval;
};

const people = async (slug: string) => {
  const author = `${slug}-author@example.com`;
  const follower = `${slug}-follower@example.com`;
  const stranger = `${slug}-stranger@example.com`;
  const authorAccount = await signedInAccount(author);
  await signedInAccount(follower);
  await signedInAccount(stranger);
  await send(follower, `/api/v1/accounts/${authorAccount.id}/follow`);
  return { author, follower, stranger };
};

describe("a local status's quote_approval", () => {
  it("denies an anonymous viewer and names the public audience", async () => {
    const p = await people("qa-anon");
    const status = await post(p.author, { status: "anyone", quote_approval_policy: "public" });

    expect((await approvalAs(undefined, status)).current_user).toBe("denied");
    expect(await approvalAs(undefined, status)).toEqual({
      automatic: ["public"],
      manual: [],
      current_user: "denied",
    });
    expect((await approvalAs(p.stranger, status)).current_user).toBe("automatic");
  });

  it("lets only the author's followers quote under a followers policy", async () => {
    const p = await people("qa-followers");
    const status = await post(p.author, {
      status: "followers",
      quote_approval_policy: "followers",
    });

    expect(await approvalAs(p.follower, status)).toEqual({
      automatic: ["followers"],
      manual: [],
      current_user: "automatic",
    });
    expect((await approvalAs(p.stranger, status)).current_user).toBe("denied");
    expect((await approvalAs(undefined, status)).current_user).toBe("denied");
  });

  it("lets the author quote their own status under any policy but a direct one", async () => {
    const p = await people("qa-author");
    const nobody = await post(p.author, { status: "nobody", quote_approval_policy: "nobody" });
    const followersOnly = await post(p.author, {
      status: "followers only",
      visibility: "private",
      quote_approval_policy: "public",
    });
    const direct = await post(p.author, { status: "direct", visibility: "direct" });

    expect(await approvalAs(p.author, nobody)).toEqual({
      automatic: [],
      manual: [],
      current_user: "automatic",
    });
    expect((await approvalAs(p.follower, nobody)).current_user).toBe("denied");
    expect(await approvalAs(p.author, followersOnly)).toEqual({
      automatic: [],
      manual: [],
      current_user: "automatic",
    });
    expect((await approvalAs(p.follower, followersOnly)).current_user).toBe("denied");
    expect((await approvalAs(p.author, direct)).current_user).toBe("denied");
  });
});
