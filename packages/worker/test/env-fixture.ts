import { env } from "cloudflare:test";

/** The test Worker's `Env` with `vars` in place of its string variables. */
export const envWith = (vars: Readonly<Record<string, string>>): Env => ({ ...env, ...vars });
