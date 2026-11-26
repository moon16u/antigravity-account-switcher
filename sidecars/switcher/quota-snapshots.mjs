import { callLsRpc } from './active-work.mjs';
import {
  atomicWriteFile,
  loadVault,
  normalizeEmail,
  normalizeTierName,
  readSafeJsonFile,
  UUID_RE,
} from './vault.mjs';

export const STALE_SNAPSHOT_MS = 24 * 60 * 60 * 1000;
const MAX_SNAPSHOT_BYTES = 256 * 1024;

function sanitizeText(value, maxLen = 160) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function normalizeQuotaBucket(bucket) {
  if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) return null;
  let remainingFraction = null;
  if (typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)) {
    remainingFraction = Math.min(1, Math.max(0, bucket.remainingFraction));
  }
  const resetTime =
    typeof bucket.resetTime === 'string' && bucket.resetTime.trim() && Number.isFinite(Date.parse(bucket.resetTime))
      ? bucket.resetTime.trim()
      : '';
  const bucketId = sanitizeText(bucket.bucketId, 64);
  const displayName = sanitizeText(bucket.displayName, 96);
  const description = sanitizeText(bucket.description, 320);
  const win = sanitizeText(bucket.window, 32).toLowerCase();
  const disabled = Boolean(bucket.disabled);

  if (!win && !displayName && !bucketId && remainingFraction === null) {
    return null;
  }

  return {
    bucketId,
    displayName,
    description,
    window: win,
    remainingFraction,
    disabled,
    resetTime,
  };
}

export function normalizeQuotaSummary(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw.response && typeof raw.response === 'object' && !Array.isArray(raw.response) ? raw.response : raw;
  const groups = [];

  if (Array.isArray(src.groups)) {
    for (const grp of src.groups) {
      if (groups.length >= 12) break;
      if (!grp || typeof grp !== 'object' || Array.isArray(grp)) continue;
      const displayName = sanitizeText(grp.displayName, 96);
      const description = sanitizeText(grp.description, 320);
      const buckets = Array.isArray(grp.buckets)
        ? grp.buckets.map(normalizeQuotaBucket).filter(Boolean).slice(0, 8)
        : [];
      if (!displayName && buckets.length === 0) continue;
      groups.push({ displayName, description, buckets });
    }
  }

  if (groups.length === 0 && Array.isArray(src.buckets)) {
    const flatBuckets = src.buckets.map(normalizeQuotaBucket).filter(Boolean).slice(0, 8);
    if (flatBuckets.length > 0) {
      groups.push({
        displayName: 'Models',
        description: '',
        buckets: flatBuckets,
      });
    }
  }

  return {
    groups,
    description: sanitizeText(src.description, 600),
    fetchedAt: new Date().toISOString(),
  };
}

function normalizeSnapshotRecord(accountId, record) {
  const summary = normalizeQuotaSummary(record?.summary);
  if (!summary?.groups.length) return null;
  const capturedAt = sanitizeText(record.capturedAt, 64);
  const fetchedAt = sanitizeText(record.summary.fetchedAt, 64);
  summary.fetchedAt = Number.isFinite(Date.parse(fetchedAt)) ? fetchedAt : capturedAt;
  return {
    accountId,
    tierName: normalizeTierName(record.tierName),
    syncSource: sanitizeText(record.syncSource, 48),
    capturedAt,
    summary,
  };
}

function normalizeStore(store) {
  const accounts = {};
  if (store?.v === 1 && store.accounts && typeof store.accounts === 'object' && !Array.isArray(store.accounts)) {
    for (const [id, record] of Object.entries(store.accounts)) {
      if (!UUID_RE.test(id)) continue;
      const clean = normalizeSnapshotRecord(id, record);
      if (clean) accounts[id] = clean;
    }
  }
  return { v: 1, accounts };
}

export function loadQuotaSnapshots(paths) {
  return normalizeStore(readSafeJsonFile(paths.quotaSnapshotsPath, MAX_SNAPSHOT_BYTES));
}

export function saveQuotaSnapshots(paths, store) {
  const json = JSON.stringify(normalizeStore(store)) + '\n';
  if (Buffer.byteLength(json) > MAX_SNAPSHOT_BYTES) throw new Error('QUOTA_SNAPSHOTS_TOO_LARGE');
  atomicWriteFile(paths.quotaSnapshotsPath, json, 0o600);
}

export function upsertQuotaSnapshot(paths, {
  accountId, tierName = '', summary, syncSource = 'manual', capturedAt = new Date().toISOString(),
}) {
  if (typeof accountId !== 'string' || !UUID_RE.test(accountId)) throw new Error('INVALID_ACCOUNT_ID');
  const record = normalizeSnapshotRecord(accountId, { tierName, summary, syncSource, capturedAt });
  if (!record) throw new Error('INVALID_QUOTA_SUMMARY');
  const store = loadQuotaSnapshots(paths);
  store.accounts[accountId] = record;
  saveQuotaSnapshots(paths, store);
  return record;
}

export function deleteQuotaSnapshot(paths, accountId) {
  if (typeof accountId !== 'string' || !UUID_RE.test(accountId)) return;
  const store = loadQuotaSnapshots(paths);
  if (Object.hasOwn(store.accounts, accountId)) {
    delete store.accounts[accountId];
    saveQuotaSnapshots(paths, store);
  }
}

export function projectQuotaSummary(record, { nowMs = Date.now() } = {}) {
  if (!record?.summary) {
    return {
      hasSnapshot: false, source: 'none', capturedAt: '', syncSource: '', tierName: '',
      isStale: false, estimatedAnyReset: false, usage: null,
    };
  }

  let estimatedAnyReset = false;
  const usage = structuredClone(record.summary);
  for (const group of usage.groups || []) {
    for (const bucket of group.buckets || []) {
      const resetMs = bucket.resetTime ? Date.parse(bucket.resetTime) : NaN;
      bucket.estimatedReset = Boolean(!bucket.disabled && Number.isFinite(resetMs) && resetMs <= nowMs);
      if (bucket.estimatedReset) {
        bucket.snapshotRemainingFraction = bucket.remainingFraction;
        bucket.remainingFraction = 1;
        estimatedAnyReset = true;
      }
    }
  }
  const capturedMs = Date.parse(record.capturedAt || '');
  return {
    hasSnapshot: true,
    source: 'snapshot',
    capturedAt: record.capturedAt || '',
    syncSource: record.syncSource || '',
    tierName: record.tierName || '',
    isStale: Boolean(Number.isFinite(capturedMs) && nowMs - capturedMs > STALE_SNAPSHOT_MS),
    estimatedAnyReset,
    usage,
  };
}

export function createQuotaService({
  paths, env = process.env, callLsRpcFn = callLsRpc, cacheTtlMs = 30_000, nowFn = () => Date.now(),
}) {
  let activeCache = null;

  async function requestSummary(forceRefresh) {
    try {
      const raw = await callLsRpcFn(env, 'RetrieveUserQuotaSummary', {
        timeoutMs: 2500, body: forceRefresh ? { forceRefresh: true } : {},
      });
      const summary = normalizeQuotaSummary(raw);
      return summary?.groups.length ? summary : null;
    } catch {
      return null;
    }
  }

  async function fetchActiveQuota({ accountId = '', tierName = '', syncSource = 'manual', forceRefresh = false } = {}) {
    if (activeCache?.accountId !== accountId) {
      activeCache = { accountId, summary: null, cachedAt: 0, activeInFlight: null };
    }
    const cache = activeCache;
    let summary = cache.summary;
    if (forceRefresh || !summary || nowFn() - cache.cachedAt >= cacheTtlMs) {
      if (!cache.activeInFlight) {
        cache.activeInFlight = requestSummary(forceRefresh)
          .then((result) => {
            if (result) {
              cache.summary = result;
              cache.cachedAt = nowFn();
            }
            return result;
          })
          .finally(() => {
            cache.activeInFlight = null;
          });
      }
      summary = await cache.activeInFlight;
    }

    // A switch or removal can invalidate this request while the RPC is in flight.
    if (!summary || cache !== activeCache) return null;
    if (typeof accountId === 'string' && UUID_RE.test(accountId)) {
      upsertQuotaSnapshot(paths, { accountId, tierName, summary, syncSource, capturedAt: summary.fetchedAt });
    }
    return { usage: summary, tierName, source: 'live', capturedAt: summary.fetchedAt };
  }

  async function capturePreSwitchSnapshot({ accountId = '', tierName = '' } = {}) {
    try {
      return Boolean(await fetchActiveQuota({ accountId, tierName, syncSource: 'pre_switch_snapshot', forceRefresh: true }));
    } catch {
      return false;
    }
  }

  async function getAccountUsage({
    id, activeAccountId = '', activeEmail = '', lsConnected = false, tierName = '', forceRefresh = false, syncSource = 'ui',
  } = {}) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('INVALID_ACCOUNT_ID');
    const acc = loadVault(paths).accounts.find((entry) => entry.id === id);
    if (!acc) throw new Error('ACCOUNT_NOT_FOUND');
    const isActive = Boolean(
      (activeAccountId && id === activeAccountId) || (activeEmail && acc.email === normalizeEmail(activeEmail))
    );
    if (isActive && lsConnected) {
      const live = await fetchActiveQuota({
        accountId: id, tierName: tierName || acc.tierName, syncSource, forceRefresh,
      });
      if (live) {
        return {
          id, ...live, tierName: live.tierName || acc.tierName || '',
          isStale: false, estimatedAnyReset: false, hasSnapshot: true,
        };
      }
    }
    const projected = projectQuotaSummary(loadQuotaSnapshots(paths).accounts[id], { nowMs: nowFn() });
    return {
      id, usage: projected.usage, tierName: acc.tierName || projected.tierName || '',
      source: projected.source, capturedAt: projected.capturedAt, isStale: projected.isStale,
      estimatedAnyReset: projected.estimatedAnyReset, hasSnapshot: projected.hasSnapshot,
    };
  }

  function buildProjectedUsageMap(accounts = [], { activeAccountId = '', activeUsage = null, nowMs = nowFn() } = {}) {
    const snapshots = loadQuotaSnapshots(paths);
    const result = new Map();
    for (const { id } of accounts) {
      if (id === activeAccountId && activeUsage) {
        result.set(id, {
          usage: activeUsage, source: 'live', capturedAt: activeUsage.fetchedAt || '',
          estimatedAnyReset: false, isStale: false,
        });
      } else if (Object.hasOwn(snapshots.accounts, id)) {
        const { usage, source, capturedAt, estimatedAnyReset, isStale } =
          projectQuotaSummary(snapshots.accounts[id], { nowMs });
        result.set(id, { usage, source, capturedAt, estimatedAnyReset, isStale });
      }
    }
    return result;
  }

  function invalidateCache() {
    activeCache = null;
  }

  return { fetchActiveQuota, capturePreSwitchSnapshot, getAccountUsage, buildProjectedUsageMap, invalidateCache };
}
