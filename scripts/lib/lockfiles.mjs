/**
 * Minimal lockfile readers. They only answer one question: which exact version
 * was resolved for `name@range`? Both yarn classic (v1) and yarn berry lockfiles
 * are line based enough for a small hand written parser; package-lock.json is JSON.
 */
import fs from 'node:fs';
import path from 'node:path';

/** @typedef {{ type: 'yarn' | 'npm', file: string, lookup: (name: string, spec: string, fromDir: string) => string | undefined }} Lockfile */

function stripQuotes(s) {
  return s.replace(/^["']|["']$/g, '');
}

/** Parses a yarn.lock (classic or berry) into a map of `name@spec` -> version. */
export function parseYarnLock(content) {
  const map = new Map();
  const lines = content.split(/\r?\n/);
  let currentKeys = [];
  for (const rawLine of lines) {
    if (!rawLine || rawLine.startsWith('#')) continue;
    if (!rawLine.startsWith(' ')) {
      // Entry header: one or more descriptors separated by ", ", ending with ":".
      const header = rawLine.replace(/:\s*$/, '');
      currentKeys = header.split(/,\s*/).map(stripQuotes).filter(Boolean);
      continue;
    }
    const m = rawLine.match(/^\s{2}version:?\s+"?([^"\s]+)"?\s*$/);
    if (m && currentKeys.length) {
      for (const key of currentKeys) {
        map.set(key, m[1]);
        // Berry prefixes npm ranges with "npm:"; also register the bare form.
        const idx = key.lastIndexOf('@');
        if (idx > 0) {
          const name = key.slice(0, idx);
          const spec = key.slice(idx + 1);
          if (spec.startsWith('npm:')) map.set(`${name}@${spec.slice(4)}`, m[1]);
        }
      }
      currentKeys = [];
    }
  }
  return map;
}

function loadYarnLock(file) {
  const map = parseYarnLock(fs.readFileSync(file, 'utf8'));
  return {
    type: 'yarn',
    file,
    lookup(name, spec) {
      return map.get(`${name}@${spec}`) ?? map.get(`${name}@npm:${spec}`);
    },
  };
}

function loadPackageLock(file) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  const packages = json.packages ?? {};
  const lockDir = path.dirname(file);
  return {
    type: 'npm',
    file,
    lookup(name, _spec, fromDir) {
      // Walk from the package directory up to the lockfile root, looking for
      // the nearest node_modules entry, which mirrors Node's resolution.
      let dir = path.relative(lockDir, fromDir).split(path.sep).filter(Boolean);
      for (;;) {
        const key = [...dir, 'node_modules', name].join('/');
        if (packages[key]?.version) return packages[key].version;
        if (!dir.length) break;
        dir = dir.slice(0, -1);
      }
      // lockfile v1 fallback
      return json.dependencies?.[name]?.version;
    },
  };
}

const lockfileCache = new Map();

/**
 * Finds the nearest lockfile for a package directory, searching upwards but
 * never leaving `rootDir`.
 * @returns {Lockfile | undefined}
 */
export function findLockfile(packageDir, rootDir) {
  let dir = packageDir;
  for (;;) {
    for (const [fileName, loader] of [
      ['yarn.lock', loadYarnLock],
      ['package-lock.json', loadPackageLock],
    ]) {
      const file = path.join(dir, fileName);
      if (fs.existsSync(file)) {
        if (!lockfileCache.has(file)) lockfileCache.set(file, loader(file));
        const lock = lockfileCache.get(file);
        if (lock) return lock;
      }
    }
    if (path.resolve(dir) === path.resolve(rootDir)) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
