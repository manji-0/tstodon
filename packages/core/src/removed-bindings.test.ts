/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * The bindings OPS-7 removed: the mailer (`EMAIL`, `EMAIL_FROM`,
 * `EMAIL_TRANSPORT` and `APP_CACHE`, where captured mail went) had no caller
 * once sign-in moved to Cloudflare Access, and nothing read
 * `REMOTE_DNS_CACHE`. A feature that brings one back removes it from here.
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");

const CONFIGS = [
  "packages/worker/wrangler.jsonc",
  "e2e/a.wrangler.jsonc",
  "e2e/b.wrangler.jsonc",
  "e2e/portless-a.wrangler.jsonc",
  "e2e/portless-b.wrangler.jsonc",
  "e2e/web.wrangler.jsonc",
];

const SOURCES = [
  "packages/core/src",
  "packages/domain/src",
  "packages/worker/server",
  "packages/worker/app",
];

const REMOVED = /\b(?:EMAIL_TRANSPORT|EMAIL_FROM|APP_CACHE|REMOTE_DNS_CACHE)\b|env\.EMAIL\b/;

const sourceFiles = (): ReadonlyArray<string> =>
  SOURCES.flatMap((dir) =>
    readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" })
      .map((entry) => `${dir}/${entry.split(path.sep).join("/")}`)
      .filter((file) => file.endsWith(".ts") && !file.endsWith("removed-bindings.test.ts")),
  );

describe("removed bindings (OPS-7)", () => {
  it.each(CONFIGS)("%s declares no KV namespace, mail binding or mail var", (config) => {
    const text = readFileSync(path.join(ROOT, config), "utf8");
    expect(text).not.toMatch(/"kv_namespaces"|"send_email"/);
    expect(text).not.toMatch(REMOVED);
  });

  it("no source file names them", () => {
    const hits = sourceFiles().filter((file) =>
      REMOVED.test(readFileSync(path.join(ROOT, file), "utf8")),
    );
    expect(hits).toEqual([]);
  });

  it("Void's KV inference stays off, so a deploy adds no namespace back", () => {
    const voidJson: unknown = JSON.parse(
      readFileSync(path.join(ROOT, "packages/worker/void.json"), "utf8"),
    );
    expect(voidJson).toMatchObject({ inference: { bindings: { kv: false } } });
  });
});
