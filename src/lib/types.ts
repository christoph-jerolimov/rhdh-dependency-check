export type DependencyType = 'prod' | 'dev' | 'peer' | 'optional';
export type DependencyKind = 'npm' | 'alias' | 'local' | 'git';
export type Level = 'vulnerable' | 'deprecated' | 'outdated-major' | 'outdated' | 'stale' | 'ok' | 'local' | 'unknown';

export interface Advisory {
  id: number;
  url: string;
  title: string;
  severity: 'critical' | 'high' | 'moderate' | 'low' | string;
  vulnerableVersions: string;
  cvssScore: number | null;
}

export interface Dependency {
  name: string;
  type: DependencyType;
  spec: string;
  kind: DependencyKind;
  packageName: string;
  range: string;
  lockVersion: string | null;
  resolved: string | null;
  resolvedSource: 'lockfile' | 'range' | 'tag' | null;
  resolvedTime: string | null;
  latest: string | null;
  latestTime: string | null;
  latestAgeDays: number | null;
  level: Level;
  flags: {
    local?: { kind: DependencyKind };
    unknown?: { reason: string };
    deprecated?: { message: string; resolvedDeprecated: boolean; latestDeprecated: boolean };
    outdated?: { diff: string; rangeAllowsLatest: boolean; behindDays: number | null };
    stale?: { days: number };
    vulnerable?: Advisory[];
  };
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

export interface PackageJson {
  file: string;
  dir: string;
  name: string | null;
  version: string | null;
  private: boolean;
  workspace: string | null;
  lockfile: string | null;
  summary: Summary;
  dependencies: Dependency[];
}

export interface Repository {
  slug: string;
  name: string;
  url: string;
  description: string;
  workspaceDir: string | null;
  commit?: string;
  commitDate?: string;
  branch?: string;
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

export interface Workspace {
  name: string | null;
  packages: PackageJson[];
  summary: Summary;
}
