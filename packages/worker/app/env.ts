import { defineEnv, string } from "void/env";

/**
 * The Worker's secrets: Void reads them from `.env` under `pnpm dev`, and in
 * production from Worker secrets set with `void secret put`, which refuses a
 * name not declared here. Plaintext settings are `vars` in `void.config.ts`
 * (Void refuses a name in both). See "Vars and secrets" in
 * docs/reference/configuration.md.
 */
export default defineEnv({
  // Signs Better Auth's user and session rows. `void deploy` creates it when
  // missing and `vp dev` supplies a development one; declared so that
  // `void secret put BETTER_AUTH_SECRET` can rotate it.
  BETTER_AUTH_SECRET: string().optional(),
  // P-256 private JWK for Web Push (docs/reference/configuration.md#web-push).
  // Without it the instance advertises no `vapid_key` and sends no pushes.
  VAPID_PRIVATE_JWK: string().optional(),
});
