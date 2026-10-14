/**
 * Small npm registry client with
 *  - a persistent on-disk cache (one JSON file per package, TTL based),
 *  - a global pacing of requests (minimum interval + bounded concurrency),
 *  - retries with exponential backoff that honour Retry-After / 429 / 503.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Advisory, RegistryPackage } from './types.ts';

const CACHE_SCHEMA = 2;
const USER_AGENT = 'rhdh-dependency-check (+https://github.com/christoph-jerolimov/rhdh-dependency-check)';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RegistryClientOptions {
  registryUrl: string;
  cacheDir: string;
  ttlHours: number;
  intervalMs: number;
  concurrency: number;
  log?: (message: string) => void;
}

export interface RegistryStats {
  requests: number;
  cacheHits: number;
  retries: number;
  rateLimited: number;
  notFound: number;
  failed: number;
}

/** Shape of the npm registry packument fields we read. */
interface Packument {
  'dist-tags'?: Record<string, string>;
  time?: Record<string, string>;
  homepage?: unknown;
  repository?: unknown;
  versions?: Record<string, { deprecated?: unknown }>;
}

interface BulkAdvisory {
  id: number;
  url: string;
  title: string;
  severity: string;
  vulnerable_versions: string;
  cvss?: { score?: number };
}

interface AdvisoryCacheEntry {
  name: string;
  fetchedAt: string;
  versions: string[];
  advisories: Advisory[];
}

type CachedEntry = { schema: number; name: string; fetchedAt: string };

type RequestResult<T> =
  | { kind: 'ok'; status: number; body: T | null }
  | { kind: 'retry'; status: number; retryAfter: number | undefined }
  | { kind: 'error'; error: Error & { fatal?: boolean } };

interface Job {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/** Serialises request starts: at most `concurrency` in flight, `intervalMs` between starts. */
class Pacer {
  readonly intervalMs: number;
  readonly concurrency: number;
  private active = 0;
  private queue: Job[] = [];
  private nextStartAt = 0;
  private pausedUntil = 0;
  private pumping = false;

  constructor({ intervalMs, concurrency }: { intervalMs: number; concurrency: number }) {
    this.intervalMs = intervalMs;
    this.concurrency = Math.max(1, concurrency);
  }

  /** Called when the registry asks us to slow down. All lanes wait. */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, resolve: resolve as (value: unknown) => void, reject });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    while (this.queue.length && this.active < this.concurrency) {
      const wait = Math.max(this.nextStartAt, this.pausedUntil) - Date.now();
      if (wait > 0) await sleep(wait);
      if (this.active >= this.concurrency) break; // a finishing job re-enters pump()
      const job = this.queue.shift()!;
      this.nextStartAt = Date.now() + this.intervalMs;
      this.active++;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--;
          void this.pump();
        });
    }
    this.pumping = false;
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export class RegistryClient {
  readonly registryUrl: string;
  readonly cacheDir: string;
  readonly ttlMs: number;
  readonly stats: RegistryStats = { requests: 0, cacheHits: 0, retries: 0, rateLimited: 0, notFound: 0, failed: 0 };
  private readonly pacer: Pacer;
  private readonly log: (message: string) => void;

  constructor({ registryUrl, cacheDir, ttlHours, intervalMs, concurrency, log = console.log }: RegistryClientOptions) {
    this.registryUrl = registryUrl.replace(/\/$/, '');
    this.cacheDir = cacheDir;
    this.ttlMs = ttlHours * 60 * 60 * 1000;
    this.pacer = new Pacer({ intervalMs, concurrency });
    this.log = log;
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  // ---- cache -----------------------------------------------------------------

  private cacheFile(kind: 'pkg' | 'adv', name: string): string {
    return path.join(this.cacheDir, `${kind}--${name.replace(/^@/, '').replace(/\//g, '__')}.json`);
  }

  private readCache<T extends { name: string; fetchedAt: string }>(kind: 'pkg' | 'adv', name: string): T | undefined {
    const file = this.cacheFile(kind, name);
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8')) as CachedEntry & T;
      if (entry.schema !== CACHE_SCHEMA || entry.name !== name) return undefined;
      const age = Date.now() - Date.parse(entry.fetchedAt);
      if (!(age < this.ttlMs)) return undefined;
      return entry;
    } catch {
      return undefined;
    }
  }

  private writeCache<T extends { name: string; fetchedAt: string }>(kind: 'pkg' | 'adv', name: string, entry: T): void {
    const file = this.cacheFile(kind, name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schema: CACHE_SCHEMA, ...entry }));
    fs.renameSync(tmp, file);
  }

  // ---- HTTP ------------------------------------------------------------------

  /**
   * Performs one request through the pacer with retries.
   * Resolves with `{ status, body }`; `body` is parsed JSON (or null for 404).
   */
  private async request<T>(url: string, init: RequestInit = {}, { maxAttempts = 6 } = {}): Promise<{ status: number; body: T | null }> {
    let attempt = 0;
    for (;;) {
      attempt++;
      const result: RequestResult<T> = await this.pacer
        .run(async (): Promise<RequestResult<T>> => {
          this.stats.requests++;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 120_000);
          try {
            const response = await fetch(url, {
              ...init,
              signal: controller.signal,
              headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
            });
            if (response.status === 404) {
              await response.arrayBuffer().catch(() => undefined);
              return { kind: 'ok', status: 404, body: null };
            }
            if (response.status === 429 || response.status === 503 || response.status >= 500) {
              const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
              await response.arrayBuffer().catch(() => undefined);
              return { kind: 'retry', status: response.status, retryAfter };
            }
            if (!response.ok) {
              const text = await response.text().catch(() => '');
              throw Object.assign(new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 200)}`), { fatal: true });
            }
            return { kind: 'ok', status: response.status, body: (await response.json()) as T };
          } finally {
            clearTimeout(timer);
          }
        })
        .catch((error: unknown): RequestResult<T> => ({ kind: 'error', error: error instanceof Error ? error : new Error(String(error)) }));

      if (result.kind === 'ok') return { status: result.status, body: result.body };

      if (result.kind === 'error' && result.error.fatal) throw result.error;
      const describe = result.kind === 'error' ? result.error.message : `HTTP ${result.status}`;
      if (attempt >= maxAttempts) {
        throw result.kind === 'error' ? result.error : new Error(`${describe} for ${url} after ${attempt} attempts`);
      }

      // Back off: honour Retry-After when present, otherwise exponential with jitter.
      const backoff = Math.min(60_000, 1000 * 2 ** (attempt - 1)) + Math.random() * 500;
      const retryAfter = result.kind === 'retry' ? result.retryAfter : undefined;
      const wait = retryAfter !== undefined ? Math.max(retryAfter, 1000) : backoff;
      if (result.kind === 'retry' && result.status === 429) {
        this.stats.rateLimited++;
        this.pacer.pause(wait);
        this.log(`  rate limited by the registry, pausing all requests for ${(wait / 1000).toFixed(1)}s`);
      } else {
        this.log(`  ${describe} for ${url}; retrying in ${(wait / 1000).toFixed(1)}s`);
      }
      this.stats.retries++;
      await sleep(wait);
    }
  }

  // ---- public API -------------------------------------------------------------

  /** Returns a compact summary of a package's registry document. */
  async getPackage(name: string): Promise<RegistryPackage> {
    const cached = this.readCache<RegistryPackage>('pkg', name);
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }
    const url = `${this.registryUrl}/${name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`;
    let entry: RegistryPackage;
    try {
      const { status, body } = await this.request<Packument>(url);
      if (status === 404 || !body) {
        this.stats.notFound++;
        entry = { name, fetchedAt: new Date().toISOString(), notFound: true };
      } else {
        entry = summarisePackument(name, body);
      }
    } catch (error) {
      this.stats.failed++;
      const message = error instanceof Error ? error.message : String(error);
      this.log(`  failed to fetch ${name}: ${message}`);
      return { name, fetchedAt: new Date().toISOString(), error: message };
    }
    this.writeCache('pkg', name, entry);
    return entry;
  }

  /**
   * Looks up security advisories for `{ [name]: [versions] }` using the bulk
   * advisory endpoint also used by `npm audit`. Returns `{ [name]: Advisory[] }`.
   */
  async getAdvisories(versionsByName: Record<string, string[]>, { batchSize = 100 } = {}): Promise<Record<string, Advisory[]>> {
    const result: Record<string, Advisory[]> = {};
    const pending: Record<string, string[]> = {};
    for (const [name, versions] of Object.entries(versionsByName)) {
      const wanted = [...new Set(versions)].sort();
      if (!wanted.length) continue;
      const cached = this.readCache<AdvisoryCacheEntry>('adv', name);
      if (cached && wanted.every((v) => cached.versions.includes(v))) {
        this.stats.cacheHits++;
        result[name] = cached.advisories;
      } else {
        pending[name] = wanted;
      }
    }

    const names = Object.keys(pending);
    for (let i = 0; i < names.length; i += batchSize) {
      const batch = Object.fromEntries(names.slice(i, i + batchSize).map((n) => [n, pending[n]!]));
      let body: Record<string, BulkAdvisory[]> | null;
      try {
        ({ body } = await this.request<Record<string, BulkAdvisory[]>>(`${this.registryUrl}/-/npm/v1/security/advisories/bulk`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(batch),
        }));
      } catch (error) {
        this.stats.failed++;
        const message = error instanceof Error ? error.message : String(error);
        this.log(`  advisory lookup failed for a batch of ${Object.keys(batch).length} packages: ${message}`);
        continue;
      }
      const fetchedAt = new Date().toISOString();
      for (const name of Object.keys(batch)) {
        const advisories: Advisory[] = (body?.[name] ?? []).map((a) => ({
          id: a.id,
          url: a.url,
          title: a.title,
          severity: a.severity,
          vulnerableVersions: a.vulnerable_versions,
          cvssScore: a.cvss?.score ?? null,
        }));
        result[name] = advisories;
        this.writeCache('adv', name, { name, fetchedAt, versions: batch[name]!, advisories } satisfies AdvisoryCacheEntry);
      }
    }
    return result;
  }
}

/** Reduces a (possibly huge) packument to the few fields the report needs. */
export function summarisePackument(name: string, doc: Packument): RegistryPackage {
  const versions: NonNullable<RegistryPackage['versions']> = {};
  const time = doc.time ?? {};
  for (const [version, meta] of Object.entries(doc.versions ?? {})) {
    const v: { time: string | null; deprecated?: string } = { time: time[version] ?? null };
    if (meta?.deprecated) v.deprecated = typeof meta.deprecated === 'string' ? meta.deprecated : 'deprecated';
    versions[version] = v;
  }
  const repository = doc.repository;
  return {
    name,
    fetchedAt: new Date().toISOString(),
    distTags: doc['dist-tags'] ?? {},
    modified: time.modified ?? null,
    created: time.created ?? null,
    homepage: typeof doc.homepage === 'string' ? doc.homepage : null,
    repository:
      typeof repository === 'string'
        ? repository
        : repository && typeof repository === 'object' && typeof (repository as { url?: unknown }).url === 'string'
          ? (repository as { url: string }).url
          : null,
    versions,
  };
}
