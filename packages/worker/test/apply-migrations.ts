import { applyD1Migrations, env } from "cloudflare:test";
import { setDefaultHostResolver } from "../server/remote-dns";

const migrations = Reflect.get(env, "TEST_MIGRATIONS");
if (!Array.isArray(migrations)) {
  throw new Error("TEST_MIGRATIONS binding is missing");
}
await applyD1Migrations(env.DB, migrations);

// Tests do not reach the network: the pool answers every unstubbed fetch 502
// (`outboundService` in the root `vite.config.ts`), and the app's own DNS
// check resolves every name to a public address here. A test that exercises
// the DNS check passes its own `resolveHost` instead.
setDefaultHostResolver(async () => ({ kind: "Resolved", addresses: ["93.184.216.34"] }));
