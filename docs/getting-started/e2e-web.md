# Browser e2e (Playwright)

<!-- constrained-by ../reference/configuration.md#web-ui -->
<!-- constrained-by ../reference/configuration.md#authentication -->
<!-- constrained-by ../reference/configuration.md#limited-federation -->

## Goal

Drive Mastodon's own web UI, served by this Worker, through the basic things a person does: visit signed out, sign up (form, emailed link, passkey), post and see the post on the home timeline and profile, favourite and bookmark, follow someone and get their posts, reply, read notifications, sign out, and sign back in with the passkey. Streaming scenarios (`streaming.spec.ts`) keep a page open and check that a direct message, a followed person's post, a follow, a favourite, and Local and Federated posts arrive over the WebSocket with no reload and no console errors. Then edit the profile (display name and bio), post an image with alt text, and look up an account on another server.

## Run

```sh
pnpm web:build   # does nothing when the assets are already built for MASTODON_WEB_REF
pnpm e2e:web     # node e2e/web/database.mjs && playwright test -c e2e/web/playwright.config.ts
pnpm e2e:web -g "follows"   # one scenario
```

`pnpm e2e:web` first runs `e2e/web/database.mjs`, which applies the D1 migrations to a database under `.cache/e2e-web/d1/<digest>`. The digest covers `e2e/web.wrangler.jsonc` and every migration file, so the migrations run again only after one of them changes. Wrangler applies each migration in its own step, which takes about a minute on a loaded machine.

Then Playwright starts the server itself (`e2e/web/serve.mjs`): it replaces the local storage in `.wrangler/e2e-web/v3` with a copy of that database and runs Void's dev server on `http://localhost:8793` with `e2e/web.wrangler.jsonc`. It keeps Vite's dependency cache in `.wrangler/e2e-web/vite`. With that cache the server answers in about 30 seconds. Without it, after a fresh clone or a dependency change, it takes up to about 90 seconds on a loaded 4-CPU machine. The start-up budget in `playwright.config.ts` is 150 seconds. If you run `playwright test` directly, `serve.mjs` applies missing migrations itself, inside that budget. The host is `localhost`, not `127.0.0.1`, because WebAuthn does not accept an IP address as the relying party. Nothing else may listen on port 8793.

It also starts `e2e/web/remote-server.mjs` on `http://127.0.0.1:8794`: a stand-in remote Mastodon server with one account, `remote_alice`, served the way Mastodon serves it (WebFinger, an ActivityPub `Person` with a key, bio and avatar, an outbox with one public note). It accepts and drops inbox deliveries and does not check signatures. `e2e/web.wrangler.jsonc` lists `127.0.0.1` in `FEDERATION_ALLOW_HOSTS`, which lets the instance fetch it over plain HTTP. Port 8794 must be free too.

The browser is the Chromium Playwright 1.56 expects (`PLAYWRIGHT_BROWSERS_PATH`, or `pnpm exec playwright install chromium`). Failure traces and screenshots go to `.cache/e2e-web/results`.

## How the scenarios sign up

- Each page gets a Chromium virtual WebAuthn authenticator (`addPasskeyDevice` in `e2e/web/fixtures.ts`), so passkey prompts complete on their own. A second person (`newPerson`) is a separate browser context with its own authenticator.
- The instance runs with `EMAIL_TRANSPORT=capture`: the confirmation mail lands in the `APP_CACHE` KV namespace, and `confirmationLink` reads it from the dev server's local explorer API (`/cdn-cgi/local/explorer/api/storage/kv/...`). It does not spawn `wrangler kv key get`: that costs several seconds per sign-up on a loaded machine, and the three-person admin scenario then runs past its timeout.
- The UI runs in English (`locale: "en-US"`) so the selectors can use its labels ("What's on your mind?", "Post", "Favorite", …).
- A scenario fails on any uncaught page error or 5xx from `/api/*`, as well as on its own assertions.

The scenarios share one server and database and run one at a time; each uses fresh usernames. The admin scenarios are the exception: they sign up as `modadmin`, `modadmin2`, and `modadmin3`, which `ADMIN_USERNAMES` in `e2e/web.wrangler.jsonc` makes admins.
