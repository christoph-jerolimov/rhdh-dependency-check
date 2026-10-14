# rhdh-dependency-check

A GitHub Pages report on the dependency health of the Backstage and Red Hat
Developer Hub repositories:

- [backstage/backstage](https://github.com/backstage/backstage)
- [backstage/community-plugins](https://github.com/backstage/community-plugins)
- [redhat-developer/rhdh](https://github.com/redhat-developer/rhdh)
- [redhat-developer/rhdh-plugins](https://github.com/redhat-developer/rhdh-plugins)
- [redhat-developer/rhdh-plugin-export-overlays](https://github.com/redhat-developer/rhdh-plugin-export-overlays)

Every `package.json` in those repositories is scanned and each dependency is
checked against the npm registry for

- **outdated**: a newer `latest` version exists than the resolved version
  (the lockfile version, or the highest version matching the range),
- **deprecated**: the resolved or the latest version is deprecated,
- **security**: an npm security advisory covers the resolved version,
- **stale**: the newest release of the package is older than a year.

Repositories with a `workspaces/` directory (community-plugins, rhdh-plugins,
rhdh-plugin-export-overlays) are grouped by workspace; every workspace and
every `package.json` section is collapsible.

## How it works

The workflow in [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
runs daily (and on demand) and deploys to GitHub Pages:

1. `npm run clone` – shallow clones the repositories into `repos/`.
2. `npm run collect` – finds all `package.json` files, reads their
   `dependencies`, `devDependencies`, `peerDependencies` and
   `optionalDependencies`, and resolves exact versions from the nearest
   `yarn.lock` / `package-lock.json`. Output: `data/packages.json`.
3. `npm run check` – looks up every unique package on the npm registry and the
   bulk advisory endpoint used by `npm audit`, then writes `data/report.json`.
4. `npm run build` – renders the Astro site into `dist/`.

### Respecting the npm registry

- Registry answers are cached in `.cache/npm/` (one small JSON summary per
  package) and reused while younger than `NPM_CACHE_TTL_HOURS` (default 24).
  The workflow persists this directory with `actions/cache`, so a daily run only
  re-fetches entries that expired.
- Requests are paced: at most `NPM_REQUEST_CONCURRENCY` (default 2) in flight
  and at least `NPM_REQUEST_INTERVAL_MS` (default 150) between request starts.
- `429`/`503` responses pause all requests for the `Retry-After` duration;
  other errors are retried with exponential backoff.

## Local development

```sh
npm ci
npm run report   # clone + collect + check (a full run takes a few minutes)
npm run dev      # http://localhost:4321/rhdh-dependency-check/
npm run build    # static site in dist/
```

Set `BASE_PATH=/` and `SITE=http://localhost:4321` to build without the GitHub
Pages base path.

## GitHub Pages setup

In the repository settings, under *Pages*, set the source to **GitHub Actions**.
The workflow needs no further secrets; it uses the `github-pages` environment.
