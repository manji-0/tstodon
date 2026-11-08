# Browser e2e (Playwright)

<!-- constrained-by ../reference/configuration.md#web-ui -->
<!-- constrained-by ../reference/configuration.md#authentication -->
<!-- constrained-by ../reference/configuration.md#limited-federation -->

## Goal

Drive Mastodon's own web UI, served by this Worker, through the basic things a person does: visit signed out, sign in through Access, post and see the post on the home timeline and profile, favourite and bookmark, follow someone and get their posts, reply, read notifications, sign out, and sign back in. Streaming scenarios (`streaming.spec.ts`) keep a page open and check that a direct message, a followed person's post, a follow, a favourite, and Local and Federated posts arrive over the WebSocket with no reload and no console errors. Then edit the profile (display name and bio), post an image with alt text, and look up an account on another server.

## Run

```sh
pnpm e2e:web     # node e2e/web/database.mjs && vp -C packages/worker build && playwright test -c e2e/web/playwright.config.ts
pnpm e2e:web -g "follows"   # one scenario
```

`pnpm e2e:web` first runs `e2e/web/database.mjs`, which applies the D1 migrations to a database under `.cache/e2e-web/d1/<digest>`. The digest covers `e2e/web.wrangler.jsonc`, every migration file and the installed Wrangler version, so the migrations run again only after one of them changes. After a build it removes the databases of other digests. Wrangler applies each migration in its own step, which takes about a minute on a loaded machine.

Then Playwright starts the server itself (`e2e/web/serve.mjs`): it replaces the local storage in `.wrangler/e2e-web/v3` with a copy of that database and runs Void's dev server on `http://localhost:8793` with `e2e/web.wrangler.jsonc`. With `TSTODON_WEB_CLIENT=build` the dev server serves the built web UI (`packages/worker/dist/client`, Vite's `publicDir` in that mode) rather than the frontend's sources, so the scenarios run the production UI, as deployed: React's development build logs warnings the streaming scenarios would count as console errors. `pnpm e2e:web` therefore runs `pnpm build` (`vp -C packages/worker build`) between the migrations and Playwright; `serve.mjs` refuses to start without a client build. It keeps Vite's dependency cache in `.wrangler/e2e-web/vite`. On a 4-CPU machine shared with other test runs, the server answered in 17 to 33 seconds with that cache (load average 6 to 11). Without it, after a fresh clone or a dependency change, Vite bundles the Worker's dependencies again and reloads the Worker two or three times, and the server answered in 45 to 86 seconds (load average 8 to 16). The start-up budget in `playwright.config.ts` is 150 seconds. It was 180 seconds when `serve.mjs` applied every migration on each run; the migrations now run before Playwright starts, so the budget only has to cover the slowest measured cold start, 86 seconds. If you run `playwright test` directly and no database exists for the current digest, `serve.mjs` builds a fresh migrated database itself, inside that budget, which may then not be enough: run `node e2e/web/database.mjs` first. Nothing else may listen on port 8793.

It also starts `e2e/web/remote-server.mjs` on `http://127.0.0.1:8794`: a stand-in remote Mastodon server with one account, `remote_alice`, served the way Mastodon serves it (WebFinger, an ActivityPub `Person` with a key, bio and avatar, an outbox with one public note). It accepts and drops inbox deliveries and does not check signatures. `e2e/web.wrangler.jsonc` lists `127.0.0.1` in `FEDERATION_ALLOW_HOSTS`, which lets the instance fetch it over plain HTTP. Port 8794 must be free too.

The browser origin is `http://localhost:8793`, the host `INSTANCE_DOMAIN` names. The browser is the Chromium Playwright 1.56 expects (`PLAYWRIGHT_BROWSERS_PATH`, or `pnpm exec playwright install chromium`). Failure traces and screenshots go to `.cache/e2e-web/results`.

## How the scenarios sign up

- `signUp` in `e2e/web/fixtures.ts` sends `Cf-Access-Jwt-Assertion`, signed with the test key in `packages/worker/test/access-jwt-fixture.ts`. `e2e/web.wrangler.jsonc` trusts that key's public JWKS. There is no local passkey and no confirmation email. Dropping the header (`dropAccessLogin`) is Access logout: while the header is still sent, the next request signs the person in again. A second person (`newPerson`) is a separate browser context.
- The instance still runs with `EMAIL_TRANSPORT=capture` for mail the server sends other than sign-up.
- The UI runs in English (`locale: "en-US"`) so the selectors can use its labels ("What's on your mind?", "Post", "Favorite", …).
- A scenario fails on any uncaught page error or 5xx from `/api/*`, as well as on its own assertions.

The scenarios share one server and database and run one at a time; each uses fresh usernames. The admin scenarios are the exception: they sign up as `modadmin`, `modadmin2`, and `modadmin3`, which `ADMIN_USERNAMES` in `e2e/web.wrangler.jsonc` makes admins.
