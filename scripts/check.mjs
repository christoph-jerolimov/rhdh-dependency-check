#!/usr/bin/env node
/**
 * Looks up every dependency from data/packages.json on the npm registry and
 * writes the analysed report to data/report.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  cacheDir,
  cacheTtlHours,
  packagesFile,
  registryUrl,
  reportFile,
  requestConcurrency,
  requestIntervalMs,
  staleAfterDays,
} from './config.mjs';
import { addToSummary, analyzeDependency, emptySummary, mergeSummaries } from './lib/analyze.mjs';
import { RegistryClient } from './lib/registry.mjs';

if (!fs.existsSync(packagesFile)) {
  console.error(`${packagesFile} not found; run "npm run collect" first`);
  process.exit(1);
}
const input = JSON.parse(fs.readFileSync(packagesFile, 'utf8'));

const client = new RegistryClient({
  registryUrl,
  cacheDir,
  ttlHours: cacheTtlHours,
  intervalMs: requestIntervalMs,
  concurrency: requestConcurrency,
});

// 1. Unique npm package names across all repositories.
const names = new Set();
for (const repo of input.repositories) {
  for (const pkg of repo.packages) {
    for (const dep of pkg.dependencies) {
      if (dep.kind === 'npm' || dep.kind === 'alias') names.add(dep.packageName);
    }
  }
}
console.log(
  `Looking up ${names.size} packages on ${registryUrl} (cache TTL ${cacheTtlHours}h, ${requestIntervalMs}ms between requests, concurrency ${requestConcurrency})`,
);

// 2. Fetch registry metadata (cached, paced).
const infoByName = new Map();
let done = 0;
const started = Date.now();
await Promise.all(
  [...names].sort().map(async (name) => {
    infoByName.set(name, await client.getPackage(name));
    done++;
    if (done % 100 === 0 || done === names.size) {
      console.log(`  ${done}/${names.size} packages (${client.stats.requests} requests, ${client.stats.cacheHits} cache hits, ${((Date.now() - started) / 1000).toFixed(0)}s)`);
    }
  }),
);

// 3. Analyse once without advisories to learn the resolved versions ...
const now = Date.now();
const analyzeOptions = { now, staleAfterDays };
const versionsByName = {};
for (const repo of input.repositories) {
  for (const pkg of repo.packages) {
    for (const dep of pkg.dependencies) {
      const first = analyzeDependency(dep, infoByName.get(dep.packageName), [], analyzeOptions);
      if (first.resolved && (dep.kind === 'npm' || dep.kind === 'alias')) {
        (versionsByName[dep.packageName] ??= []).push(first.resolved);
      }
    }
  }
}

// 4. ... then ask the bulk advisory endpoint about exactly those versions.
console.log(`Checking security advisories for ${Object.keys(versionsByName).length} packages`);
const advisoriesByName = await client.getAdvisories(versionsByName);

// 5. Build the report.
const report = {
  generatedAt: new Date(now).toISOString(),
  staleAfterDays,
  summary: emptySummary(),
  repositories: [],
  packages: {},
};

for (const repo of input.repositories) {
  const repoSummary = emptySummary();
  const packages = repo.packages.map((pkg) => {
    const summary = emptySummary();
    const dependencies = pkg.dependencies.map((dep) => {
      const analysed = analyzeDependency(dep, infoByName.get(dep.packageName), advisoriesByName[dep.packageName], analyzeOptions);
      addToSummary(summary, analysed);
      return analysed;
    });
    mergeSummaries(repoSummary, summary);
    return { ...pkg, summary, dependencies };
  });
  mergeSummaries(report.summary, repoSummary);
  report.repositories.push({ ...repo, packages, summary: repoSummary });
}

const usagesByName = new Map();
for (const repo of report.repositories) {
  for (const pkg of repo.packages) {
    for (const dep of pkg.dependencies) {
      if (!names.has(dep.packageName)) continue;
      const usage = usagesByName.get(dep.packageName) ?? { count: 0, resolved: new Set(), repositories: new Set() };
      usage.count++;
      if (dep.resolved) usage.resolved.add(dep.resolved);
      usage.repositories.add(repo.slug);
      usagesByName.set(dep.packageName, usage);
    }
  }
}
for (const name of [...names].sort()) {
  const info = infoByName.get(name);
  const latest = info?.distTags?.latest ?? null;
  const latestTime = latest ? info.versions?.[latest]?.time ?? null : null;
  const usage = usagesByName.get(name) ?? { count: 0, resolved: new Set(), repositories: new Set() };
  report.packages[name] = {
    name,
    latest,
    latestTime,
    latestAgeDays: latestTime ? Math.floor((now - Date.parse(latestTime)) / 86_400_000) : null,
    deprecated: latest ? info?.versions?.[latest]?.deprecated ?? null : null,
    notFound: Boolean(info?.notFound),
    error: info?.error ?? null,
    homepage: info?.homepage ?? null,
    advisories: advisoriesByName[name] ?? [],
    usageCount: usage.count,
    resolvedVersions: [...usage.resolved].sort(),
    repositories: [...usage.repositories],
  };
}

fs.mkdirSync(path.dirname(reportFile), { recursive: true });
fs.writeFileSync(reportFile, JSON.stringify(report));
const s = report.summary;
console.log(`Wrote ${path.relative(process.cwd(), reportFile)}`);
console.log(`  ${s.dependencies} dependencies: ${s.vulnerable} vulnerable, ${s.deprecated} deprecated, ${s.outdated} outdated (${s.outdatedMajor} major), ${s.stale} stale, ${s.unknown} unknown, ${s.local} local`);
console.log(`  registry: ${client.stats.requests} requests, ${client.stats.cacheHits} cache hits, ${client.stats.retries} retries, ${client.stats.rateLimited} rate limited, ${client.stats.notFound} not found, ${client.stats.failed} failed`);
