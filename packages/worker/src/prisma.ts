import { PrismaD1 } from "@prisma/adapter-d1";
import { PrismaClient } from "./generated/prisma/client";

/**
 * Optional PrismaClient factory (D1 adapter).
 * Runtime stores prefer `queryTyped` / `runTyped` / `d1PrepareTyped` so D1 gets
 * `?` placeholders; keep this for tooling or future Client API use.
 */
export const createPrisma = (db: D1Database): PrismaClient =>
  new PrismaClient({ adapter: new PrismaD1(db) });
