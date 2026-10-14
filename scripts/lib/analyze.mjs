/**
 * Turns one package.json dependency plus its registry metadata into a status.
 */
import semver from 'semver';

/** Row level in descending severity; used for colouring and sorting. */
export const levels = ['vulnerable', 'deprecated', 'outdated-major', 'outdated', 'stale', 'ok', 'local', 'unknown'];

const DAY_MS = 24 * 60 * 60 * 1000;

export function emptySummary() {
  return { dependencies: 0, vulnerable: 0, deprecated: 0, outdated: 0, outdatedMajor: 0, stale: 0, ok: 0, local: 0, unknown: 0 };
}

export function addToSummary(summary, dep) {
  summary.dependencies++;
  if (dep.flags.vulnerable) summary.vulnerable++;
  if (dep.flags.deprecated) summary.deprecated++;
  if (dep.flags.outdated) {
    summary.outdated++;
    if (dep.flags.outdated.diff === 'major' || dep.flags.outdated.diff === 'premajor') summary.outdatedMajor++;
  }
  if (dep.flags.stale) summary.stale++;
  if (dep.level === 'ok') summary.ok++;
  if (dep.level === 'local') summary.local++;
  if (dep.level === 'unknown') summary.unknown++;
  return summary;
}

export function mergeSummaries(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key] ?? 0;
  return target;
}

function daysBetween(from, to) {
  const t = Date.parse(from);
  if (Number.isNaN(t)) return null;
  return Math.floor((to - t) / DAY_MS);
}

/**
 * Picks the version that `range` would install today, ignoring lockfiles.
 * @param {string[]} versions all published versions
 * @param {Record<string,string>} distTags
 */
export function resolveRange(range, versions, distTags) {
  if (distTags?.[range]) return { version: distTags[range], source: 'tag' };
  const validRange = semver.validRange(range, { loose: true });
  if (!validRange) return { version: undefined, source: null };
  const includePrerelease = /-/.test(range);
  const version = semver.maxSatisfying(versions, range, { loose: true, includePrerelease }) ?? undefined;
  return { version, source: version ? 'range' : null };
}

/**
 * @param dep         entry from data/packages.json
 * @param info        registry summary from RegistryClient#getPackage (may be undefined for local deps)
 * @param advisories  advisories for the package, from RegistryClient#getAdvisories
 * @param options     { now: number, staleAfterDays: number }
 */
export function analyzeDependency(dep, info, advisories, { now, staleAfterDays }) {
  const result = {
    ...dep,
    resolved: null,
    resolvedSource: null,
    resolvedTime: null,
    latest: null,
    latestTime: null,
    latestAgeDays: null,
    level: 'ok',
    flags: {},
  };

  if (dep.kind === 'local' || dep.kind === 'git') {
    result.level = 'local';
    result.flags.local = { kind: dep.kind };
    return result;
  }

  if (!info || info.error) {
    result.level = 'unknown';
    result.flags.unknown = { reason: info?.error ?? 'no registry data' };
    return result;
  }
  if (info.notFound) {
    result.level = 'unknown';
    result.flags.unknown = { reason: 'not found on the npm registry' };
    return result;
  }

  const versions = Object.keys(info.versions ?? {});
  const latest = info.distTags?.latest ?? null;
  result.latest = latest;
  result.latestTime = latest ? (info.versions?.[latest]?.time ?? null) : null;
  result.latestAgeDays = result.latestTime ? daysBetween(result.latestTime, now) : null;

  let resolved = dep.lockVersion && semver.valid(dep.lockVersion, { loose: true }) ? dep.lockVersion : undefined;
  let resolvedSource = resolved ? 'lockfile' : null;
  if (!resolved) {
    ({ version: resolved, source: resolvedSource } = resolveRange(dep.range, versions, info.distTags));
  }
  result.resolved = resolved ?? null;
  result.resolvedSource = resolvedSource;
  result.resolvedTime = resolved ? (info.versions?.[resolved]?.time ?? null) : null;

  if (!resolved) {
    result.level = 'unknown';
    result.flags.unknown = { reason: `no published version satisfies "${dep.range}"` };
  }

  // Deprecation: of the version in use, and of the package's latest version.
  const deprecatedMessage = resolved ? info.versions?.[resolved]?.deprecated : undefined;
  const latestDeprecated = latest ? info.versions?.[latest]?.deprecated : undefined;
  if (deprecatedMessage || latestDeprecated) {
    result.flags.deprecated = {
      message: deprecatedMessage ?? latestDeprecated,
      resolvedDeprecated: Boolean(deprecatedMessage),
      latestDeprecated: Boolean(latestDeprecated),
    };
  }

  // Outdated: a newer "latest" exists than the version in use.
  if (resolved && latest && semver.valid(resolved, { loose: true }) && semver.lt(resolved, latest, { loose: true })) {
    result.flags.outdated = {
      diff: semver.diff(resolved, latest) ?? 'unknown',
      rangeAllowsLatest: Boolean(semver.validRange(dep.range, { loose: true })) && semver.satisfies(latest, dep.range, { loose: true }),
      behindDays: result.resolvedTime && result.latestTime ? Math.max(0, daysBetween(result.resolvedTime, Date.parse(result.latestTime))) : null,
    };
  }

  // Stale: the newest release is older than the threshold.
  if (result.latestAgeDays !== null && result.latestAgeDays > staleAfterDays) {
    result.flags.stale = { days: result.latestAgeDays };
  }

  // Security advisories affecting the version in use.
  if (resolved && advisories?.length) {
    const hits = advisories.filter((a) => {
      try {
        return semver.satisfies(resolved, a.vulnerableVersions, { loose: true, includePrerelease: true });
      } catch {
        return false;
      }
    });
    if (hits.length) result.flags.vulnerable = hits;
  }

  // Overall level, highest severity wins.
  if (result.flags.vulnerable) result.level = 'vulnerable';
  else if (result.flags.deprecated) result.level = 'deprecated';
  else if (result.flags.outdated && (result.flags.outdated.diff === 'major' || result.flags.outdated.diff === 'premajor')) result.level = 'outdated-major';
  else if (result.flags.outdated) result.level = 'outdated';
  else if (result.flags.stale) result.level = 'stale';
  else if (result.flags.unknown) result.level = 'unknown';
  else result.level = 'ok';

  return result;
}
