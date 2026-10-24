# Browser e2e (Playwright)

<!-- constrained-by ../reference/configuration.md#web-ui -->
<!-- constrained-by ../reference/configuration.md#authentication -->

## Goal

Drive Mastodon's own web UI, served by this Worker, through the basic things a person does: visit signed out, sign up (form, emailed link, passkey), post and see the post on the home timeline and profile, favourite and bookmark, follow someone and get their posts, reply, read notifications, sign out, and sign back in with the passkey.

## Run

```sh
pnpm web:build   # once, and after changing MASTODON_WEB_REF
pnpm e2e:web     # playwright test -c e2e/web/playwright.config.ts
pnpm e2e:web -g "follows"   # one scenario
```

Playwright starts the server itself (`e2e/web/serve.mjs`): it deletes `.wrangler/e2e-web`, applies the D1 migrations, and runs Void's dev server on `http://localhost:8793` with `e2e/web.wrangler.jsonc`. The host is `localhost`, not `127.0.0.1`, because WebAuthn does not accept an IP address as the relying party. Nothing else may listen on port 8793.

The browser is the Chromium Playwright 1.56 expects (`PLAYWRIGHT_BROWSERS_PATH`, or `pnpm exec playwright install chromium`). Failure traces and screenshots go to `.cache/e2e-web/results`.

## How the scenarios sign up

- Each page gets a Chromium virtual WebAuthn authenticator (`addPasskeyDevice` in `e2e/web/fixtures.ts`), so passkey prompts complete on their own. A second person (`newPerson`) is a separate browser context with its own authenticator.
- The instance runs with `EMAIL_TRANSPORT=capture`: the confirmation mail lands in the `APP_CACHE` KV namespace, and `confirmationLink` reads it with `wrangler kv key get --local`.
- The UI runs in English (`locale: "en-US"`) so the selectors can use its labels ("What's on your mind?", "Post", "Favorite", …).
- A scenario fails on any uncaught page error or 5xx from `/api/*`, as well as on its own assertions.

The scenarios share one server and database and run one at a time; each uses fresh usernames.
