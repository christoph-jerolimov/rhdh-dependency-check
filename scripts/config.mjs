import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const reposDir = path.join(rootDir, 'repos');
export const dataDir = path.join(rootDir, 'data');
export const cacheDir = path.join(rootDir, '.cache', 'npm');

export const packagesFile = path.join(dataDir, 'packages.json');
export const reportFile = path.join(dataDir, 'report.json');

/**
 * Repositories that are cloned and scanned.
 *
 * `workspaceDir` names the directory whose direct children are treated as
 * workspaces; package.json files below it are grouped by that child name.
 * Repositories without `workspaceDir` are shown as a flat list.
 */
export const repositories = [
  {
    slug: 'backstage',
    name: 'backstage/backstage',
    url: 'https://github.com/backstage/backstage',
    description: 'Upstream Backstage monorepo.',
  },
  {
    slug: 'community-plugins',
    name: 'backstage/community-plugins',
    url: 'https://github.com/backstage/community-plugins',
    description: 'Backstage community plugins, one workspace per plugin family.',
    workspaceDir: 'workspaces',
  },
  {
    slug: 'rhdh',
    name: 'redhat-developer/rhdh',
    url: 'https://github.com/redhat-developer/rhdh',
    description: 'Red Hat Developer Hub application.',
  },
  {
    slug: 'rhdh-plugins',
    name: 'redhat-developer/rhdh-plugins',
    url: 'https://github.com/redhat-developer/rhdh-plugins',
    description: 'Red Hat Developer Hub plugins, one workspace per plugin family.',
    workspaceDir: 'workspaces',
  },
  {
    slug: 'rhdh-plugin-export-overlays',
    name: 'redhat-developer/rhdh-plugin-export-overlays',
    url: 'https://github.com/redhat-developer/rhdh-plugin-export-overlays',
    description: 'Overlays used to export dynamic plugins for Red Hat Developer Hub.',
    workspaceDir: 'workspaces',
  },
];

/** Directory names that are never scanned for package.json files. */
export const ignoredDirectories = new Set([
  'node_modules',
  '.git',
  '.yarn',
  '.pnp',
  'dist',
  'dist-types',
  'dist-dynamic',
  'build',
  'coverage',
  '__fixtures__',
  '__mocks__',
  '.cache',
]);

/** Dependency fields read from every package.json. */
export const dependencyFields = [
  ['dependencies', 'prod'],
  ['devDependencies', 'dev'],
  ['peerDependencies', 'peer'],
  ['optionalDependencies', 'optional'],
];

/** A "latest" release older than this is flagged as stale. */
export const staleAfterDays = 365;

/** How long npm registry answers are reused from the cache. */
export const cacheTtlHours = Number(process.env.NPM_CACHE_TTL_HOURS ?? 24);

/** Minimum pause between two registry requests, in milliseconds. */
export const requestIntervalMs = Number(process.env.NPM_REQUEST_INTERVAL_MS ?? 150);

/** Number of registry requests that may be in flight at the same time. */
export const requestConcurrency = Number(process.env.NPM_REQUEST_CONCURRENCY ?? 2);

export const registryUrl = process.env.NPM_REGISTRY_URL ?? 'https://registry.npmjs.org';
