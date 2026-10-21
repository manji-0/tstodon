import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { MastodonAccountPreviewSchema } from "../test/mastodon-preview-schemas";

const auth = (email: string): Promise<Record<string, string>> => accessAuthHeaders(email);

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

const GroupSchema = z.array(
  z.object({
    id: z.string().min(1),
    accounts: z.array(MastodonAccountPreviewSchema),
  }),
);

const credentials = async (email: string): Promise<{ id: string; username: string }> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  const account = read(MastodonAccountPreviewSchema, response.body);
  return { id: account.id, username: account.username };
};

const follow = async (email: string, targetId: string): Promise<void> => {
  const response = await json(`/api/v1/accounts/${targetId}/follow`, {
    method: "POST",
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
};

describe("familiar followers", () => {
  it("returns the viewer's follows that also follow the target", async () => {
    const viewerEmail = "fam-viewer@example.com";
    const viewer = await credentials(viewerEmail);
    const target = await credentials("fam-target@example.com");

    const familiar: string[] = [];
    for (const name of ["fam-a", "fam-b", "fam-c", "fam-d"]) {
      const account = await credentials(`${name}@example.com`);
      await follow(`${name}@example.com`, target.id);
      await follow(viewerEmail, account.id);
      familiar.push(account.username);
    }
    // Followed by the viewer but does not follow the target.
    const stranger = await credentials("fam-e@example.com");
    await follow(viewerEmail, stranger.id);

    const response = await json(`/api/v1/accounts/familiar_followers?id[]=${target.id}`, {
      headers: await auth(viewerEmail),
    });
    expect(response.status).toBe(200);
    const groups = read(GroupSchema, response.body);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe(target.id);
    const names = groups[0]?.accounts.map((account) => account.acct) ?? [];
    // Ordered by username and capped at three.
    expect(names).toEqual(["fam_a", "fam_b", "fam_c"]);
    expect(names).not.toContain(stranger.username);
    expect(viewer.id).not.toBe(target.id);
  });

  it("returns an empty group for an unknown id and requires auth", async () => {
    const response = await json("/api/v1/accounts/familiar_followers?id[]=nope", {
      headers: await auth("fam-other@example.com"),
    });
    expect(response.status).toBe(200);
    expect(read(GroupSchema, response.body)).toEqual([{ id: "nope", accounts: [] }]);

    expect((await json("/api/v1/accounts/familiar_followers?id[]=x")).status).toBe(401);
  });
});
