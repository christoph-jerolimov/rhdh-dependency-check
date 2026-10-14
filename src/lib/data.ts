import fs from 'node:fs';
import path from 'node:path';
import type { PackageJson, Report, Summary, Workspace } from './types';

const reportFile = path.resolve(process.cwd(), 'data', 'report.json');

let cached: Report | null | undefined;

/** Loads data/report.json once per build; returns null when it does not exist. */
export function loadReport(): Report | null {
  if (cached !== undefined) return cached;
  if (!fs.existsSync(reportFile)) {
    console.warn(`[data] ${reportFile} not found – building an empty site. Run "npm run report" first.`);
    cached = null;
    return cached;
  }
  cached = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as Report;
  return cached;
}

export function emptySummary(): Summary {
  return { dependencies: 0, vulnerable: 0, deprecated: 0, outdated: 0, outdatedMajor: 0, stale: 0, ok: 0, local: 0, unknown: 0 };
}

export function addSummary(target: Summary, source: Summary): Summary {
  for (const key of Object.keys(target) as (keyof Summary)[]) target[key] += source[key] ?? 0;
  return target;
}

/** Number of dependencies that carry at least one finding. */
export function issueCount(summary: Summary): number {
  return summary.dependencies - summary.ok - summary.local;
}

/** Groups package.json files by workspace; packages outside any workspace come last. */
export function groupByWorkspace(packages: PackageJson[]): Workspace[] {
  const groups = new Map<string | null, Workspace>();
  for (const pkg of packages) {
    const key = pkg.workspace;
    let group = groups.get(key);
    if (!group) {
      group = { name: key, packages: [], summary: emptySummary() };
      groups.set(key, group);
    }
    group.packages.push(pkg);
    addSummary(group.summary, pkg.summary);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.name === null) return 1;
    if (b.name === null) return -1;
    return a.name.localeCompare(b.name);
  });
}
