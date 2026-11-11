# Browser e2e (Playwright)

<!-- constrained-by ../reference/configuration.md#web-ui -->
<!-- constrained-by ../reference/configuration.md#authentication -->
<!-- constrained-by ../reference/configuration.md#limited-federation -->

## Goal

Drive Mastodon's own web UI, served by this Worker, through the basic things a person does: visit signed out, sign in through Access, post and see the post on the home timeline and profile, favourite and bookmark, follow someone and get their posts, reply, read notifications, sign out, and sign back in. Streaming scenarios (`streaming.spec.ts`) keep a page open and check that a direct message, a followed person's post, a follow, a favourite, and Local and Federated posts arrive over the WebSocket with no reload and no console errors. Then edit the profile (display name and bio), post an image with alt text, and look up an account on another server. Paging scenarios (`paging.spec.ts`) scroll Private mentions and Explore's trending posts past their first page and check that the second loads.

## Run

```sh
pnpm e2e:web     # node e2e/web/database.mjs && vp -C packages/worker build && playwright test -c e2e/web/playwright.config.ts
pnpm e2e:web -g "follows"   # one scenario
```

`pnpm e2e:web` first runs `e2e/web/database.mjs`, which applies the D1 migrations to a database under `.cache/e2e-web/d1/<digest>`. The digest covers `e2e/web.wrangler.jsonc`, every migration file and the installed Wrangler version, so the migrations run again only after one of them changes. After a build it removes the databases of other digests. Wrangler applies each migration in its own step, which takes about a minute on a loaded machine.

Then Playwright starts the server itself (`e2e/web/serve.mjs`): it replaces the local storage in `.wrangler/e2e-web/v3` with a copy of that database and runs Void's dev server on `http://localhost:8795` with `e2e/web.wrangler.jsonc`, behind a stand-in for the Cloudflare Access edge (`e2e/web/access-edge.mjs`) on `http://localhost:8793`, the origin the browser opens (see [How the scenarios sign up](#how-the-scenarios-sign-up)). With `TSTODON_WEB_CLIENT=build` the dev server serves the built web UI (`packages/worker/dist/client`, Vite's `publicDir` in that mode) rather than the frontend's sources, so the scenarios run the production UI, as deployed: React's development build logs warnings the streaming scenarios would count as console errors. `pnpm e2e:web` therefore runs `pnpm build` (`vp -C packages/worker build`) between the migrations and Playwright; `serve.mjs` refuses to start without a client build. It keeps Vite's dependency cache in `.wrangler/e2e-web/vite`. On a 4-CPU machine shared with other test runs, the server answered in 17 to 33 seconds with that cache (load average 6 to 11). Without it, after a fresh clone or a dependency change, Vite bundles the Worker's dependencies again and reloads the Worker two or three times, and the server answered in 45 to 86 seconds (load average 8 to 16). The start-up budget in `playwright.config.ts` is 150 seconds. It was 180 seconds when `serve.mjs` applied every migration on each run; the migrations now run before Playwright starts, so the budget only has to cover the slowest measured cold start, 86 seconds. If you run `playwright test` directly and no database exists for the current digest, `serve.mjs` builds a fresh migrated database itself, inside that budget, which may then not be enough: run `node e2e/web/database.mjs` first. Nothing else may listen on port 8793 or 8795.

It also starts `e2e/web/remote-server.mjs` on `http://127.0.0.1:8794`: a stand-in remote Mastodon server with one account, `remote_alice`, served the way Mastodon serves it (WebFinger, an ActivityPub `Person` with a key, bio and avatar, an outbox with one public note). It accepts and drops inbox deliveries and does not check signatures. `e2e/web.wrangler.jsonc` lists `127.0.0.1` in `FEDERATION_ALLOW_HOSTS`, which lets the instance fetch it over plain HTTP. Port 8794 must be free too.

The browser origin is `http://localhost:8793`, the host `INSTANCE_DOMAIN` names. The browser is the Chromium headless shell `@playwright/test` 1.63.0 expects (revision 1243, Chromium 153), found under `PLAYWRIGHT_BROWSERS_PATH` or installed with `pnpm exec playwright install chromium`. The version is pinned to that revision because it is the one preinstalled where the suite is usually run; a newer `@playwright/test` (1.64 uses 1248, 1.65 uses 1254) needs its own browser installed. Pass `--trace off` (`pnpm e2e:web --trace off`) to skip recording traces of failures. Failure traces and screenshots go to `.cache/e2e-web/results`.

## How the scenarios sign up

- `signUp` in `e2e/web/fixtures.ts` signs an Access JWT with the test key in `packages/worker/test/access-jwt-fixture.ts` and stores it in the browser context as the `CF_Authorization` cookie, as Access does after a login. `e2e/web/access-edge.mjs` then does what Access's edge does: it sends that cookie's value to the Worker as `Cf-Access-Jwt-Assertion` on every request, WebSocket upgrades included, and drops any `Cf-Access-Jwt-Assertion` the browser sent itself. It checks nothing; the Worker verifies the JWT, and `e2e/web.wrangler.jsonc` trusts the test key's public JWKS. There is no local passkey and no confirmation email. Clearing the cookie (`dropAccessLogin`) is Access logout: while the JWT is still sent, the next request signs the person in again. A second person (`newPerson`) is a separate browser context.
- The JWT travels as a cookie rather than a header Playwright adds because the Worker keeps no session cookie of its own: every request needs the assertion. A header set with `page.setExtraHTTPHeaders` misses windows the web app opens (the More menu's settings pages, the admin links); a context-wide header or a `route` handler also misses an `<a download>` link (the CSV export), which Chromium fetches outside the page. A cookie goes with all of them, as Access's does.
- The UI runs in English (`locale: "en-US"`) so the selectors can use its labels ("What's on your mind?", "Post", "Favorite", …).
- A scenario fails on any uncaught page error or 5xx from `/api/*`, as well as on its own assertions.

The scenarios share one server and database and run one at a time; each uses fresh usernames. The admin scenarios are the exception: they sign up as `modadmin`, `modadmin2`, and `modadmin3`, which `ADMIN_USERNAMES` in `e2e/web.wrangler.jsonc` makes admins.

## CI

The `e2e-web` job in `.github/workflows/ci.yml` runs `pnpm e2e:web` (as `vp run e2e:web`) after `playwright install --with-deps chromium`, separately from the `ci` job, and uploads `.cache/e2e-web/results` when a scenario fails. The suite went unrun for a while before it had that job: six scenarios had failed since sign-in moved to Access (#82) and image attachments gained dimensions (#86).
