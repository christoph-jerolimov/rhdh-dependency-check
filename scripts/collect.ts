/**
 * Walks every cloned repository, reads all package.json files and records their
 * dependencies (including the version resolved by the nearest lockfile).
 * Output: data/packages.json
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, dependencyFields, ignoredDirectories, packagesFile, repositories, reposDir } from './config.ts';
import { findLockfile } from './lib/lockfiles.ts';
import { parseSpec } from './lib/spec.ts';
import type { CollectedDependency, CollectedPackage, GitInfo, PackagesFile } from './lib/types.ts';

function* walk(dir: string): Generator<string> {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile() && entry.name === 'package.json') {
      yield full;
    }
  }
}

function gitInfo(dir: string): GitInfo {
  const run = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    return {
      commit: run(['rev-parse', 'HEAD']),
      commitDate: run(['log', '-1', '--format=%cI']),
      branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    };
  } catch {
    return {};
  }
}

function readPackageJson(file: string, relativeFile: string): Record<string, unknown> | undefined {
  try {
    const json: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return json && typeof json === 'object' ? (json as Record<string, unknown>) : undefined;
  } catch (error) {
    console.warn(`  Ignoring unreadable ${relativeFile}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

const output: PackagesFile = { generatedAt: new Date().toISOString(), repositories: [] };
let totalFiles = 0;
let totalDeps = 0;

for (const repo of repositories) {
  const repoDir = path.join(reposDir, repo.slug);
  if (!fs.existsSync(repoDir)) {
    console.warn(`Skipping ${repo.name}: ${repoDir} does not exist (run "npm run clone" first)`);
    continue;
  }
  const packages: CollectedPackage[] = [];
  for (const file of walk(repoDir)) {
    const relativeFile = path.relative(repoDir, file).split(path.sep).join('/');
    const json = readPackageJson(file, relativeFile);
    if (!json) continue;

    let workspace: string | null = null;
    if (repo.workspaceDir) {
      const prefix = `${repo.workspaceDir}/`;
      if (relativeFile.startsWith(prefix)) {
        workspace = relativeFile.slice(prefix.length).split('/')[0] ?? null;
      }
    }

    const packageDir = path.dirname(file);
    const lockfile = findLockfile(packageDir, repoDir);
    const dependencies: CollectedDependency[] = [];
    for (const [field, type] of dependencyFields) {
      const deps = json[field];
      if (!deps || typeof deps !== 'object') continue;
      for (const [name, rawSpec] of Object.entries(deps as Record<string, unknown>)) {
        const spec = typeof rawSpec === 'string' ? rawSpec : String(rawSpec);
        const parsed = parseSpec(name, spec);
        const lockVersion = lockfile?.lookup(name, spec, packageDir);
        dependencies.push({
          name,
          type,
          spec,
          kind: parsed.kind,
          packageName: parsed.packageName,
          range: parsed.range,
          lockVersion: lockVersion ?? null,
        });
      }
    }
    dependencies.sort((a, b) => a.name.localeCompare(b.name));
    totalDeps += dependencies.length;
    packages.push({
      file: relativeFile,
      dir: path.posix.dirname(relativeFile),
      name: typeof json.name === 'string' ? json.name : null,
      version: typeof json.version === 'string' ? json.version : null,
      private: json.private === true,
      workspace,
      lockfile: lockfile ? path.relative(repoDir, lockfile.file).split(path.sep).join('/') : null,
      dependencies,
    });
  }
  totalFiles += packages.length;
  console.log(`${repo.name}: ${packages.length} package.json files`);
  output.repositories.push({
    slug: repo.slug,
    name: repo.name,
    url: repo.url,
    description: repo.description,
    workspaceDir: repo.workspaceDir ?? null,
    ...gitInfo(repoDir),
    packages,
  });
}

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(packagesFile, JSON.stringify(output));
console.log(`Wrote ${path.relative(process.cwd(), packagesFile)}: ${totalFiles} package.json files, ${totalDeps} dependency entries`);
