/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * Every `Sensitive#reveal()` outside tests, per file. A new reveal fails this
 * test until it is added here, so each one shows up in review with its reason.
 */
const REVEAL_SITES: Readonly<Record<string, number>> = {
  // Writes the Access email onto the linked Better Auth user row.
  "packages/worker/server/access-session.ts": 1,
  // Writes the address and private key, and looks an account up by address.
  "packages/worker/server/account-store.ts": 3,
  // Shows a user the IP address of their own sessions.
  "packages/worker/server/account-security-pages.ts": 1,
  // The admin account list and page show the address (Mastodon's `/admin/accounts`).
  "packages/worker/server/admin-pages.ts": 2,
  // Imports the RSA key to sign a delivery.
  "packages/worker/server/http-signature.ts": 1,
  // Stores a newly generated instance actor key.
  "packages/worker/server/instance-actor.ts": 1,
  // The recipient of an outgoing email.
  "packages/worker/server/mailer.ts": 1,
  // Domain and canonical-hash sign-up block checks.
  "packages/worker/server/registration-block-store.ts": 2,
  // The admin API's `Admin::Account#email`.
  "packages/worker/server/routes/admin/accounts.ts": 1,
  // Imports the VAPID key to sign a push.
  "packages/worker/server/web-push.ts": 1,
};

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SCANNED = [
  "packages/core/src",
  "packages/domain/src",
  "packages/worker/server",
  "packages/worker/app",
];

const isRuntimeSource = (file: string): boolean =>
  file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.includes("/generated/");

const revealSites = (): Record<string, number> => {
  const files = SCANNED.flatMap((dir) =>
    readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" })
      .map((entry) => `${dir}/${entry.split(path.sep).join("/")}`)
      .filter(isRuntimeSource),
  );
  return Object.fromEntries(
    files.flatMap((file): Array<[string, number]> => {
      const count = readFileSync(path.join(ROOT, file), "utf8").match(/\.reveal\(\)/g)?.length ?? 0;
      return count === 0 ? [] : [[file, count]];
    }),
  );
};

describe("Sensitive reveal sites", () => {
  it("lists every reveal() outside tests in REVEAL_SITES", () => {
    expect(revealSites()).toEqual(REVEAL_SITES);
  });
});
