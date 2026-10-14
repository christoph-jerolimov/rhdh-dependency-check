import type { Level } from './types';

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  return iso.slice(0, 10);
}

export function formatAge(days: number | null | undefined): string {
  if (days === null || days === undefined) return '';
  if (days < 1) return 'today';
  if (days < 31) return `${days} day${days === 1 ? '' : 's'} ago`;
  if (days < 365) {
    const months = Math.floor(days / 30.44);
    return `${months} month${months === 1 ? '' : 's'} ago`;
  }
  const years = Math.floor(days / 365.25);
  const months = Math.floor((days - years * 365.25) / 30.44);
  return months ? `${years}y ${months}m ago` : `${years} year${years === 1 ? '' : 's'} ago`;
}

export const levelLabels: Record<Level, string> = {
  vulnerable: 'security',
  deprecated: 'deprecated',
  'outdated-major': 'major update',
  outdated: 'outdated',
  stale: 'stale',
  ok: 'up to date',
  local: 'local',
  unknown: 'unknown',
};

export const typeLabels: Record<string, string> = {
  prod: 'dep',
  dev: 'dev',
  peer: 'peer',
  optional: 'optional',
};

/** Prefixes a site-relative path with Astro's configured base. */
export function href(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${base}/${path.replace(/^\//, '')}`;
}

export function anchorId(...parts: (string | null | undefined)[]): string {
  return parts
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
