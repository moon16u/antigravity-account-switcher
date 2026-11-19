import { closeSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { callLsRpc } from './active-work.mjs';
import { httpsJsonRequest, loadNativeOAuthClients } from './oauth.mjs';
import { resolveLanguageServerCandidates } from './platform.mjs';
import {
  assertNotSymlink,
  loadVault,
  normalizeProjectId,
  normalizeTierName,
  updateAccountSyncFields,
  UUID_RE,
} from './vault.mjs';

export const DEFAULT_CLOUD_CODE_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
export const FALLBACK_CLOUD_CODE_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
export const DEFAULT_ANTIGRAVITY_VERSION = '2.32.1';

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/;
const WSL_LS_BIN_VER_RE = /\.antigravity-server[\\/]bin[\\/](\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)[\\/]language_server$/i;
const RESOURCES_LS_RE = /[\\/]resources[\\/]bin[\\/]language_server(?:\.exe)?$/i;
const TOKEN_EXPIRY_SKEW_MS = 120_000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

let cachedDefaultVersion = '';

function readAsarPackageVersion(asarPath) {
  let fd = -1;
  try {
    if (!assertNotSymlink(asarPath)) return '';
    fd = openSync(asarPath, 'r');
    const head = Buffer.allocUnsafe(16);
    if (readSync(fd, head, 0, 16, 0) !== 16) return '';
    const headerSize = head.readUInt32LE(12);
    const baseOffset = 8 + head.readUInt32LE(4);
    if (headerSize <= 0 || headerSize > 2 * 1024 * 1024 || baseOffset < 16) return '';
    const hdrBuf = Buffer.allocUnsafe(headerSize);
    if (readSync(fd, hdrBuf, 0, headerSize, 16) !== headerSize) return '';
    const header = JSON.parse(hdrBuf.toString('utf8'));
    const pkgNode = header?.files?.['package.json'];
    const pkgSize = Number(pkgNode?.size || 0);
    const pkgOffset = Number(pkgNode?.offset || 0);
    if (
      !Number.isSafeInteger(pkgSize) ||
      pkgSize <= 0 ||
      pkgSize > 64 * 1024 ||
      !Number.isSafeInteger(pkgOffset) ||
      pkgOffset < 0
    ) {
      return '';
    }
    const pkgBuf = Buffer.allocUnsafe(pkgSize);
    if (readSync(fd, pkgBuf, 0, pkgSize, baseOffset + pkgOffset) !== pkgSize) return '';
    const pkg = JSON.parse(pkgBuf.toString('utf8'));
    const ver = typeof pkg?.version === 'string' ? pkg.version.trim() : '';
    return SEMVER_RE.test(ver) ? ver : '';
  } catch {
    return '';
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // Ignore fd cleanup error
      }
    }
  }
}

export function resolveAntigravityVersion(env = process.env, { candidates = null } = {}) {
  const envVer = typeof env?.ANTIGRAVITY_IDE_VERSION === 'string' ? env.ANTIGRAVITY_IDE_VERSION.trim() : '';
  if (SEMVER_RE.test(envVer)) {
    return envVer;
  }

  const useCache = env === process.env && !candidates;
  if (useCache && cachedDefaultVersion) {
    return cachedDefaultVersion;
  }

  const lsCandidates = Array.isArray(candidates) ? candidates : resolveLanguageServerCandidates(env);
  let resolved = '';

  for (const cand of lsCandidates) {
    if (typeof cand !== 'string') continue;
    const match = WSL_LS_BIN_VER_RE.exec(cand);
    if (match && SEMVER_RE.test(match[1])) {
      resolved = match[1];
      break;
    }
  }

  if (!resolved) {
    for (const cand of lsCandidates) {
      if (typeof cand !== 'string' || !RESOURCES_LS_RE.test(cand)) continue;
      const ver = readAsarPackageVersion(join(dirname(dirname(cand)), 'app.asar'));
      if (ver) {
        resolved = ver;
        break;
      }
    }
  }

  if (!resolved) {
    resolved = DEFAULT_ANTIGRAVITY_VERSION;
  }
  if (useCache) {
    cachedDefaultVersion = resolved;
  }
  return resolved;
}

export function buildCloudCodeUserAgent({
  version = DEFAULT_ANTIGRAVITY_VERSION,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const safeVer = SEMVER_RE.test(String(version || '')) ? String(version) : DEFAULT_ANTIGRAVITY_VERSION;
  const osType = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
  const cleanArch = String(arch || 'amd64').replace(/[^a-z0-9_]/gi, '');
  const goArch = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : cleanArch || 'amd64';
  return `antigravity/hub/${safeVer} (os_type=${osType}; arch=${goArch}; auth_method=consumer; purpose=aidev_client)`;
}

function sanitizeText(value, maxLen = 160) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function safeShallowClone(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export function mapCloudCodePlatform(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'DARWIN_ARM64' : 'DARWIN_AMD64';
  }
  if (platform === 'win32') {
    return 'WINDOWS_AMD64';
  }
  return arch === 'arm64' ? 'LINUX_ARM64' : 'LINUX_AMD64';
}

export function extractCloudCodeProfile(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { tierName: '', projectId: '' };
  }
  const paidName = normalizeTierName(json?.paidTier?.name || json?.paidTier?.description || '');
  const currentName = normalizeTierName(json?.currentTier?.name || json?.currentTier?.description || '');
  const tierName = paidName || currentName;

  const rawProj = json?.cloudaicompanionProject;
  const projectId = normalizeProjectId(typeof rawProj === 'string' ? rawProj : rawProj?.id || '');
  return { tierName, projectId };
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

function parseTokenExpiryMs(tokObj) {
  if (typeof tokObj.expiry === 'string' && tokObj.expiry.trim()) {
    return Date.parse(tokObj.expiry);
  }
  if (typeof tokObj.expiry_date === 'number') {
    return tokObj.expiry_date;
  }
  if (typeof tokObj.expiry_timestamp === 'number') {
    return tokObj.expiry_timestamp * 1000;
  }
  return NaN;
}

export async function ensureFreshAccessToken(
  tokenRaw,
  {
    env = process.env,
    loadClients = loadNativeOAuthClients,
    requestFn = httpsJsonRequest,
    nowMs = Date.now(),
    forceRefresh = false,
  } = {}
) {
  if (typeof tokenRaw !== 'string' || !tokenRaw.trim()) {
    throw new Error('INVALID_CREDENTIAL');
  }
  let source;
  try {
    source = JSON.parse(tokenRaw);
  } catch {
    throw new Error('INVALID_CREDENTIAL');
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('INVALID_CREDENTIAL');
  }

  const hasNested = Boolean(source.token && typeof source.token === 'object' && !Array.isArray(source.token));
  const tokObj = hasNested ? source.token : source;
  const accessToken = typeof tokObj.access_token === 'string' ? tokObj.access_token.trim() : '';
  const refreshToken = typeof tokObj.refresh_token === 'string' ? tokObj.refresh_token.trim() : '';
  const expiryMs = parseTokenExpiryMs(tokObj);

  if (!forceRefresh && accessToken && Number.isFinite(expiryMs) && expiryMs > nowMs + TOKEN_EXPIRY_SKEW_MS) {
    return {
      accessToken,
      refreshed: false,
      updatedTokenRaw: tokenRaw,
    };
  }

  if (!refreshToken) {
    throw new Error('INVALID_CREDENTIAL');
  }

  const clients = await loadClients(env);
  if (!Array.isArray(clients) || clients.length === 0) {
    throw new Error('OAUTH_CLIENT_UNAVAILABLE');
  }
  const client = clients[0];

  const body = new URLSearchParams({
    client_id: client.id,
    client_secret: client.secret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }).toString();

  const res = await requestFn(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
    env
  );

  const tok = res?.json;
  if (!res || res.status < 200 || res.status >= 300 || typeof tok?.access_token !== 'string' || !tok.access_token.trim()) {
    if (tok?.error === 'invalid_grant') {
      throw new Error('TOKEN_REFRESH_REVOKED');
    }
    throw new Error('TOKEN_REFRESH_FAILED');
  }

  const expiresIn = Number.isFinite(tok.expires_in) && tok.expires_in > 0 ? tok.expires_in : 3600;
  const nextExpiryIso = new Date(nowMs + expiresIn * 1000).toISOString();
  const nextRefresh =
    typeof tok.refresh_token === 'string' && tok.refresh_token.trim() ? tok.refresh_token.trim() : refreshToken;
  const nextAccess = tok.access_token.trim();

  let updatedObj;
  if (hasNested) {
    updatedObj = safeShallowClone(source);
    const nextTokenObj = safeShallowClone(tokObj);
    nextTokenObj.access_token = nextAccess;
    nextTokenObj.refresh_token = nextRefresh;
    nextTokenObj.token_type = 'Bearer';
    nextTokenObj.expiry = nextExpiryIso;
    nextTokenObj.expires_in = expiresIn;
    updatedObj.token = nextTokenObj;
  } else {
    updatedObj = safeShallowClone(source);
    updatedObj.access_token = nextAccess;
    updatedObj.refresh_token = nextRefresh;
    updatedObj.token_type = 'Bearer';
    updatedObj.expiry = nextExpiryIso;
    updatedObj.expires_in = expiresIn;
  }
  if (typeof tok.id_token === 'string' && tok.id_token) {
    updatedObj.id_token = tok.id_token;
  }

  return {
    accessToken: nextAccess,
    refreshed: true,
    updatedTokenRaw: JSON.stringify(updatedObj),
  };
}

export async function postCloudCodeJson(
  pathSuffix,
  accessToken,
  payloadObj = {},
  { env = process.env, requestFn = httpsJsonRequest, timeoutMs = 10_000, userAgent = '' } = {}
) {
  const suffix = String(pathSuffix || '').startsWith('/') ? pathSuffix : `/${pathSuffix}`;
  const reqOpts = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': userAgent || buildCloudCodeUserAgent({ version: resolveAntigravityVersion(env) }),
    },
    body: JSON.stringify(payloadObj && typeof payloadObj === 'object' ? payloadObj : {}),
    timeoutMs,
  };

  let res = await requestFn(`${DEFAULT_CLOUD_CODE_ENDPOINT}${suffix}`, reqOpts, env);
  if (res && (res.status === 404 || res.status >= 500)) {
    res = await requestFn(`${FALLBACK_CLOUD_CODE_ENDPOINT}${suffix}`, reqOpts, env);
  }
  return {
    status: res?.status || 0,
    json: res?.json ?? null,
  };
}

export async function fetchCloudCodeProfile(accessToken, opts = {}) {
  const version = resolveAntigravityVersion(opts.env);
  const res = await postCloudCodeJson(
    '/v1internal:loadCodeAssist',
    accessToken,
    {
      metadata: {
        ideType: 'ANTIGRAVITY',
        ideVersion: version,
        platform: mapCloudCodePlatform(),
        pluginType: 'GEMINI',
      },
    },
    opts
  );
  const profile =
    res.status >= 200 && res.status < 300 ? extractCloudCodeProfile(res.json) : { tierName: '', projectId: '' };
  return {
    status: res.status,
    tierName: profile.tierName,
    projectId: profile.projectId,
  };
}

export async function fetchCloudCodeQuotaSummary(accessToken, { projectId = '', ...opts } = {}) {
  const cleanProj = normalizeProjectId(projectId);
  const res = await postCloudCodeJson(
    '/v1internal:retrieveUserQuotaSummary',
    accessToken,
    cleanProj ? { project: cleanProj } : {},
    opts
  );
  return {
    status: res.status,
    summary: res.status >= 200 && res.status < 300 ? normalizeQuotaSummary(res.json) : null,
  };
}

async function runWithConcurrency(items, limit, workerFn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        results[idx] = await workerFn(items[idx], idx);
      }
    })
  );
  return results;
}

export function createCloudCodeService({
  paths,
  env = process.env,
  loadClients = loadNativeOAuthClients,
  requestFn = httpsJsonRequest,
  callLsRpcFn = callLsRpc,
  cacheTtlMs = 30_000,
  nowFn = () => Date.now(),
} = {}) {
  const usageCache = new Map();

  function invalidateCache(id) {
    if (typeof id === 'string' && id) {
      usageCache.delete(id);
    }
  }

  async function fetchProfileForAccessToken(accessToken) {
    if (typeof accessToken !== 'string' || !accessToken.trim()) {
      return { tierName: '', projectId: '' };
    }
    try {
      const res = await fetchCloudCodeProfile(accessToken.trim(), { env, requestFn });
      return {
        tierName: res.tierName || '',
        projectId: res.projectId || '',
      };
    } catch {
      return { tierName: '', projectId: '' };
    }
  }

  async function syncAccountTiers({ onlyMissing = false, accountIds = null } = {}) {
    if (!assertNotSymlink(paths.vaultPath)) {
      return { syncedCount: 0, updatedCount: 0, failedCount: 0, skippedCount: 0 };
    }
    const vault = loadVault(paths);
    const filterIds = Array.isArray(accountIds) && accountIds.length > 0 ? new Set(accountIds) : null;

    const candidates = [];
    let skippedCount = 0;
    for (const acc of vault.accounts) {
      if (filterIds && !filterIds.has(acc.id)) continue;
      if (onlyMissing && acc.tierName) {
        skippedCount += 1;
        continue;
      }
      candidates.push(acc);
    }

    if (candidates.length === 0) {
      return { syncedCount: 0, updatedCount: 0, failedCount: 0, skippedCount };
    }

    let syncedCount = 0;
    let failedCount = 0;
    const pendingUpdates = [];

    await runWithConcurrency(candidates, 3, async (acc) => {
      let refreshed = false;
      let latestTokenRaw = '';
      try {
        let tok = await ensureFreshAccessToken(acc.tokenRaw, {
          env,
          loadClients,
          requestFn,
          nowMs: nowFn(),
          forceRefresh: false,
        });
        let accessToken = tok.accessToken;
        refreshed = tok.refreshed;
        if (refreshed) latestTokenRaw = tok.updatedTokenRaw;

        let prof = await fetchCloudCodeProfile(accessToken, { env, requestFn });
        if (prof.status === 401 && !refreshed) {
          tok = await ensureFreshAccessToken(acc.tokenRaw, {
            env,
            loadClients,
            requestFn,
            nowMs: nowFn(),
            forceRefresh: true,
          });
          accessToken = tok.accessToken;
          refreshed = true;
          latestTokenRaw = tok.updatedTokenRaw;
          prof = await fetchCloudCodeProfile(accessToken, { env, requestFn });
        }

        if (prof.status >= 200 && prof.status < 300) {
          syncedCount += 1;
          const upd = { id: acc.id };
          if (prof.tierName) upd.tierName = prof.tierName;
          if (prof.projectId) upd.projectId = prof.projectId;
          if (latestTokenRaw) upd.tokenRaw = latestTokenRaw;
          if (upd.tierName || upd.projectId || upd.tokenRaw) {
            pendingUpdates.push(upd);
          }
        } else {
          failedCount += 1;
          if (latestTokenRaw) {
            pendingUpdates.push({ id: acc.id, tokenRaw: latestTokenRaw });
          }
        }
      } catch {
        failedCount += 1;
        if (latestTokenRaw) {
          pendingUpdates.push({ id: acc.id, tokenRaw: latestTokenRaw });
        }
      }
    });

    const updatedCount = updateAccountSyncFields(paths, pendingUpdates);
    return { syncedCount, updatedCount, failedCount, skippedCount };
  }

  async function fetchAccountUsage({ id, activeEmail = '', lsConnected = false, forceRefresh = false } = {}) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw new Error('INVALID_ACCOUNT_ID');
    }
    const vault = loadVault(paths);
    const acc = vault.accounts.find((a) => a.id === id);
    if (!acc) {
      throw new Error('ACCOUNT_NOT_FOUND');
    }

    if (!forceRefresh) {
      const cached = usageCache.get(id);
      if (cached && cached.expiresAt > nowFn()) {
        return {
          id,
          usage: cached.usage,
          tierName: acc.tierName || cached.tierName || '',
        };
      }
    }

    const normActive = typeof activeEmail === 'string' ? activeEmail.trim().toLowerCase() : '';
    if (lsConnected && normActive && acc.email === normActive) {
      try {
        const lsRaw = await callLsRpcFn(env, 'RetrieveUserQuotaSummary', {
          timeoutMs: 2500,
          body: forceRefresh ? { forceRefresh: true } : {},
        });
        const lsSummary = normalizeQuotaSummary(lsRaw);
        if (lsSummary && lsSummary.groups.length > 0) {
          const usage = { ...lsSummary, source: 'ls' };
          usageCache.set(id, {
            expiresAt: nowFn() + cacheTtlMs,
            usage,
            tierName: acc.tierName,
          });
          return { id, usage, tierName: acc.tierName };
        }
      } catch {
        // Fall back to remote Cloud Code query
      }
    }

    const tok = await ensureFreshAccessToken(acc.tokenRaw, {
      env,
      loadClients,
      requestFn,
      nowMs: nowFn(),
      forceRefresh: false,
    });
    let accessToken = tok.accessToken;
    let refreshed = tok.refreshed;
    let latestTokenRaw = tok.refreshed ? tok.updatedTokenRaw : '';
    let nextProjectId = acc.projectId || '';
    let nextTierName = acc.tierName || '';

    const forceRefreshTokenOnce = async () => {
      if (refreshed) return false;
      const retried = await ensureFreshAccessToken(acc.tokenRaw, {
        env,
        loadClients,
        requestFn,
        nowMs: nowFn(),
        forceRefresh: true,
      });
      accessToken = retried.accessToken;
      refreshed = true;
      latestTokenRaw = retried.updatedTokenRaw;
      return true;
    };

    const syncUpdate = () => {
      const upd = { id: acc.id };
      let hasChange = false;
      if (latestTokenRaw && latestTokenRaw !== acc.tokenRaw) {
        upd.tokenRaw = latestTokenRaw;
        hasChange = true;
      }
      if (nextTierName && nextTierName !== acc.tierName) {
        upd.tierName = nextTierName;
        hasChange = true;
      }
      if (nextProjectId && nextProjectId !== acc.projectId) {
        upd.projectId = nextProjectId;
        hasChange = true;
      }
      if (hasChange) {
        try {
          updateAccountSyncFields(paths, [upd]);
        } catch {
          // Best-effort vault persistence; do not discard fetched quota
        }
      }
    };

    try {
      if (!nextProjectId || !nextTierName || forceRefresh) {
        let profRes = await fetchCloudCodeProfile(accessToken, { env, requestFn });
        if (profRes.status === 401 && (await forceRefreshTokenOnce())) {
          profRes = await fetchCloudCodeProfile(accessToken, { env, requestFn });
        }
        if (profRes.status >= 200 && profRes.status < 300) {
          if (profRes.tierName) nextTierName = profRes.tierName;
          if (profRes.projectId) nextProjectId = profRes.projectId;
        }
      }

      let quotaRes = await fetchCloudCodeQuotaSummary(accessToken, {
        projectId: nextProjectId,
        env,
        requestFn,
      });

      if (quotaRes.status === 401 && (await forceRefreshTokenOnce())) {
        quotaRes = await fetchCloudCodeQuotaSummary(accessToken, {
          projectId: nextProjectId,
          env,
          requestFn,
        });
      }

      if ((quotaRes.status === 400 || quotaRes.status === 403 || quotaRes.status === 404) && acc.projectId) {
        const refreshedProf = await fetchCloudCodeProfile(accessToken, { env, requestFn });
        if (refreshedProf.status >= 200 && refreshedProf.status < 300) {
          if (refreshedProf.tierName) nextTierName = refreshedProf.tierName;
          nextProjectId = refreshedProf.projectId || '';
          quotaRes = await fetchCloudCodeQuotaSummary(accessToken, {
            projectId: nextProjectId,
            env,
            requestFn,
          });
        }
      }

      syncUpdate();

      const summary = quotaRes?.summary;
      if (!summary || summary.groups.length === 0) {
        throw new Error(quotaRes?.status >= 200 && quotaRes?.status < 300 ? 'USAGE_UNAVAILABLE' : 'USAGE_FETCH_FAILED');
      }

      const usage = { ...summary, source: 'remote' };
      usageCache.set(id, {
        expiresAt: nowFn() + cacheTtlMs,
        usage,
        tierName: nextTierName,
      });
      return { id, usage, tierName: nextTierName };
    } catch (err) {
      syncUpdate();
      throw err;
    }
  }

  return {
    invalidateCache,
    fetchProfileForAccessToken,
    syncAccountTiers,
    fetchAccountUsage,
  };
}
