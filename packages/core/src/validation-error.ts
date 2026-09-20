import type { StandardSchemaV1 } from "@standard-schema/spec";

export type ValidationError = Readonly<{
  kind: "ValidationError";
  issues: ReadonlyArray<StandardSchemaV1.Issue>;
}>;
