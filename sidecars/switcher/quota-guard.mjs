import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { callLsRpc } from './active-work.mjs';
import { atomicWriteFile, maskEmail, readSafeJsonFile } from './vault.mjs';

const MAX_GUARD_JSON_BYTES = 64 * 1024;
const MAX_HUB_JSON_BYTES = 32 * 1024;

export const DEFAULT_GUARD_SETTINGS = Object.freeze({
  alertEnabled: true,
  autoSwitchEnabled: false,
  autoResumeEnabled: false,
  skipOnboardingPrompt: false,
  dynamicThresholdEnabled: true,
  naturalPauseEnabled: true,
  thresholdPercent: 10,
  watchWeekly: true,
  watch5h: true,
  switchDelaySec: 3,
});

function clampInt(val, min, max, fallback) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function roundPercent(fraction) {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return null;
  const clamped = Math.min(1, Math.max(0, fraction));
  return Math.round(clamped * 1000) / 10;
}

function sanitizeText(val, maxLen = 120) {
  if (typeof val !== 'string') return '';
  return val
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export function normalizeGuardSettings(raw, base = DEFAULT_GUARD_SETTINGS) {
  const fallback = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const defaultFor = (key) =>
    Object.hasOwn(fallback, key) ? fallback[key] ?? DEFAULT_GUARD_SETTINGS[key] : DEFAULT_GUARD_SETTINGS[key];
  const valueFor = (key) => Object.hasOwn(src, key) ? src[key] : defaultFor(key);

  return {
    alertEnabled: Boolean(valueFor('alertEnabled')),
    autoSwitchEnabled: Boolean(valueFor('autoSwitchEnabled')),
    autoResumeEnabled: Boolean(valueFor('autoResumeEnabled')),
    skipOnboardingPrompt: Boolean(valueFor('skipOnboardingPrompt')),
    dynamicThresholdEnabled: Boolean(valueFor('dynamicThresholdEnabled')),
    naturalPauseEnabled: Boolean(valueFor('naturalPauseEnabled')),
    thresholdPercent: clampInt(valueFor('thresholdPercent'), 1, 50, defaultFor('thresholdPercent')),
    watchWeekly: Boolean(valueFor('watchWeekly')),
    watch5h: Boolean(valueFor('watch5h')),
    switchDelaySec: clampInt(valueFor('switchDelaySec'), 1, 10, defaultFor('switchDelaySec')),
  };
}

function randInt(min, max, randomFn) {
  return min + Math.floor(Math.min(0.999999, Math.max(0, Number(randomFn()) || 0)) * (max - min + 1));
}

export function computeSessionThresholds(baseThreshold = 10, { dynamicEnabled = true, randomFn = Math.random } = {}) {
  const base = clampInt(baseThreshold, dynamicEnabled ? 5 : 1, 50, 10);
  if (!dynamicEnabled) return { baseThreshold: base, hardFloor: base, softThreshold: base, jittered: false };
  const hardFloor = randInt(Math.max(3, base - 2), Math.min(50, base + 2), randomFn);
  const softThreshold = randInt(Math.min(65, hardFloor + 4), Math.min(65, hardFloor + 10), randomFn);
  return { baseThreshold: base, hardFloor, softThreshold, jittered: true };
}

export function computeNaturalPauseMs({ enabled = true, minMs = 3000, maxMs = 8000, randomFn = Math.random } = {}) {
  return enabled ? randInt(minMs, maxMs, randomFn) : 0;
}

export function loadGuardSettings(paths) {
  const parsed = readSafeJsonFile(paths?.settingsPath, MAX_GUARD_JSON_BYTES);
  if (!parsed) {
    return { ...DEFAULT_GUARD_SETTINGS };
  }
  return normalizeGuardSettings(parsed, DEFAULT_GUARD_SETTINGS);
}

export function saveGuardSettings(paths, patch) {
  if (!paths?.settingsPath) {
    throw new Error('MISSING_SETTINGS_PATH');
  }
  const current = loadGuardSettings(paths);
  const next = normalizeGuardSettings(patch, current);
  atomicWriteFile(paths.settingsPath, JSON.stringify({ v: 1, ...next }, null, 2) + '\n', 0o600);
  return next;
}

export function extractGeminiBuckets(summary) {
  const groups = Array.isArray(summary?.groups) ? summary.groups : [];
  let weeklyBucket = null;
  let fiveHourBucket = null;

  for (const grp of groups) {
    if (!grp || typeof grp !== 'object') continue;
    const isGeminiGroup = /gemini/i.test(String(grp.displayName || ''));
    const buckets = Array.isArray(grp.buckets) ? grp.buckets : [];
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== 'object') continue;
      const bid = String(bucket.bucketId || '').trim().toLowerCase();
      const win = String(bucket.window || '').trim().toLowerCase();
      if (bid === 'gemini-weekly' || (!weeklyBucket && isGeminiGroup && win === 'weekly')) {
        weeklyBucket = bucket;
      } else if (bid === 'gemini-5h' || (!fiveHourBucket && isGeminiGroup && win === '5h')) {
        fiveHourBucket = bucket;
      }
    }
  }

  return { weeklyBucket, fiveHourBucket };
}

export function evaluateQuotaAlert(summary, settings = DEFAULT_GUARD_SETTINGS, { sessionThresholds = null } = {}) {
  const cfg = normalizeGuardSettings(settings, DEFAULT_GUARD_SETTINGS);
  const { weeklyBucket, fiveHourBucket } = extractGeminiBuckets(summary);

  const weeklyFraction =
    weeklyBucket && !weeklyBucket.disabled && typeof weeklyBucket.remainingFraction === 'number' && Number.isFinite(weeklyBucket.remainingFraction)
      ? Math.min(1, Math.max(0, weeklyBucket.remainingFraction))
      : null;
  const fiveHourFraction =
    fiveHourBucket &&
    !fiveHourBucket.disabled &&
    typeof fiveHourBucket.remainingFraction === 'number' &&
    Number.isFinite(fiveHourBucket.remainingFraction)
      ? Math.min(1, Math.max(0, fiveHourBucket.remainingFraction))
      : null;

  const hardFloor = sessionThresholds?.hardFloor ?? cfg.thresholdPercent;
  const softThreshold = sessionThresholds?.softThreshold ?? cfg.thresholdPercent;
  const hardBuckets = [];
  const softBuckets = [];
  for (const [bucketId, watched, fraction] of [
    ['gemini-weekly', cfg.watchWeekly, weeklyFraction],
    ['gemini-5h', cfg.watch5h, fiveHourFraction],
  ]) {
    if (!watched || fraction === null) continue;
    if (fraction <= hardFloor / 100 + 1e-9) hardBuckets.push(bucketId);
    else if (softThreshold > hardFloor && fraction <= softThreshold / 100 + 1e-9) softBuckets.push(bucketId);
  }
  const level = hardBuckets.length ? 'hard' : softBuckets.length ? 'soft' : 'ok';
  const triggeredBuckets = hardBuckets.length ? hardBuckets : softBuckets;

  return {
    triggered: level !== 'ok',
    level,
    triggeredBuckets,
    weeklyPercent: roundPercent(weeklyFraction),
    fiveHourPercent: roundPercent(fiveHourFraction),
    thresholdPercent: cfg.thresholdPercent,
    softThresholdPercent: softThreshold,
    hardFloorPercent: hardFloor,
  };
}

export function pickBestBackupAccount(
  accounts = [],
  usageById = new Map(),
  { activeAccountId = '', activeEmail = '', thresholdPercent = 10 } = {}
) {
  const thresholdFrac = clampInt(thresholdPercent, 1, 50, DEFAULT_GUARD_SETTINGS.thresholdPercent) / 100;
  const normActiveEmail = typeof activeEmail === 'string' ? activeEmail.trim().toLowerCase() : '';
  const candidates = [];

  for (const acc of Array.isArray(accounts) ? accounts : []) {
    if (!acc || typeof acc !== 'object' || !acc.id) continue;
    if (acc.isActive) continue;
    if (activeAccountId && acc.id === activeAccountId) continue;
    if (normActiveEmail && typeof acc.email === 'string' && acc.email.trim().toLowerCase() === normActiveEmail) {
      continue;
    }

    const rawUsage = usageById instanceof Map ? usageById.get(acc.id) : usageById?.[acc.id];
    const summary = rawUsage?.usage && typeof rawUsage.usage === 'object' ? rawUsage.usage : rawUsage;
    if (!summary || typeof summary !== 'object') continue;

    const { weeklyBucket, fiveHourBucket } = extractGeminiBuckets(summary);
    if (weeklyBucket?.disabled || fiveHourBucket?.disabled) continue;

    const w =
      weeklyBucket && typeof weeklyBucket.remainingFraction === 'number' && Number.isFinite(weeklyBucket.remainingFraction)
        ? Math.min(1, Math.max(0, weeklyBucket.remainingFraction))
        : null;
    const h =
      fiveHourBucket && typeof fiveHourBucket.remainingFraction === 'number' && Number.isFinite(fiveHourBucket.remainingFraction)
        ? Math.min(1, Math.max(0, fiveHourBucket.remainingFraction))
        : null;

    if (w === null && h === null) continue;
    const aboveWeekly = w === null || w > thresholdFrac + 1e-9;
    const above5h = h === null || h > thresholdFrac + 1e-9;
    if (!aboveWeekly || !above5h) continue;

    const effectiveW = w ?? h;
    const effectiveH = h ?? w;
    const minFrac = Math.min(effectiveW, effectiveH);
    candidates.push({
      minFrac,
      weeklyFrac: effectiveW,
      fiveHourFrac: effectiveH,
      out: {
        id: acc.id,
        maskedEmail: acc.maskedEmail || (acc.email ? maskEmail(acc.email) : ''),
        label: sanitizeText(acc.label || '', 40),
        tierName: sanitizeText(acc.tierName || '', 64),
        estimatedReset: Boolean(rawUsage?.estimatedAnyReset || weeklyBucket?.estimatedReset || fiveHourBucket?.estimatedReset),
        capturedAt: sanitizeText(rawUsage?.capturedAt || '', 64),
        source: sanitizeText(rawUsage?.source || 'snapshot', 24),
        weeklyPercent: roundPercent(w),
        fiveHourPercent: roundPercent(h),
      },
    });
  }

  candidates.sort((a, b) => {
    if (b.minFrac !== a.minFrac) return b.minFrac - a.minFrac;
    if (b.weeklyFrac !== a.weeklyFrac) return b.weeklyFrac - a.weeklyFrac;
    return b.fiveHourFrac - a.fiveHourFrac;
  });

  return candidates.length > 0 ? candidates[0].out : null;
}

function sanitizeCandidateSnapshot(cand) {
  if (!cand || typeof cand !== 'object' || Array.isArray(cand) || typeof cand.id !== 'string' || !cand.id) {
    return null;
  }
  return {
    id: cand.id,
    estimatedReset: Boolean(cand.estimatedReset),
    capturedAt: sanitizeText(cand.capturedAt || '', 64),
    source: sanitizeText(cand.source || 'snapshot', 24),
    maskedEmail: sanitizeText(cand.maskedEmail || '', 120),
    label: sanitizeText(cand.label || '', 40),
    tierName: sanitizeText(cand.tierName || '', 64),
    weeklyPercent: typeof cand.weeklyPercent === 'number' && Number.isFinite(cand.weeklyPercent) ? cand.weeklyPercent : null,
    fiveHourPercent:
      typeof cand.fiveHourPercent === 'number' && Number.isFinite(cand.fiveHourPercent) ? cand.fiveHourPercent : null,
  };
}

function normalizeAlertSnapshot(snapshot) {
  const settings = normalizeGuardSettings(snapshot.settings);
  const triggeredBuckets = Array.isArray(snapshot.triggeredBuckets)
    ? snapshot.triggeredBuckets.filter((b) => b === 'gemini-weekly' || b === 'gemini-5h')
    : [];
  const triggered = Boolean(snapshot.triggered && triggeredBuckets.length);
  const level = triggered ? (snapshot.level === 'soft' ? 'soft' : 'hard') : 'ok';
  const thresholdPercent = clampInt(snapshot.thresholdPercent, 1, 50, settings.thresholdPercent);
  const hardFloorPercent = clampInt(snapshot.hardFloorPercent, 1, 50, thresholdPercent);
  return {
    v: 1,
    updatedAt: typeof snapshot.updatedAt === 'string' && Number.isFinite(Date.parse(snapshot.updatedAt)) ? snapshot.updatedAt : '',
    activeAccountId: typeof snapshot.activeAccountId === 'string' ? snapshot.activeAccountId : '',
    activeMaskedEmail: sanitizeText(snapshot.activeMaskedEmail || '', 120),
    activeTierName: sanitizeText(snapshot.activeTierName || '', 64),
    triggered,
    level,
    triggeredBuckets,
    weeklyPercent: Number.isFinite(snapshot.weeklyPercent) ? snapshot.weeklyPercent : null,
    fiveHourPercent: Number.isFinite(snapshot.fiveHourPercent) ? snapshot.fiveHourPercent : null,
    thresholdPercent,
    softThresholdPercent: clampInt(snapshot.softThresholdPercent, hardFloorPercent, 65, Math.max(hardFloorPercent, thresholdPercent)),
    hardFloorPercent,
    settings,
    bestCandidate: sanitizeCandidateSnapshot(snapshot.bestCandidate),
  };
}

export function writeQuotaAlertSnapshot(paths, snapshot = {}) {
  if (!paths?.quotaAlertPath) throw new Error('MISSING_QUOTA_ALERT_PATH');
  const payload = normalizeAlertSnapshot(snapshot);
  if (!payload.updatedAt) payload.updatedAt = new Date().toISOString();
  atomicWriteFile(paths.quotaAlertPath, JSON.stringify(payload, null, 2) + '\n', 0o600);
  return payload;
}

export function readQuotaAlertSnapshot(paths) {
  const parsed = readSafeJsonFile(paths?.quotaAlertPath, MAX_GUARD_JSON_BYTES);
  return parsed?.v === 1 ? normalizeAlertSnapshot(parsed) : null;
}

export function readQuotaRefreshTrigger(paths) {
  const trigger = readSafeJsonFile(paths.quotaTriggerPath, MAX_GUARD_JSON_BYTES);
  return trigger?.v === 1 && typeof trigger.requestedAt === 'string' && Number.isFinite(Date.parse(trigger.requestedAt))
    ? trigger : null;
}

export function writeQuotaRefreshTrigger(paths, {
  event = 'PostInvocation', conversationId = '', minIntervalMs = 60_000, nowMs = Date.now(),
} = {}) {
  const previous = readQuotaRefreshTrigger(paths);
  if (previous && nowMs - Date.parse(previous.requestedAt) < minIntervalMs) {
    return { written: false, throttled: true };
  }
  const trigger = {
    v: 1,
    event: sanitizeText(event, 64),
    conversationId: sanitizeText(conversationId, 128),
    requestedAt: new Date(nowMs).toISOString(),
  };
  atomicWriteFile(paths.quotaTriggerPath, JSON.stringify(trigger) + '\n', 0o600);
  return { written: true, throttled: false };
}

function defaultIsPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function resolveAppDataRoot(env = process.env, appDataDir = '') {
  if (appDataDir) return resolve(appDataDir);
  if (env?.ANTIGRAVITY_APP_DATA_DIR) return resolve(env.ANTIGRAVITY_APP_DATA_DIR);
  const geminiDir = resolve(env?.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini'));
  return join(geminiDir, 'antigravity');
}

export function snapshotDaemonHubPids(env = process.env, { appDataDir = '' } = {}) {
  const daemonDir = join(resolveAppDataRoot(env, appDataDir), 'daemon');
  const pids = new Set();
  let names;
  try {
    names = readdirSync(daemonDir);
  } catch {
    return pids;
  }
  for (const name of names) {
    if (!/^hub_\d+\.json$/.test(name)) continue;
    const obj = readSafeJsonFile(join(daemonDir, name), MAX_HUB_JSON_BYTES);
    const pid = Number(obj?.pid);
    if (Number.isSafeInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return pids;
}

export async function discoverLiveHub(
  env = process.env,
  { appDataDir = '', excludePids = [], rpcFn = callLsRpc, timeoutMs = 1500, isPidAliveFn = defaultIsPidAlive } = {}
) {
  const directAddr = String(env?.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const directCsrf = String(env?.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (directAddr && directCsrf && directAddr !== 'test.invalid') {
    const directRes = await rpcFn(env, 'GetUserStatus', { timeoutMs }).catch(() => null);
    if (directRes && typeof directRes === 'object') {
      return {
        lsAddress: directAddr,
        csrfToken: directCsrf,
        pid: 0,
        lsVersion: String(env?.ANTIGRAVITY_LS_VERSION || ''),
        userStatus: directRes.userStatus || null,
      };
    }
  }

  const daemonDir = join(resolveAppDataRoot(env, appDataDir), 'daemon');
  let names;
  try {
    names = readdirSync(daemonDir);
  } catch {
    return null;
  }

  const excludeSet = new Set(
    (Array.isArray(excludePids) ? excludePids : [...(excludePids || [])])
      .map((n) => Number(n))
      .filter((n) => Number.isSafeInteger(n) && n > 0)
  );

  const hubFiles = [];
  for (const name of names) {
    if (!/^hub_\d+\.json$/.test(name)) continue;
    const fullPath = join(daemonDir, name);
    try {
      const st = lstatSync(fullPath);
      if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_HUB_JSON_BYTES) continue;
      hubFiles.push({ fullPath, mtimeMs: st.mtimeMs });
    } catch {
      // Ignore vanished hub files
    }
  }

  hubFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const entry of hubFiles) {
    let data;
    try {
      data = JSON.parse(readFileSync(entry.fullPath, 'utf8'));
    } catch {
      continue;
    }
    const pid = Number(data?.pid);
    const csrfToken = typeof data?.csrfToken === 'string' ? data.csrfToken.trim() : '';
    const httpPort = Number(data?.httpPort);
    const httpsPort = Number(data?.httpsPort);
    if (!Number.isSafeInteger(pid) || pid <= 0 || excludeSet.has(pid) || !csrfToken) {
      continue;
    }
    if (!isPidAliveFn(pid)) {
      continue;
    }

    const candidates = [];
    if (Number.isSafeInteger(httpPort) && httpPort > 0 && httpPort <= 65535) {
      candidates.push(`http://127.0.0.1:${httpPort}`);
    }
    if (Number.isSafeInteger(httpsPort) && httpsPort > 0 && httpsPort <= 65535) {
      candidates.push(`https://127.0.0.1:${httpsPort}`);
    }

    for (const lsAddress of candidates) {
      const probeEnv = {
        ...env,
        ANTIGRAVITY_LS_ADDRESS: lsAddress,
        ANTIGRAVITY_CSRF_TOKEN: csrfToken,
      };
      const res = await rpcFn(probeEnv, 'GetUserStatus', { timeoutMs }).catch(() => null);
      if (res && typeof res === 'object') {
        return {
          lsAddress,
          csrfToken,
          pid,
          lsVersion: typeof data.lsVersion === 'string' ? data.lsVersion : '',
          userStatus: res.userStatus || null,
        };
      }
    }
  }

  return null;
}
