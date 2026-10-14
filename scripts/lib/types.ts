/**
 * Shared data model of the pipeline (data/packages.json and data/report.json).
 * The Astro site re-exports these types from src/lib/types.ts.
 */

export type DependencyType = 'prod' | 'dev' | 'peer' | 'optional';
export type DependencyKind = 'npm' | 'alias' | 'local' | 'git';
export type Level = 'vulnerable' | 'deprecated' | 'outdated-major' | 'outdated' | 'stale' | 'ok' | 'local' | 'unknown';
export type ResolvedSource = 'lockfile' | 'range' | 'tag';

export interface RepositoryConfig {
  slug: string;
  name: string;
  url: string;
  description: string;
  /** Directory whose direct children are workspaces; package.json files below it are grouped by that child. */
  workspaceDir?: string;
}

/** A dependency as read from package.json (output of collect). */
export interface CollectedDependency {
  name: string;
  type: DependencyType;
  spec: string;
  kind: DependencyKind;
  /** The npm package to look up (differs from `name` for `npm:` aliases). */
  packageName: string;
  range: string;
  lockVersion: string | null;
}

export interface CollectedPackage {
  file: string;
  dir: string;
  name: string | null;
  version: string | null;
  private: boolean;
  workspace: string | null;
  lockfile: string | null;
  dependencies: CollectedDependency[];
}

export interface GitInfo {
  commit?: string;
  commitDate?: string;
  branch?: string;
}

export interface CollectedRepository extends GitInfo {
  slug: string;
  name: string;
  url: string;
  description: string;
  workspaceDir: string | null;
  packages: CollectedPackage[];
}

export interface PackagesFile {
  generatedAt: string;
  repositories: CollectedRepository[];
}

export interface Advisory {
  id: number;
  url: string;
  title: string;
  severity: 'critical' | 'high' | 'moderate' | 'low' | (string & {});
  vulnerableVersions: string;
  cvssScore: number | null;
}

export interface DependencyFlags {
  local?: { kind: DependencyKind };
  unknown?: { reason: string };
  deprecated?: { message: string; resolvedDeprecated: boolean; latestDeprecated: boolean };
  outdated?: { diff: string; rangeAllowsLatest: boolean; behindDays: number | null };
  stale?: { days: number };
  vulnerable?: Advisory[];
}

/** A dependency with its analysis (output of check). */
export interface Dependency extends CollectedDependency {
  resolved: string | null;
  resolvedSource: ResolvedSource | null;
  resolvedTime: string | null;
  latest: string | null;
  latestTime: string | null;
  latestAgeDays: number | null;
  level: Level;
  flags: DependencyFlags;
}

export interface Summary {
  dependencies: number;
  vulnerable: number;
  deprecated: number;
  outdated: number;
  outdatedMajor: number;
  stale: number;
  ok: number;
  local: number;
  unknown: number;
}

export interface PackageJson extends Omit<CollectedPackage, 'dependencies'> {
  summary: Summary;
  dependencies: Dependency[];
}

export interface Repository extends Omit<CollectedRepository, 'packages'> {
  summary: Summary;
  packages: PackageJson[];
}

export interface PackageInfo {
  name: string;
  latest: string | null;
  latestTime: string | null;
  latestAgeDays: number | null;
  deprecated: string | null;
  notFound: boolean;
  error: string | null;
  homepage: string | null;
  advisories: Advisory[];
  usageCount: number;
  resolvedVersions: string[];
  repositories: string[];
}

export interface Report {
  generatedAt: string;
  staleAfterDays: number;
  summary: Summary;
  repositories: Repository[];
  packages: Record<string, PackageInfo>;
}

/** Compact per-package summary of a registry packument, as stored in the cache. */
export interface RegistryPackage {
  name: string;
  fetchedAt: string;
  notFound?: boolean;
  /** Set when the lookup failed; such entries are not cached. */
  error?: string;
  distTags?: Record<string, string>;
  modified?: string | null;
  created?: string | null;
  homepage?: string | null;
  repository?: string | null;
  versions?: Record<string, { time: string | null; deprecated?: string }>;
}
