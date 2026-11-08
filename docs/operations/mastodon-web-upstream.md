# Updating the vendored Mastodon web UI

<!-- constrained-by ../reference/configuration.md#web-ui -->

`packages/web` is Mastodon's frontend, copied from a release (`packages/web/upstream.json`: repository, tag, commit, the `imported` paths and the `fetched` ones) and changed in place by tstodon. `packages/web/UPSTREAM.md` lists those changes. Moving to a newer release means applying upstream's own changes between the two tags to the imported paths, keeping ours.

## Steps

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

2. Check whether the build reads anything new. Compare upstream's `vite.config.mts`, `config/vite/` and `package.json` between the tags (`git diff refs/mastodon/OLD refs/mastodon/NEW -- vite.config.mts config/vite package.json`). If the build needs another path, add it to `imported` in `upstream.json` and copy it from `refs/mastodon/NEW` (`git archive refs/mastodon/NEW -- path | tar -x -C packages/web`). Likewise, move a large static tree that should not be committed to `fetched`.

3. Apply upstream's changes to the imported paths with a three-way merge. The blobs of upstream's files are in this repository's history (the import commit holds them unmodified), so `--3way` merges our changes with upstream's and leaves conflict markers where both touched the same lines:

   ```sh
   git diff --binary refs/mastodon/OLD refs/mastodon/NEW -- \
     $(node -p 'require("./packages/web/upstream.json").imported.join(" ")') \
     > .cache/mastodon-web.patch
   git apply --3way --directory=packages/web .cache/mastodon-web.patch
   git status packages/web   # resolve conflicts, then git add
   ```

   A file upstream deleted is deleted here too; a file upstream added under an imported directory is added.

4. Bring the dependencies across. `package.json` merged in step 3, so its versions are upstream's new ones; check that the tstodon-only entries `UPSTREAM.md` lists are still needed (a package upstream now declares itself can leave the list). Then lock them at the versions upstream's `yarn.lock` resolved:

   ```sh
   git show refs/mastodon/NEW:yarn.lock > .cache/mastodon-yarn.lock
   node scripts/import-mastodon-web-lock.mjs .cache/mastodon-yarn.lock
   pnpm install   # reports the lockfile up to date
   ```

   `scripts/import-mastodon-web-lock.mjs` runs `pnpm import` on that `yarn.lock` for `packages/web/package.json` alone and merges the result into `pnpm-lock.yaml`: the `packages/web` importer is replaced, entries the workspace lock lacks are added, entries nothing reaches any more are dropped, and the rest of the workspace keeps its versions. A package the workspace already locks at a version satisfying upstream's range may stay shared with it. If an install script is refused (`ERR_PNPM_IGNORED_BUILDS`), decide it under `allowBuilds` in `pnpm-workspace.yaml`. If upstream changes its `vite` or `vitest` version, update the `@tstodon/web>vite` / `@tstodon/web>vitest` overrides there to match, and check `pnpm why vite` in `packages/web` names no `@voidzero-dev/vite-plus-core`.

5. Record the release: `tag` and `commit` in `packages/web/upstream.json`, and the table in `packages/web/UPSTREAM.md` (with any change to the imported paths or local changes). The next `pnpm web:build` fetches `public/emoji` and `public/ocr` from the new commit (it checks that the tag still points at it) and records `vNEW+tstodon` as `ref` in `packs/tstodon-web.json`.

6. Validate:

   ```sh
   pnpm web:build
   pnpm -C packages/web typecheck
   pnpm -C packages/web test:js run
   pnpm run ci
   pnpm e2e:web --trace off
   ```

   Then look over the Worker's side of the contract with the frontend: `src/web-app.ts` renders the HTML shell and `initial-state` Mastodon's Rails views render (compare upstream's `app/views/layouts/application.html.haml`, `app/serializers/initial_state_serializer.rb` and `app/presenters/initial_state_presenter.rb` between the tags), and reads the Vite entry names in `scripts/build-mastodon-web.mjs`.

7. Clean up: `git update-ref -d refs/mastodon/OLD` (and `NEW`), `git remote remove mastodon`, and delete `.cache/mastodon-web.patch` and `.cache/mastodon-yarn.lock`.

Commit the upstream merge (step 3 and the version bump) separately from fixes on top of it, so the next update can tell upstream's changes from ours.
