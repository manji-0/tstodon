// Void's project config. `cloudflare` is the Worker's Cloudflare config (what
// a root `wrangler.jsonc` held before Void 1.x): Void writes it, merged with
// what it infers from `app/` (crons, queue consumers, the generated entry), to
// the gitignored `.void-wrangler.jsonc` for its build, dev server and deploy.
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { defineConfig, type VoidConfig } from "void/config";
import { z } from "zod";

const workerRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(workerRoot, "../..");

const production: VoidConfig["cloudflare"] = {
  name: "tstodon",
  // Void generates the Worker entry (`.void/entry.ts`) from `app/` and
  // replaces `main`; this one only lets `wrangler types` type the class bindings.
  main: "server/entry-classes.ts",
  compatibility_date: "2026-09-20",
  compatibility_flags: ["nodejs_compat"],
  placement: {
    region: "aws:ap-southeast-1",
  },
  observability: {
    enabled: true,
    // Streaming clients may send their bearer token as `?access_token=`
    // (Mastodon's API allows it), which logs and traces would otherwise keep.
    redact_query_string: true,
    logs: {
      enabled: true,
      head_sampling_rate: 1,
    },
    traces: {
      enabled: true,
      head_sampling_rate: 1,
    },
  },
  assets: {
    // The Cloudflare Vite plugin serves and deploys the client build
    // (`dist/client`: the frontend and `public/`) in its place.
    directory: "./public",
    binding: "ASSETS",
    html_handling: "auto-trailing-slash",
    not_found_handling: "none",
    run_worker_first: true,
  },
  // Plaintext Worker vars. Secrets are declared in `app/env.ts` instead and
  // set with `void secret put`; Void refuses a name that is in both.
  vars: {
    INSTANCE_DOMAIN: "example.com",
    INSTANCE_PUBLIC_ORIGIN: "https://example.com",
    FEDERATION_ALLOW_HOSTS: "",
    INSTANCE_NAME: "tstodon",
    INSTANCE_DESCRIPTION: "Cloudflare Workers + D1 + R2 + Queues based Mastodon-compatible server",
    SOURCE_URL: "https://github.com/YOUR_ORG/tstodon",
    INSTANCE_LANGUAGES: "ja,en",
    CONTACT_EMAIL: "admin@example.com",
    INSTANCE_RULES: '["Be kind to others.","No spam or harassment."]',
    REGISTRATION_APPROVAL: "false",
    POLL_UPDATE_DELAY_SECONDS: "180",
    USER_ACTIVE_DAYS: "7",
    REGISTRATIONS_OPEN: "true",
    ADMIN_USERNAMES: "",
    CUSTOM_EMOJIS: '[{"shortcode":"tstodon","url":"https://media.example.com/emoji/tstodon.png"}]',
    INSTANCE_EXTENDED_DESCRIPTION:
      '{"content":"<p>tstodon is a local-first Cloudflare Workers server.</p>"}',
    INSTANCE_PRIVACY_POLICY:
      '{"content":"<p>This instance stores only what federation requires.</p>","updated_at":"2026-01-01T00:00:00.000Z"}',
    INSTANCE_TERMS_OF_SERVICE: '{"content":"<p>Be kind.</p>","effective_date":"2026-01-01"}',
    ANNOUNCEMENTS: '[{"id":"1","content":"Welcome to tstodon!","reactions":["🎉"]}]',
    INSTANCE_THUMBNAIL_DESCRIPTION: "tstodon instance thumbnail",
    INSTANCE_THUMBNAIL_URL: "https://media.example.com/site/thumbnail.png",
    MEDIA_PUBLIC_BASE_URL: "https://media.example.com",
  },
  d1_databases: [
    {
      binding: "DB",
      database_name: "tstodon",
      database_id: "00000000-0000-0000-0000-000000000000",
      migrations_dir: "./app/db/migrations",
    },
  ],
  r2_buckets: [
    {
      binding: "MEDIA",
      bucket_name: "tstodon-media",
    },
  ],
  // Cron triggers and the queue consumers come from `app/crons` and `app/queues`
  // (the outbox queue's `dead_letter_queue` from its `deadLetterQueue` export,
  // written by `queueDeadLetterQueues` in `void-plugins.ts`).
  queues: {
    producers: [
      {
        binding: "OUTBOX_PROCESS_QUEUE",
        queue: "tstodon-outbox-process",
      },
      {
        // Fetch work kept off the delivery queue (`app/queues/tstodon-pull.ts`).
        binding: "PULL_QUEUE",
        queue: "tstodon-pull",
      },
      {
        // The outbox queue's dead-letter queue (`app/queues/tstodon-outbox-dlq.ts`).
        binding: "OUTBOX_DLQ",
        queue: "tstodon-outbox-dlq",
      },
    ],
  },
  durable_objects: {
    bindings: [
      {
        name: "STREAM_HUB",
        class_name: "StreamHub",
      },
      {
        // One instance per rate-limit subject (address, account, token,
        // remote domain); see "Rate limits" in docs/reference/configuration.md.
        name: "RATE_LIMIT_COUNTER",
        class_name: "RateLimitCounter",
      },
    ],
  },
  workflows: [
    {
      name: "tstodon-outbox-delivery",
      binding: "OUTBOX_DELIVERY_WORKFLOW",
      class_name: "OutboxDeliveryWorkflow",
    },
  ],
  analytics_engine_datasets: [
    {
      binding: "METRICS",
      dataset: "tstodon_metrics",
    },
  ],
  images: {
    binding: "IMAGES",
  },
  migrations: [
    {
      tag: "v1",
      new_sqlite_classes: ["StreamHub"],
    },
    {
      tag: "v2",
      new_sqlite_classes: ["RateLimitCounter"],
    },
  ],
  account_id: "00000000000000000000000000000000",
};

/** What `instanceConfig` reads of a Wrangler config: its paths and its vars. */
const InstanceConfig = z.looseObject({
  main: z.string(),
  assets: z.looseObject({ directory: z.string() }),
  d1_databases: z.array(z.looseObject({ binding: z.string(), migrations_dir: z.string() })),
  vars: z.record(z.string(), z.string()),
});

const Vars = z.record(z.string(), z.string());

const parseJsonc = <T>(text: string, source: string, schema: z.ZodType<T>): T => {
  const errors: ParseError[] = [];
  const parsed = schema.safeParse(parse(text, errors, { allowTrailingComma: true }));
  if (errors.length > 0 || !parsed.success) {
    const reasons = errors.map((error) => printParseErrorCode(error.error));
    throw new Error(`${source}: ${reasons.join(", ") || parsed.error?.message}`);
  }
  return parsed.data;
};

/**
 * The e2e harnesses run `vp dev` once per instance, each with a Wrangler
 * config of its own (`e2e/*.wrangler.jsonc`, which `wrangler d1` also reads
 * for that instance's local database). `TSTODON_WRANGLER_CONFIG` names it,
 * relative to the repository root; its paths are relative to its own file.
 * `TSTODON_WRANGLER_VARS`, a JSON object, overrides some of its vars.
 */
const instanceConfig = (file: string) => {
  // Void rewrites `void.lock.json` (which a deploy writes) from this config on
  // every run, so it would record the e2e instance there.
  if (existsSync(resolve(workerRoot, "void.lock.json"))) {
    throw new Error("TSTODON_WRANGLER_CONFIG needs a checkout without void.lock.json");
  }
  const absolute = resolve(repositoryRoot, file);
  const { $schema: _schema, ...config } = parseJsonc(
    readFileSync(absolute, "utf8"),
    file,
    InstanceConfig,
  );
  const rebase = (value: string) => relative(workerRoot, resolve(dirname(absolute), value));
  const extraVars = process.env["TSTODON_WRANGLER_VARS"];
  return {
    ...config,
    main: rebase(config.main),
    assets: { ...config.assets, directory: rebase(config.assets.directory) },
    d1_databases: config.d1_databases.map((database) => ({
      ...database,
      migrations_dir: rebase(database.migrations_dir),
    })),
    vars: {
      ...config.vars,
      ...(extraVars ? parseJsonc(extraVars, "TSTODON_WRANGLER_VARS", Vars) : {}),
    },
  };
};

const instanceFile = process.env["TSTODON_WRANGLER_CONFIG"];

export default defineConfig({
  sourceDir: "app",
  inference: {
    bindings: { db: true, kv: false, storage: false, ai: false },
  },
  // A path no route answers is the Worker's 404, not Void's SPA fallback page
  // (see "Web UI" in docs/reference/configuration.md).
  routing: { notFound: "none" },
  cloudflare: instanceFile ? instanceConfig(instanceFile) : production,
});
