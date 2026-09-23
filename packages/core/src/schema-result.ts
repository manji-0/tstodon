import { err, ok, type Result } from "neverthrow";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import type { ValidationError } from "./validation-error";

const compiledSchemas = new WeakMap<object, StandardSchemaV1<unknown, unknown>>();
const parseFns = new WeakMap<object, (raw: unknown) => Result<unknown, ValidationError>>();

const isZodType = (schema: unknown): schema is z.ZodType =>
  typeof schema === "object" && schema !== null && "~standard" in schema && "_zod" in schema;

/** Compile a Zod schema once (WeakMap-cached). Falls back to the original when compile is refused. */
export const compileSchema = <T extends z.ZodType>(schema: T): T => {
  const cached = compiledSchemas.get(schema);
  if (cached) {
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

type ZodWithBag = z.ZodType & {
  _zod?: { bag?: { validator?: unknown } };
};

const hasValidator = (schema: z.ZodType): boolean =>
  (schema as ZodWithBag)._zod?.bag?.validator != null;

/**
 * True when a prior `compileSchema`/`warmSchemas`/`schemaResult` call already
 * cached a compiled clone for `schema`. Does not invoke `z.compile`.
 */
export const peekCompiledFastPath = (schema: z.ZodType): boolean => {
  if (hasValidator(schema)) {
    return true;
  }
  const cached = compiledSchemas.get(schema);
  return cached != null && hasValidator(cached as z.ZodType);
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
  const cached = parseFns.get(schema as object);
  if (cached) {
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

  parseFns.set(schema as object, parse as (raw: unknown) => Result<unknown, ValidationError>);
  if (effective !== schema) {
    parseFns.set(effective as object, parse as (raw: unknown) => Result<unknown, ValidationError>);
  }
  return parse;
};
