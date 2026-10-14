#!/usr/bin/env node
/**
 * Walks every cloned repository, reads all package.json files and records their
 * dependencies (including the version resolved by the nearest lockfile).
 * Output: data/packages.json
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  dataDir,
  dependencyFields,
  ignoredDirectories,
  packagesFile,
  repositories,
  reposDir,
} from './config.mjs';
import { findLockfile } from './lib/lockfiles.mjs';
import { parseSpec } from './lib/spec.mjs';

function* walk(dir) {
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

function gitInfo(dir) {
  const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
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

const output = { generatedAt: new Date().toISOString(), repositories: [] };
let totalFiles = 0;
let totalDeps = 0;

for (const repo of repositories) {
  const repoDir = path.join(reposDir, repo.slug);
  if (!fs.existsSync(repoDir)) {
    console.warn(`Skipping ${repo.name}: ${repoDir} does not exist (run "npm run clone" first)`);
    continue;
  }
  const packages = [];
  for (const file of walk(repoDir)) {
    const relativeFile = path.relative(repoDir, file).split(path.sep).join('/');
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      console.warn(`  Ignoring unreadable ${relativeFile}: ${error.message}`);
      continue;
    }
    if (!json || typeof json !== 'object') continue;

    let workspace = null;
    if (repo.workspaceDir) {
      const prefix = `${repo.workspaceDir}/`;
      if (relativeFile.startsWith(prefix)) {
        workspace = relativeFile.slice(prefix.length).split('/')[0];
      }
    }

    const packageDir = path.dirname(file);
    const lockfile = findLockfile(packageDir, repoDir);
    const dependencies = [];
    for (const [field, type] of dependencyFields) {
      const deps = json[field];
      if (!deps || typeof deps !== 'object') continue;
      for (const [name, rawSpec] of Object.entries(deps)) {
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
