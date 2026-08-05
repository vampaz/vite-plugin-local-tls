import { createHash } from 'node:crypto';
import { getGitRepoInfo } from './checkout-resolution.js';
import type { LocalTlsDomainOptions, LoopbackDomain } from './interfaces/plugin-options.js';

const MAX_DOMAIN_LABEL_LENGTH = 63;
const DOMAIN_LABEL_HASH_LENGTH = 10;

export const LOOPBACK_DOMAINS: Record<LoopbackDomain, string> = {
  'localtest.me': 'localtest.me',
  'lvh.me': 'lvh.me',
  'nip.io': '127.0.0.1.nip.io',
};

export function normalizeBaseDomain(baseDomain: string): string {
  return baseDomain
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .toLowerCase();
}

export function resolveBaseDomain(options: LocalTlsDomainOptions): string | null {
  if (options.baseDomain !== undefined) {
    return normalizeBaseDomain(options.baseDomain) || null;
  }

  if (options.loopbackDomain !== undefined) {
    return normalizeBaseDomain(LOOPBACK_DOMAINS[options.loopbackDomain]) || null;
  }

  return 'localhost';
}

export function normalizeDomain(domain: string): string | null {
  const normalized = domain.trim().toLowerCase();
  return normalized || null;
}

export function normalizeDomains(domains: string | string[]): string[] | null {
  const domainList = Array.isArray(domains) ? domains : [domains];
  const normalizedDomains = domainList.flatMap((domain) => {
    const normalizedDomain = normalizeDomain(domain);
    return normalizedDomain ? [normalizedDomain] : [];
  });

  return normalizedDomains.length > 0 ? [...new Set(normalizedDomains)] : null;
}

export function sanitizeDomainLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function compactDomainLabel(value: string): string {
  const sanitized = sanitizeDomainLabel(value);
  if (!sanitized || sanitized.length <= MAX_DOMAIN_LABEL_LENGTH) {
    return sanitized;
  }

  const hash = createHash('sha1')
    .update(sanitized)
    .digest('hex')
    .slice(0, DOMAIN_LABEL_HASH_LENGTH);
  const prefixLength = MAX_DOMAIN_LABEL_LENGTH - hash.length - 1;
  const prefix = sanitized.slice(0, prefixLength).replace(/-+$/g, '');
  return prefix ? `${prefix}-${hash}` : hash;
}

export function buildDerivedDomain(options: LocalTlsDomainOptions): string | null {
  const baseDomain = resolveBaseDomain(options);
  if (!baseDomain) {
    return null;
  }

  let repository = options.repo;
  let branch = options.branch;
  if (!repository || !branch) {
    const gitInfo = getGitRepoInfo();
    repository ||= gitInfo.repo;
    branch ||= gitInfo.branch;
  }

  if (!repository || !branch) {
    return null;
  }

  const labels = [compactDomainLabel(repository), compactDomainLabel(branch)];
  if (options.instanceLabel !== undefined) {
    labels.push(compactDomainLabel(options.instanceLabel));
  }
  if (labels.some((label) => !label)) {
    return null;
  }

  return `${labels.join('.')}.${baseDomain}`;
}

export function resolveLocalTlsDomains(options: LocalTlsDomainOptions = {}): string[] | null {
  if (options.domain !== undefined) {
    return normalizeDomains(options.domain);
  }

  const derivedDomain = buildDerivedDomain(options);
  return derivedDomain ? [derivedDomain] : null;
}

export function resolveLocalTlsUrl(options: LocalTlsDomainOptions = {}): string | null {
  const domains = resolveLocalTlsDomains(options);
  return domains?.length === 1 ? `https://${domains[0]}` : null;
}
