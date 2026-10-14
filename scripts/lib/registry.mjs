/**
 * Small npm registry client with
 *  - a persistent on-disk cache (one JSON file per package, TTL based),
 *  - a global pacing of requests (minimum interval + bounded concurrency),
 *  - retries with exponential backoff that honour Retry-After / 429 / 503.
 */
import fs from 'node:fs';
import path from 'node:path';

const CACHE_SCHEMA = 2;
const USER_AGENT = 'rhdh-dependency-check (+https://github.com/christoph-jerolimov/rhdh-dependency-check)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Serialises request starts: at most `concurrency` in flight, `intervalMs` between starts. */
class Pacer {
  constructor({ intervalMs, concurrency }) {
    this.intervalMs = intervalMs;
    this.concurrency = Math.max(1, concurrency);
    this.active = 0;
    this.queue = [];
    this.nextStartAt = 0;
    this.pausedUntil = 0;
  }

  /** Called when the registry asks us to slow down. All lanes wait. */
  pause(ms) {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.#pump();
    });
  }

  async #pump() {
    if (this.pumping) return;
    this.pumping = true;
    while (this.queue.length && this.active < this.concurrency) {
      const wait = Math.max(this.nextStartAt, this.pausedUntil) - Date.now();
      if (wait > 0) await sleep(wait);
      if (this.active >= this.concurrency) break; // a finishing job re-enters #pump()
      const job = this.queue.shift();
      this.nextStartAt = Date.now() + this.intervalMs;
      this.active++;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--;
          this.#pump();
        });
    }
    this.pumping = false;
  }
}

function parseRetryAfter(header) {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export class RegistryClient {
  constructor({ registryUrl, cacheDir, ttlHours, intervalMs, concurrency, log = console.log }) {
    this.registryUrl = registryUrl.replace(/\/$/, '');
    this.cacheDir = cacheDir;
    this.ttlMs = ttlHours * 60 * 60 * 1000;
    this.pacer = new Pacer({ intervalMs, concurrency });
    this.log = log;
    this.stats = { requests: 0, cacheHits: 0, retries: 0, rateLimited: 0, notFound: 0, failed: 0 };
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  // ---- cache -----------------------------------------------------------------

  #cacheFile(kind, name) {
    return path.join(this.cacheDir, `${kind}--${name.replace(/^@/, '').replace(/\//g, '__')}.json`);
  }

  #readCache(kind, name) {
    const file = this.#cacheFile(kind, name);
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (entry.schema !== CACHE_SCHEMA || entry.name !== name) return undefined;
      const age = Date.now() - Date.parse(entry.fetchedAt);
      if (!(age < this.ttlMs)) return undefined;
      return entry;
    } catch {
      return undefined;
    }
  }

  #writeCache(kind, name, entry) {
    const file = this.#cacheFile(kind, name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schema: CACHE_SCHEMA, ...entry }));
    fs.renameSync(tmp, file);
  }

  // ---- HTTP ------------------------------------------------------------------

  /**
   * Performs one request through the pacer with retries.
   * Resolves with `{ status, body }`; `body` is parsed JSON (or null for 404).
   */
  async #request(url, init = {}, { maxAttempts = 6 } = {}) {
    let attempt = 0;
    for (;;) {
      attempt++;
      const result = await this.pacer.run(async () => {
        this.stats.requests++;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 120_000);
        try {
          const response = await fetch(url, {
            ...init,
            signal: controller.signal,
            headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...(init.headers ?? {}) },
          });
          if (response.status === 404) {
            await response.arrayBuffer().catch(() => {});
            return { status: 404, body: null };
          }
          if (response.status === 429 || response.status === 503 || response.status >= 500) {
            const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
            await response.arrayBuffer().catch(() => {});
            return { status: response.status, retryAfter };
          }
          if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw Object.assign(new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 200)}`), { fatal: true });
          }
          return { status: response.status, body: await response.json() };
        } finally {
          clearTimeout(timer);
        }
      }).catch((error) => ({ error }));

      if (result.body !== undefined) return result;

      if (result.error?.fatal) throw result.error;
      if (attempt >= maxAttempts) {
        throw result.error ?? new Error(`HTTP ${result.status} for ${url} after ${attempt} attempts`);
      }

      // Back off: honour Retry-After when present, otherwise exponential with jitter.
      const backoff = Math.min(60_000, 1000 * 2 ** (attempt - 1)) + Math.random() * 500;
      const wait = result.retryAfter !== undefined ? Math.max(result.retryAfter, 1000) : backoff;
      if (result.status === 429) {
        this.stats.rateLimited++;
        this.pacer.pause(wait);
        this.log(`  rate limited by the registry, pausing all requests for ${(wait / 1000).toFixed(1)}s`);
      } else {
        this.log(`  ${result.error?.message ?? `HTTP ${result.status}`} for ${url}; retrying in ${(wait / 1000).toFixed(1)}s`);
      }
      this.stats.retries++;
      await sleep(wait);
    }
  }

  // ---- public API -------------------------------------------------------------

  /**
   * Returns a compact summary of a package's registry document:
   * `{ name, fetchedAt, notFound?, distTags, modified, versions: { [v]: { time, deprecated? } } }`
   */
  async getPackage(name) {
    const cached = this.#readCache('pkg', name);
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }
    const url = `${this.registryUrl}/${name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`;
    let entry;
    try {
      const { status, body } = await this.#request(url);
      if (status === 404 || !body) {
        this.stats.notFound++;
        entry = { name, fetchedAt: new Date().toISOString(), notFound: true };
      } else {
        entry = summarisePackument(name, body);
      }
    } catch (error) {
      this.stats.failed++;
      this.log(`  failed to fetch ${name}: ${error.message}`);
      return { name, fetchedAt: new Date().toISOString(), error: error.message };
    }
    this.#writeCache('pkg', name, entry);
    return entry;
  }

  /**
   * Looks up security advisories for `{ [name]: [versions] }` using the bulk
   * advisory endpoint also used by `npm audit`. Returns `{ [name]: Advisory[] }`.
   */
  async getAdvisories(versionsByName, { batchSize = 100 } = {}) {
    const result = {};
    const pending = {};
    for (const [name, versions] of Object.entries(versionsByName)) {
      const wanted = [...new Set(versions)].sort();
      if (!wanted.length) continue;
      const cached = this.#readCache('adv', name);
      if (cached && wanted.every((v) => cached.versions.includes(v))) {
        this.stats.cacheHits++;
        result[name] = cached.advisories;
      } else {
        pending[name] = wanted;
      }
    }

    const names = Object.keys(pending);
    for (let i = 0; i < names.length; i += batchSize) {
      const batch = Object.fromEntries(names.slice(i, i + batchSize).map((n) => [n, pending[n]]));
      let body;
      try {
        ({ body } = await this.#request(`${this.registryUrl}/-/npm/v1/security/advisories/bulk`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(batch),
        }));
      } catch (error) {
        this.stats.failed++;
        this.log(`  advisory lookup failed for a batch of ${Object.keys(batch).length} packages: ${error.message}`);
        continue;
      }
      const fetchedAt = new Date().toISOString();
      for (const name of Object.keys(batch)) {
        const advisories = (body?.[name] ?? []).map((a) => ({
          id: a.id,
          url: a.url,
          title: a.title,
          severity: a.severity,
          vulnerableVersions: a.vulnerable_versions,
          cvssScore: a.cvss?.score ?? null,
        }));
        result[name] = advisories;
        this.#writeCache('adv', name, { name, fetchedAt, versions: batch[name], advisories });
      }
    }
    return result;
  }
}

/** Reduces a (possibly huge) packument to the few fields the report needs. */
export function summarisePackument(name, doc) {
  const versions = {};
  const time = doc.time ?? {};
  for (const [version, meta] of Object.entries(doc.versions ?? {})) {
    const v = { time: time[version] ?? null };
    if (meta?.deprecated) v.deprecated = typeof meta.deprecated === 'string' ? meta.deprecated : 'deprecated';
    versions[version] = v;
  }
  return {
    name,
    fetchedAt: new Date().toISOString(),
    distTags: doc['dist-tags'] ?? {},
    modified: time.modified ?? null,
    created: time.created ?? null,
    homepage: typeof doc.homepage === 'string' ? doc.homepage : null,
    repository: typeof doc.repository?.url === 'string' ? doc.repository.url : typeof doc.repository === 'string' ? doc.repository : null,
    versions,
  };
}
