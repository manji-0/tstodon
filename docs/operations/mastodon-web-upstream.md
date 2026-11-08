# Updating the vendored Mastodon web UI

<!-- constrained-by ../reference/configuration.md#web-ui -->

`packages/worker/src` is Mastodon's frontend (upstream's `app/javascript`), copied from a release and changed in place by tstodon; it is the client of the Void app in `packages/worker`. `packages/worker/src/upstream.json` records the repository, tag and commit, where each imported upstream path lives here (`imported`), the upstream files tstodon ported instead of copying (`ported`), and the trees fetched at build time (`fetched`, `served`). `packages/worker/src/UPSTREAM.md` lists tstodon's changes. Moving to a newer release means applying upstream's own changes between the two tags to the imported paths at their new locations, keeping ours.

## Steps

<!-- constrained-by ../../packages/worker/src/UPSTREAM.md#path-mapping -->

Below, `OLD` is the tag in `upstream.json` and `NEW` the release to move to.

1. Fetch both tags into the repository as a partial clone remote, so only the blobs a command reads are downloaded (`git` may print `Could not read <sha>` for the shallow parents; that is harmless):

   ```sh
   git remote add mastodon https://github.com/mastodon/mastodon.git
   git config remote.mastodon.promisor true
   git config remote.mastodon.partialclonefilter blob:none
   git config remote.mastodon.tagOpt --no-tags
   git fetch --depth 1 --filter=blob:none mastodon \
     refs/tags/OLD:refs/mastodon/OLD refs/tags/NEW:refs/mastodon/NEW
   git rev-parse refs/mastodon/NEW^{commit}   # the commit to record
   ```

2. Check whether the build reads anything new, and port upstream's changes to the files tstodon ported (`ported` in `upstream.json`):

   ```sh
   git diff refs/mastodon/OLD refs/mastodon/NEW -- vite.config.mts vitest.config.mts tsconfig.json package.json
   ```

   `vite.config.mts` maps to `packages/worker/web-build.ts` (entry points, output names, plugins, CSS settings), `vitest.config.mts`'s `legacy-tests` project to `packages/worker/vitest.config.ts`, `tsconfig.json` to `packages/worker/src/tsconfig.json` (paths relative to `src/`), and `package.json`'s dependency versions to the same entries in `packages/worker/package.json` (keep out what `UPSTREAM.md` lists as removed; `vite` and `vitest` stay the workspace catalog's). If the build needs another upstream path, copy it from `refs/mastodon/NEW` (`git archive refs/mastodon/NEW -- path | tar -x -C <dir>`) and add it to `imported` with its location here. Move a large static tree that should not be committed to `fetched` (and `served` if the Worker serves it).

3. Apply upstream's changes to the imported paths with a three-way merge. The blobs of upstream's files are in this repository's history (the import commit holds them unmodified), so `--3way` merges our changes with upstream's and leaves conflict markers where both touched the same lines. Each upstream path is applied at its location here (the `imported` map): `-p` strips upstream's leading directories and `--directory` puts the rest under ours.

   ```sh
   d() { git diff --binary refs/mastodon/OLD refs/mastodon/NEW -- "$@"; }
   d app/javascript | git apply --3way -p3 --directory=packages/worker/src
   d config/vite config/themes.yml .browserslistrc public/sounds public/badge.png \
     public/web-push-icon_expand.png public/web-push-icon_favourite.png public/web-push-icon_reblog.png \
     | git apply --3way --directory=packages/worker
   d LICENSE AUTHORS.md | git apply --3way --directory=packages/worker/src
   git diff refs/mastodon/OLD refs/mastodon/NEW -- config/formatjs-formatter.js
   git status packages/worker   # resolve conflicts, then git add
   ```

   `app/javascript/mastodon/api_types/*.ts` are re-exports of `@tstodon/api` here: a conflict there is resolved by keeping the re-export file and applying upstream's field changes to the schemas in `packages/api/src/` instead (see "REST types from `@tstodon/api`" in `UPSTREAM.md`); `pnpm typecheck` and `pnpm typecheck:web` then show the server and client code that must follow.

   `config/formatjs-formatter.js` is `packages/worker/config/formatjs-formatter.cjs` here (renamed, with the locale path changed): apply its diff, usually empty, by hand. An empty diff makes `git apply` print `No valid patches in input`; that is fine. A file upstream deleted is deleted here too; a file upstream added under an imported directory is added. If `imported` gained an entry in step 2, apply it the same way.

4. Bring the dependencies across. Step 2 put upstream's new versions into `packages/worker/package.json`; check that the tstodon-only entries `UPSTREAM.md` lists (`HOISTED` in the script below) are still needed. Then lock them at the versions upstream's `yarn.lock` resolved:

   ```sh
   git show refs/mastodon/NEW:yarn.lock > .cache/mastodon-yarn.lock
   git show refs/mastodon/NEW:package.json > .cache/mastodon-package.json
   node scripts/import-mastodon-web-lock.mjs .cache/mastodon-yarn.lock .cache/mastodon-package.json
   pnpm install --frozen-lockfile
   ```

   `scripts/import-mastodon-web-lock.mjs` takes the frontend's dependencies from `packages/worker/package.json` (the entries upstream's `package.json` declares, plus `HOISTED`), runs `pnpm import` on that `yarn.lock` for them alone, with the workspace's Vite+ core and Vitest in place of upstream's Vite and Vitest so plugin peers resolve to those, and merges the result into `pnpm-lock.yaml`: those entries of the `packages/worker` importer are replaced, entries the workspace lock lacks are added, entries nothing reaches any more are dropped, and the rest of the workspace keeps its versions. It then runs `pnpm install` and `pnpm install --frozen-lockfile`. A package the workspace already locks at a version satisfying upstream's range may stay shared with it. If an install script is refused (`ERR_PNPM_IGNORED_BUILDS`), decide it under `allowBuilds` in `pnpm-workspace.yaml`. Check that the lock names one Vite: `grep -cE 'vite@8\.|vitest@4\.' pnpm-lock.yaml` prints `0`. (Before the frontend moved into the Void app, the script replaced a separate `packages/web` importer, and upstream's Vite and Vitest were kept for it with scoped overrides.)

5. Record the release: `tag` and `commit` in `packages/worker/src/upstream.json`, and the table in `packages/worker/src/UPSTREAM.md` (with any change to the path mapping or local changes). The next build fetches `public/emoji` and `public/ocr` from the new commit (it checks that the tag still points at it) and records `vNEW+tstodon` as the web manifest's `ref`.

6. Validate:

   ```sh
   pnpm typecheck:web
   pnpm test:web
   pnpm run ci
   pnpm e2e:web --trace off
   ```

   Then look over the Worker's side of the contract with the frontend: `server/web-app.ts` renders the HTML shell and `initial-state` Mastodon's Rails views render (compare upstream's `app/views/layouts/application.html.haml`, `app/serializers/initial_state_serializer.rb` and `app/presenters/initial_state_presenter.rb` between the tags), and `webManifest` in `packages/worker/web-build.ts` reads the Vite entry names (`src/entrypoints/*`, `src/styles/entrypoints/inert.scss`, the default theme, the legacy polyfills, the 32x32 favicon).

7. Clean up: `git update-ref -d refs/mastodon/OLD` (and `NEW`), `git remote remove mastodon`, and delete `.cache/mastodon-yarn.lock` and `.cache/mastodon-package.json`.

Commit the upstream merge (step 3 and the version bump) separately from fixes on top of it, so the next update can tell upstream's changes from ours.
