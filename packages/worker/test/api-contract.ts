import { schemaResult } from "@tstodon/core";
import { expect } from "vite-plus/test";
import type { z } from "zod";

/**
 * An API response body parsed with its `@tstodon/api` schema, the REST
 * contract the web UI reads. A body that does not match fails the test with
 * each mismatch's path, so a test that asserts behaviour also checks the
 * shape. Only tests parse with the contract; the Worker does not.
 */
export const expectContract = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    const issues = parsed.error.issues.map(
      (issue) =>
        `${(issue.path ?? []).map((key) => String(typeof key === "object" ? key.key : key)).join(".") || "(root)"}: ${issue.message}`,
    );
    expect.fail(`response does not match the API contract:\n${issues.join("\n")}`);
  }
  return parsed.value;
};
