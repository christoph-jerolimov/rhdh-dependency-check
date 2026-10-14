#!/usr/bin/env node
/**
 * Clones (or refreshes) a shallow copy of every configured repository into ./repos.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { repositories, reposDir } from './config.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).trim();
}

fs.mkdirSync(reposDir, { recursive: true });

for (const repo of repositories) {
  const target = path.join(reposDir, repo.slug);
  if (fs.existsSync(path.join(target, '.git'))) {
    console.log(`Updating ${repo.name} in ${path.relative(process.cwd(), target)}`);
    git(['fetch', '--depth', '1', 'origin'], target);
    git(['reset', '--hard', 'FETCH_HEAD'], target);
    git(['clean', '-fdx'], target);
  } else {
    console.log(`Cloning ${repo.name} into ${path.relative(process.cwd(), target)}`);
    fs.rmSync(target, { recursive: true, force: true });
    git(['clone', '--depth', '1', '--single-branch', '--no-tags', '--quiet', repo.url, target], reposDir);
  }
  const sha = git(['rev-parse', 'HEAD'], target);
  const date = git(['log', '-1', '--format=%cI'], target);
  console.log(`  ${sha.slice(0, 12)} (${date})`);
}
