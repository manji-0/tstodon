import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { type z } from "zod";
import type { RepositoryError } from "./d1";
import { toRepositoryError } from "./d1";

export const parseJsonText = (raw: string): Result<unknown, RepositoryError> => {
  try {
    return ok(JSON.parse(raw));
  } catch {
    return err(toRepositoryError("invalid json"));
  }
};

export const parseJsonColumn = <T>(schema: z.ZodType<T>, raw: string): Result<T, RepositoryError> =>
  parseJsonText(raw).andThen((value) =>
    schemaResult(schema)(value).mapErr(() => toRepositoryError("invalid json column")),
  );
