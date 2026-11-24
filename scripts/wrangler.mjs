#!/usr/bin/env node
// Runs Wrangler in packages/worker against the Worker's Cloudflare config.
// That config is `cloudflare` in packages/worker/void.config.ts; Void writes
// it to the gitignored `.void-wrangler.jsonc` only when Vite loads the app,
// so write the same file first (Void would write identical text), then run
// `wrangler <args> --config .void-wrangler.jsonc`.
//
//   pnpm wrangler:worker types --env-interface Env
//   pnpm wrangler:worker d1 migrations apply tstodon --local
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import config from "../packages/worker/void.config.ts";

const worker = path.join(import.meta.dirname, "../packages/worker");
const configFile = ".void-wrangler.jsonc";

writeFileSync(path.join(worker, configFile), `${JSON.stringify(config.cloudflare, null, 2)}\n`);
const result = spawnSync(
  "pnpm",
  ["exec", "wrangler", ...process.argv.slice(2), "--config", configFile],
  { cwd: worker, stdio: "inherit" },
);
process.exit(result.status ?? 1);
