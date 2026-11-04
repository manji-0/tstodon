import { err, ok, type Result } from "neverthrow";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import type { ValidationError } from "./validation-error";

// Each cached value has the type its key schema names. TypeScript cannot tie a
// value's type to its key's, so reading these caches back takes the package's
// only two type assertions.
const compiledSchemas = new WeakMap<z.ZodType, z.ZodType>();
const parseFns = new WeakMap<object, (raw: unknown) => Result<unknown, ValidationError>>();

const isZodType = (schema: unknown): schema is z.ZodType =>
  typeof schema === "object" && schema !== null && "~standard" in schema && "_zod" in schema;

/** Compile a Zod schema once (WeakMap-cached). Falls back to the original when compile is refused. */
export const compileSchema = <T extends z.ZodType>(schema: T): T => {
  const cached = compiledSchemas.get(schema);
  if (cached) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- keyed by schema, see above
    return cached as T;
  }
  let compiled: T;
  try {
    compiled = z.compile(schema);
  } catch {
    compiled = schema;
  }
  compiledSchemas.set(schema, compiled);
  if (compiled !== schema) {
    compiledSchemas.set(compiled, compiled);
  }
  return compiled;
};

const hasValidator = (schema: z.ZodType): boolean => schema._zod.bag["validator"] != null;

/**
 * True when a prior `compileSchema`/`warmSchemas`/`schemaResult` call already
 * cached a compiled clone for `schema`. Does not invoke `z.compile`.
 */
export const peekCompiledFastPath = (schema: z.ZodType): boolean => {
  if (hasValidator(schema)) {
    return true;
  }
  const cached = compiledSchemas.get(schema);
  return cached != null && hasValidator(cached);
};

/** True when `compileSchema` installed a compiled fast-path validator on the schema. */
export const hasCompiledFastPath = (schema: z.ZodType): boolean =>
  hasValidator(compileSchema(schema));

/** Eagerly compile schemas during module init (Workers startup `new Function` window). */
export const warmSchemas = (schemas: ReadonlyArray<z.ZodType>): void => {
  for (const schema of schemas) {
    compileSchema(schema);
  }
};

export const schemaResult = <T>(
  schema: StandardSchemaV1<unknown, T>,
): ((raw: unknown) => Result<T, ValidationError>) => {
  const cached = parseFns.get(schema);
  if (cached) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- keyed by schema, see above
    return cached as (raw: unknown) => Result<T, ValidationError>;
  }

  const effective: StandardSchemaV1<unknown, T> = isZodType(schema)
    ? compileSchema(schema)
    : schema;

  const parse = (raw: unknown): Result<T, ValidationError> => {
    const result = effective["~standard"].validate(raw);
    if (result instanceof Promise) {
      throw new TypeError("Schema validation must be synchronous");
    }
    if (result.issues) {
      return err({ kind: "ValidationError", issues: result.issues });
    }
    return ok(result.value);
  };

  parseFns.set(schema, parse);
  if (effective !== schema) {
    parseFns.set(effective, parse);
  }
  return parse;
};
