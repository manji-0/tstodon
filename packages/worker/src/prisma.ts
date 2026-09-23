import { PrismaD1 } from "@prisma/adapter-d1";
import { PrismaClient } from "./generated/prisma/client";

/** Per-request Prisma client bound to the Worker's D1 database. */
export const createPrisma = (db: D1Database): PrismaClient =>
  new PrismaClient({ adapter: new PrismaD1(db) });
