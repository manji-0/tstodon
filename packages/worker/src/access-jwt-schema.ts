import { warmSchemas } from "@tstodon/core";
import { z } from "zod";

export const JoseErrorCodeSchema = z.object({
  code: z.string().min(1),
});

export const AccessJwtSchema = z
  .object({
    sub: z.string().min(1),
    email: z.string().min(1).optional(),
    type: z.string().optional(),
    groups: z.array(z.string()).optional(),
    custom: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const JsonWebKeySchema = z
  .object({
    kty: z.string().min(1),
    kid: z.string().optional(),
    alg: z.string().optional(),
  })
  .passthrough();

export const AccessJwksSchema = z.object({
  keys: z.array(JsonWebKeySchema).min(1),
});

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([JoseErrorCodeSchema, AccessJwtSchema, JsonWebKeySchema, AccessJwksSchema]);
