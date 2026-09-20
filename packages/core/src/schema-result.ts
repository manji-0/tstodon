import { err, ok, type Result } from "neverthrow";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ValidationError } from "./validation-error";

export const schemaResult =
  <T>(schema: StandardSchemaV1<unknown, T>) =>
  (raw: unknown): Result<T, ValidationError> => {
    const result = schema["~standard"].validate(raw);
    if (result instanceof Promise) {
      throw new TypeError("Schema validation must be synchronous");
    }
    if (result.issues) {
      return err({ kind: "ValidationError", issues: result.issues });
    }
    return ok(result.value);
  };
