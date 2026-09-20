import { schemaResult } from "@tstodon/core";
import { validator } from "hono/validator";
import type { z } from "zod";

export const parseJson = <Output>(schema: z.ZodType<Output>) =>
  validator("json", (value, c) => {
    const parsed = schemaResult(schema)(value);
    if (parsed.isErr()) {
      return c.json(
        {
          kind: "ValidationError",
          issues: parsed.error.issues,
        },
        400,
      );
    }
    return parsed.value;
  });
