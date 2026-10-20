import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";

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

const IdSchema = z.object({ id: z.string().min(1) });
const IdListSchema = z.array(IdSchema);

const verify = async (email: string): Promise<string> =>
  read(
    IdSchema,
    (await json("/api/v1/accounts/verify_credentials", { headers: await accessAuthHeaders(email) }))
      .body,
  ).id;

const post = async (email: string, status: string, visibility: string): Promise<string> =>
  read(
    IdSchema,
    (
      await json("/api/v1/statuses", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await accessAuthHeaders(email)) },
        body: JSON.stringify({ status, visibility }),
      })
    ).body,
  ).id;

describe("multiple lookups", () => {
  it("returns the requested accounts in order and skips unknown ids", async () => {
    const first = await verify("multi-account-1@example.com");
    const second = await verify("multi-account-2@example.com");
    const listed = await json(
      `/api/v1/accounts?id[]=${second}&id[]=missing-account&id[]=${first}&id[]=${second}`,
    );
    expect(listed.status).toBe(200);
    expect(read(IdListSchema, listed.body).map((account) => account.id)).toEqual([second, first]);
    expect(read(IdListSchema, (await json("/api/v1/accounts")).body)).toEqual([]);
  });

  it("returns only the statuses the viewer may see", async () => {
    const email = "multi-status@example.com";
    const open = await post(email, "public multi", "public");
    const hidden = await post(email, "private multi", "private");
    const path = `/api/v1/statuses?id[]=${hidden}&id[]=${open}&id[]=missing-status`;

    const anonymous = await json(path);
    expect(anonymous.status).toBe(200);
    expect(read(IdListSchema, anonymous.body).map((status) => status.id)).toEqual([open]);

    const author = await json(path, { headers: await accessAuthHeaders(email) });
    expect(read(IdListSchema, author.body).map((status) => status.id)).toEqual([hidden, open]);
  });

  it("caps the status batch at twenty ids", async () => {
    const email = "multi-status-cap@example.com";
    const ids: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      ids.push(await post(email, `cap ${index}`, "public"));
    }
    const listed = await json(`/api/v1/statuses?${ids.map((id) => `id[]=${id}`).join("&")}`);
    expect(read(IdListSchema, listed.body).map((status) => status.id)).toEqual(ids.slice(0, 20));
  });
});
