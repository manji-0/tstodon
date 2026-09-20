import { applyD1Migrations, env } from "cloudflare:test";

const migrations = Reflect.get(env, "TEST_MIGRATIONS");
if (!Array.isArray(migrations)) {
  throw new Error("TEST_MIGRATIONS binding is missing");
}
await applyD1Migrations(env.DB, migrations);
