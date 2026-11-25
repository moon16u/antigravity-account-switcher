import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertInsideDir,
  assertNotSymlink,
  atomicWriteFile,
  ensureSecureDir,
  MAX_CREDENTIAL_BYTES,
  readActiveTokenRaw,
  safeChmod,
} from './token-store.mjs';

export { assertInsideDir, assertNotSymlink, atomicWriteFile, ensureSecureDir, safeChmod };

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LOG_BYTES = 256 * 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function resolvePaths(env = process.env, overrides = {}) {
  const geminiDir = resolve(overrides.geminiDir || env?.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini'));
  const tokenPath = resolve(overrides.tokenPath || join(geminiDir, 'jetski-standalone-oauth-token'));
  const appDataDir = resolve(env?.ANTIGRAVITY_APP_DATA_DIR || join(geminiDir, 'antigravity'));
  const sidecarDataDir = join(appDataDir, 'sidecar_data', 'antigravity-account-switcher', 'switcher', 'data');

  let resolvedDataDir = '';
  if (overrides.dataDir) {
    resolvedDataDir = resolve(overrides.dataDir);
  } else if (env?.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    resolvedDataDir = resolve(env.ANTIGRAVITY_EXECUTABLE_DATA_DIR);
  } else {
    try {
      const st = lstatSync(sidecarDataDir);
      if (!st.isSymbolicLink() && st.isDirectory()) {
        resolvedDataDir = resolve(sidecarDataDir);
      }
    } catch {
      // Ignore missing sidecar_data directory and fall back
    }
    if (!resolvedDataDir) {
      resolvedDataDir = resolve(env?.PLUGIN_DATA || join(appDataDir, 'plugin_data', 'antigravity-account-switcher'));
    }
  }

  const dataDir = resolvedDataDir;
  const keyPath = assertInsideDir(dataDir, join(dataDir, 'vault.key'));
  const vaultPath = assertInsideDir(dataDir, join(dataDir, 'vault.enc.json'));
  const backupPath = assertInsideDir(dataDir, join(dataDir, 'last-token.enc.json'));
  const jobsDir = assertInsideDir(dataDir, join(dataDir, 'jobs'));
  const logPath = assertInsideDir(dataDir, join(dataDir, 'switch.log'));
  const settingsPath = assertInsideDir(dataDir, join(dataDir, 'settings.json'));
  const quotaAlertPath = assertInsideDir(dataDir, join(dataDir, 'quota-alert.json'));
  const hookStatePath = assertInsideDir(dataDir, join(dataDir, 'hook-alert-state.json'));
  const useKeyring = !(
    Boolean(overrides.tokenPath) ||
    Boolean(overrides.geminiDir) ||
    Boolean(env?.ANTIGRAVITY_GEMINI_DIR) ||
    env?.SWITCHER_TOKEN_STORE === 'file'
  );

  return {
    geminiDir,
    appDataDir,
    tokenPath,
    dataDir,
    keyPath,
    vaultPath,
    backupPath,
    jobsDir,
    logPath,
    settingsPath,
    quotaAlertPath,
    hookStatePath,
    useKeyring,
  };
}

function parseKeyHex(text) {
  const hex = String(text || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('INVALID_KEY_FILE');
  }
  return Buffer.from(hex, 'hex');
}

export function getOrCreateKey(paths) {
  ensureSecureDir(paths.dataDir);
  if (assertNotSymlink(paths.keyPath)) {
    return parseKeyHex(readFileSync(paths.keyPath, 'utf8'));
  }
  // TODO(security): Local single-user desktop plugin stores its 256-bit AES-GCM key in a mode-0600 file under user home instead of a remote KMS.
  const key = randomBytes(32);
  try {
    writeFileSync(paths.keyPath, key.toString('hex') + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    safeChmod(paths.keyPath, 0o600);
    return key;
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      assertNotSymlink(paths.keyPath);
      return parseKeyHex(readFileSync(paths.keyPath, 'utf8'));
    }
    throw err;
  }
}

export function encryptPayload(obj, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('INVALID_CIPHER_KEY');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64'),
  };
}

export function decryptPayload(envelope, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('INVALID_CIPHER_KEY');
  }
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    envelope.v !== 1 ||
    envelope.alg !== 'aes-256-gcm' ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.tag !== 'string' ||
    typeof envelope.data !== 'string'
  ) {
    throw new Error('INVALID_ENCRYPTED_ENVELOPE');
  }
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ciphertext = Buffer.from(envelope.data, 'base64');
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error('INVALID_ENCRYPTED_ENVELOPE');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

export function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return '';
  }
  return email;
}

export function maskEmail(email) {
  const norm = normalizeEmail(email);
  if (!norm) return '';
  const atIdx = norm.indexOf('@');
  const local = norm.slice(0, atIdx);
  const domain = norm.slice(atIdx + 1);
  const prefix = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${prefix}***@${domain}`;
}

export function normalizeLabel(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 40);
}

export function normalizeTierName(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
}

export function normalizeProjectId(value) {
  if (typeof value !== 'string') return '';
  if (/[\x00-\x1f\x7f\s]/.test(value.trim())) return '';
  const cleaned = value.trim().slice(0, 128);
  if (!cleaned || cleaned.includes('..')) return '';
  return /^[A-Za-z0-9._:/-]+$/.test(cleaned) ? cleaned : '';
}

function decodeJwtEmailUnsafe(idToken) {
  if (typeof idToken !== 'string') return '';
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[1]) return '';
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (parts[1].length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return normalizeEmail(payload?.email);
  } catch {
    return '';
  }
}

function safeCopyPrimitives(src) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    }
  }
  return out;
}

function resolveExpiryString(srcToken) {
  if (typeof srcToken.expiry === 'string' && srcToken.expiry.trim()) {
    const parsed = Date.parse(srcToken.expiry);
    if (Number.isFinite(parsed)) return srcToken.expiry.trim();
  }
  const numericTs =
    typeof srcToken.expiry_date === 'number'
      ? srcToken.expiry_date
      : typeof srcToken.expiry_timestamp === 'number'
        ? srcToken.expiry_timestamp * 1000
        : NaN;
  if (Number.isSafeInteger(numericTs) && numericTs > 0 && numericTs <= 253402300799999) {
    return new Date(numericTs).toISOString();
  }
  return '1970-01-01T00:00:00.000Z';
}

export function parseAndValidateTokenRaw(rawText, { fallbackEmail = '' } = {}) {
  if (typeof rawText !== 'string') {
    throw new Error('INVALID_CREDENTIAL');
  }
  const trimmed = rawText.trim();
  if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > MAX_CREDENTIAL_BYTES) {
    throw new Error('INVALID_CREDENTIAL');
  }
  let source;
  try {
    source = JSON.parse(trimmed);
  } catch {
    throw new Error('INVALID_CREDENTIAL');
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('INVALID_CREDENTIAL');
  }
  if (source.auth_method !== undefined && source.auth_method !== 'consumer') {
    throw new Error('INVALID_AUTH_METHOD');
  }

  const hasNestedToken = Boolean(source.token && typeof source.token === 'object' && !Array.isArray(source.token));
  const srcToken = hasNestedToken ? source.token : source;

  const refreshToken = typeof srcToken.refresh_token === 'string' ? srcToken.refresh_token.trim() : '';
  if (!refreshToken || /\s/.test(refreshToken) || refreshToken.length < 10 || refreshToken.length > 4096) {
    throw new Error('INVALID_CREDENTIAL');
  }
  if (srcToken.token_type !== undefined && (typeof srcToken.token_type !== 'string' || !/^bearer$/i.test(srcToken.token_type))) {
    throw new Error('INVALID_CREDENTIAL');
  }

  const accessToken = typeof srcToken.access_token === 'string' ? srcToken.access_token : '';
  const expiry = resolveExpiryString(srcToken);

  const email =
    normalizeEmail(source.id_token_email) ||
    normalizeEmail(source.email) ||
    decodeJwtEmailUnsafe(source.id_token || srcToken.id_token) ||
    normalizeEmail(fallbackEmail);

  let normalizedObj;
  if (hasNestedToken) {
    normalizedObj = safeCopyPrimitives(source);
    const tokenCopy = safeCopyPrimitives(srcToken);
    tokenCopy.access_token = accessToken;
    tokenCopy.refresh_token = refreshToken;
    tokenCopy.token_type = typeof srcToken.token_type === 'string' && srcToken.token_type ? srcToken.token_type : 'Bearer';
    tokenCopy.expiry = expiry;
    normalizedObj.token = tokenCopy;
    normalizedObj.auth_method = 'consumer';
    if (email && !normalizedObj.id_token_email) {
      normalizedObj.id_token_email = email;
    }
  } else {
    normalizedObj = {
      token: {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expiry,
      },
      auth_method: 'consumer',
    };
    if (email) {
      normalizedObj.id_token_email = email;
    }
    if (typeof source.id_token === 'string' && source.id_token) {
      normalizedObj.id_token = source.id_token;
    }
    if (typeof source.writer_id === 'string' && source.writer_id) {
      normalizedObj.writer_id = source.writer_id;
    }
  }

  return {
    rawJson: JSON.stringify(normalizedObj),
    email,
    expiry,
    hasRefreshToken: true,
    authMethod: 'consumer',
  };
}

export function readActiveToken(paths, env = process.env, opts = {}) {
  const storeRes = readActiveTokenRaw(paths, env, opts);
  if (!storeRes.present) {
    return {
      present: false,
      valid: false,
      source: 'none',
      email: '',
      maskedEmail: '',
      expiry: '',
      hasRefreshToken: false,
      rawJson: '',
    };
  }
  if (storeRes.oversize || !storeRes.raw) {
    return {
      present: true,
      valid: false,
      source: storeRes.source || 'none',
      email: '',
      maskedEmail: '',
      expiry: '',
      hasRefreshToken: false,
      rawJson: '',
    };
  }
  try {
    const parsed = parseAndValidateTokenRaw(storeRes.raw);
    return {
      present: true,
      valid: true,
      source: storeRes.source || 'none',
      email: parsed.email,
      maskedEmail: maskEmail(parsed.email),
      expiry: parsed.expiry,
      hasRefreshToken: parsed.hasRefreshToken,
      rawJson: parsed.rawJson,
    };
  } catch {
    return {
      present: true,
      valid: false,
      source: storeRes.source || 'none',
      email: '',
      maskedEmail: '',
      expiry: '',
      hasRefreshToken: false,
      rawJson: '',
    };
  }
}

export function sanitizeActiveState(active, lsUser, { revealEmail = false } = {}) {
  const lsEmail = lsUser?.lsConnected ? normalizeEmail(lsUser?.email) : '';
  const fileEmail = normalizeEmail(active.email);
  const fileMismatch = Boolean(lsEmail && fileEmail && lsEmail !== fileEmail);
  const email = lsEmail || fileEmail;
  return {
    present: fileMismatch ? false : Boolean(active.present),
    valid: fileMismatch ? false : Boolean(active.valid),
    source: fileMismatch ? 'keyring' : active.source || 'none',
    email: revealEmail ? email : '',
    maskedEmail: maskEmail(email),
    expiry: fileMismatch ? '' : active.expiry || '',
    hasRefreshToken: fileMismatch ? false : Boolean(active.hasRefreshToken),
    tierName: typeof lsUser?.tierName === 'string' ? lsUser.tierName : '',
    lsConnected: Boolean(lsUser?.lsConnected),
  };
}

export function loadVault(paths) {
  if (!assertNotSymlink(paths.vaultPath)) {
    return { version: 1, accounts: [] };
  }
  const key = getOrCreateKey(paths);
  const envelope = JSON.parse(readFileSync(paths.vaultPath, 'utf8'));
  const vault = decryptPayload(envelope, key);
  if (!vault || vault.version !== 1 || !Array.isArray(vault.accounts)) {
    throw new Error('CORRUPT_VAULT');
  }
  return {
    version: 1,
    accounts: vault.accounts.map((acc) => ({
      id: String(acc.id || ''),
      email: normalizeEmail(acc.email),
      label: normalizeLabel(acc.label),
      tierName: normalizeTierName(acc.tierName),
      projectId: normalizeProjectId(acc.projectId),
      tokenRaw: typeof acc.tokenRaw === 'string' ? acc.tokenRaw : '',
      createdAt: String(acc.createdAt || ''),
      updatedAt: String(acc.updatedAt || ''),
      lastUsedAt: String(acc.lastUsedAt || ''),
    })),
  };
}

export function saveVault(paths, vault) {
  ensureSecureDir(paths.dataDir);
  const key = getOrCreateKey(paths);
  const envelope = encryptPayload({ version: 1, accounts: vault.accounts }, key);
  atomicWriteFile(paths.vaultPath, JSON.stringify(envelope, null, 2) + '\n', 0o600);
}

export function listPublicAccounts(paths, activeEmail, { revealEmails = false, activeTierName = '' } = {}) {
  const vault = loadVault(paths);
  const normActive = normalizeEmail(activeEmail);
  const normActiveTier = normalizeTierName(activeTierName);
  const mapped = vault.accounts.map((acc) => {
    const isActive = Boolean(normActive && acc.email === normActive);
    const tierName = isActive && normActiveTier ? normActiveTier : normalizeTierName(acc.tierName);
    return {
      id: acc.id,
      email: revealEmails ? acc.email : '',
      maskedEmail: maskEmail(acc.email),
      label: acc.label,
      tierName,
      updatedAt: acc.updatedAt,
      lastUsedAt: acc.lastUsedAt,
      isActive,
    };
  });
  return mapped.sort((a, b) => (a.isActive === b.isActive ? 0 : a.isActive ? -1 : 1));
}

function upsertAccountInVault(
  vault,
  { email, label, tokenRaw, nowIso, preserveLabelIfEmpty = true, tierName = '', projectId = '' }
) {
  const normEmail = normalizeEmail(email);
  if (!normEmail) {
    throw new Error('MISSING_ACCOUNT_EMAIL');
  }
  const normLabel = normalizeLabel(label);
  const normTier = normalizeTierName(tierName);
  const normProjectId = normalizeProjectId(projectId);
  const existing = vault.accounts.find((a) => a.email === normEmail);
  if (existing) {
    existing.tokenRaw = tokenRaw;
    if (normLabel || !preserveLabelIfEmpty) {
      existing.label = normLabel;
    }
    if (normTier) {
      existing.tierName = normTier;
    }
    if (normProjectId) {
      existing.projectId = normProjectId;
    }
    existing.updatedAt = nowIso;
    existing.lastUsedAt = nowIso;
    return existing;
  }
  const created = {
    id: randomUUID(),
    email: normEmail,
    label: normLabel,
    tierName: normTier,
    projectId: normProjectId,
    tokenRaw,
    createdAt: nowIso,
    updatedAt: nowIso,
    lastUsedAt: nowIso,
  };
  vault.accounts.push(created);
  return created;
}

export function syncActiveAccountTier(paths, { email, tierName } = {}) {
  const normEmail = normalizeEmail(email);
  const normTier = normalizeTierName(tierName);
  if (!normEmail || !normTier || !assertNotSymlink(paths.vaultPath)) {
    return false;
  }
  const vault = loadVault(paths);
  const existing = vault.accounts.find((a) => a.email === normEmail);
  if (!existing || existing.tierName === normTier) {
    return false;
  }
  existing.tierName = normTier;
  saveVault(paths, vault);
  return true;
}

export function updateAccountSyncFields(paths, updates = []) {
  if (!Array.isArray(updates) || updates.length === 0 || !assertNotSymlink(paths.vaultPath)) {
    return 0;
  }
  const vault = loadVault(paths);
  let updatedCount = 0;

  for (const u of updates) {
    if (!u || typeof u !== 'object' || typeof u.id !== 'string' || !UUID_RE.test(u.id)) {
      continue;
    }
    const existing = vault.accounts.find((a) => a.id === u.id);
    if (!existing) continue;

    let dirty = false;
    if (u.tierName !== undefined) {
      const normTier = normalizeTierName(u.tierName);
      if (normTier && existing.tierName !== normTier) {
        existing.tierName = normTier;
        dirty = true;
      }
    }
    if (u.projectId !== undefined) {
      const normProj = normalizeProjectId(u.projectId);
      if (normProj && existing.projectId !== normProj) {
        existing.projectId = normProj;
        dirty = true;
      }
    }
    if (typeof u.tokenRaw === 'string' && u.tokenRaw.trim()) {
      try {
        const parsed = parseAndValidateTokenRaw(u.tokenRaw, { fallbackEmail: existing.email });
        if (parsed.rawJson && existing.tokenRaw !== parsed.rawJson) {
          existing.tokenRaw = parsed.rawJson;
          dirty = true;
        }
      } catch {
        // Ignore invalid token update payloads
      }
    }

    if (dirty) {
      updatedCount += 1;
    }
  }

  if (updatedCount > 0) {
    saveVault(paths, vault);
  }
  return updatedCount;
}

export function captureCurrentAccount(
  paths,
  { label = '', fallbackEmail = '', tierName = '', projectId = '', env = process.env, tokenStoreOpts = {} } = {}
) {
  const activeRaw = readActiveTokenRaw(paths, env, { bypassCache: true, ...tokenStoreOpts });
  if (!activeRaw.present) {
    throw new Error('NO_ACTIVE_CREDENTIAL');
  }
  if (activeRaw.oversize || !activeRaw.raw) {
    throw new Error('INVALID_CREDENTIAL');
  }
  const parsed = parseAndValidateTokenRaw(activeRaw.raw, { fallbackEmail });
  if (!parsed.email) {
    throw new Error('MISSING_ACCOUNT_EMAIL');
  }
  const vault = loadVault(paths);
  const nowIso = new Date().toISOString();
  const entry = upsertAccountInVault(vault, {
    email: parsed.email,
    label,
    tokenRaw: parsed.rawJson,
    nowIso,
    preserveLabelIfEmpty: true,
    tierName,
    projectId,
  });
  saveVault(paths, vault);
  return {
    id: entry.id,
    maskedEmail: maskEmail(entry.email),
    label: entry.label,
  };
}

export function importAccount(paths, { credentialText, label = '', emailOverride = '', tierName = '', projectId = '' } = {}) {
  const parsed = parseAndValidateTokenRaw(credentialText, { fallbackEmail: emailOverride });
  if (!parsed.email) {
    throw new Error('MISSING_ACCOUNT_EMAIL');
  }
  const vault = loadVault(paths);
  const nowIso = new Date().toISOString();
  const entry = upsertAccountInVault(vault, {
    email: parsed.email,
    label,
    tokenRaw: parsed.rawJson,
    nowIso,
    preserveLabelIfEmpty: true,
    tierName,
    projectId,
  });
  saveVault(paths, vault);
  return {
    id: entry.id,
    maskedEmail: maskEmail(entry.email),
    label: entry.label,
  };
}

export function renameAccount(paths, { id, label }) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new Error('INVALID_ACCOUNT_ID');
  }
  const normLabel = normalizeLabel(label);
  const vault = loadVault(paths);
  const entry = vault.accounts.find((a) => a.id === id);
  if (!entry) {
    throw new Error('ACCOUNT_NOT_FOUND');
  }
  entry.label = normLabel;
  entry.updatedAt = new Date().toISOString();
  saveVault(paths, vault);
  return {
    id: entry.id,
    maskedEmail: maskEmail(entry.email),
    label: entry.label,
  };
}

export function removeAccount(paths, { id }) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new Error('INVALID_ACCOUNT_ID');
  }
  const vault = loadVault(paths);
  const next = vault.accounts.filter((a) => a.id !== id);
  if (next.length === vault.accounts.length) {
    throw new Error('ACCOUNT_NOT_FOUND');
  }
  vault.accounts = next;
  saveVault(paths, vault);
  return { removed: true };
}

function formatAutoBackupLabel(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `自动备份 (${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())})`;
}

export const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

function clampMs(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function prepareSwitchJob(
  paths,
  {
    mode,
    accountId = '',
    fallbackEmail = '',
    env = process.env,
    tokenStoreOpts = {},
    context = null,
    delayMs = 0,
    resume = null,
    waitConversationIdle = null,
  } = {}
) {
  if (mode !== 'switch' && mode !== 'new-login') {
    throw new Error('INVALID_SWITCH_MODE');
  }
  if (mode === 'switch' && (typeof accountId !== 'string' || !UUID_RE.test(accountId))) {
    throw new Error('INVALID_ACCOUNT_ID');
  }

  ensureSecureDir(paths.dataDir);
  ensureSecureDir(paths.jobsDir);
  const key = getOrCreateKey(paths);
  const vault = loadVault(paths);
  const now = new Date();
  const nowIso = now.toISOString();

  // Back up and synchronize the current token before replacing or removing it.
  const activeRaw = readActiveTokenRaw(paths, env, { bypassCache: true, ...tokenStoreOpts });
  if (activeRaw.present && !activeRaw.oversize && activeRaw.raw) {
    const currentRaw = activeRaw.raw;
    const backupEnv = encryptPayload({ v: 1, backedUpAt: nowIso, rawText: currentRaw }, key);
    atomicWriteFile(paths.backupPath, JSON.stringify(backupEnv, null, 2) + '\n', 0o600);

    try {
      const parsed = parseAndValidateTokenRaw(currentRaw, { fallbackEmail });
      if (parsed.email) {
        const existing = vault.accounts.find((a) => a.email === parsed.email);
        if (existing) {
          existing.tokenRaw = parsed.rawJson;
          existing.updatedAt = nowIso;
        } else {
          vault.accounts.push({
            id: randomUUID(),
            email: parsed.email,
            label: formatAutoBackupLabel(now),
            tokenRaw: parsed.rawJson,
            createdAt: nowIso,
            updatedAt: nowIso,
            lastUsedAt: nowIso,
          });
        }
      }
    } catch {
      // Encrypted backup already saved above; do not block switch on corrupt active file.
    }
  }

  let targetEmail = '';
  let tokenRaw = '';
  if (mode === 'switch') {
    const target = vault.accounts.find((a) => a.id === accountId);
    if (!target) {
      throw new Error('ACCOUNT_NOT_FOUND');
    }
    const validatedTarget = parseAndValidateTokenRaw(target.tokenRaw, { fallbackEmail: target.email });
    target.lastUsedAt = nowIso;
    targetEmail = target.email;
    tokenRaw = validatedTarget.rawJson;
  }

  saveVault(paths, vault);

  let cleanContext = null;
  if (context && typeof context === 'object' && !Array.isArray(context)) {
    cleanContext = {};
    for (const k of ['appData', 'localAppData', 'relaunchExe', 'appStoragePath', 'geminiDir']) {
      if (typeof context[k] === 'string' && context[k].trim()) {
        cleanContext[k] = context[k].trim();
      }
    }
    if (Object.keys(cleanContext).length === 0) {
      cleanContext = null;
    }
  }

  const cleanDelayMs =
    typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs > 0
      ? Math.min(15_000, Math.round(delayMs))
      : 0;

  let cleanResume = null;
  if (resume && typeof resume === 'object' && !Array.isArray(resume)) {
    const cid = typeof resume.conversationId === 'string' ? resume.conversationId.trim() : '';
    if (CONVERSATION_ID_RE.test(cid)) {
      const msg =
        typeof resume.message === 'string'
          ? resume.message.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 500)
          : '';
      const agentApiExe =
        typeof resume.agentApiExe === 'string' ? resume.agentApiExe.trim().slice(0, 512) : '';
      cleanResume = {
        conversationId: cid,
        message: msg || '账号已切换完成，请继续刚才未完成的任务。',
        ...(agentApiExe ? { agentApiExe } : {}),
      };
    }
  }

  let cleanWaitConversationIdle = null;
  if (waitConversationIdle && typeof waitConversationIdle === 'object' && !Array.isArray(waitConversationIdle)) {
    const waitCid =
      typeof waitConversationIdle.conversationId === 'string' ? waitConversationIdle.conversationId.trim() : '';
    if (CONVERSATION_ID_RE.test(waitCid)) {
      cleanWaitConversationIdle = {
        conversationId: waitCid,
        minDelayMs: clampMs(waitConversationIdle.minDelayMs, 1500, 0, 15_000),
        maxWaitMs: clampMs(waitConversationIdle.maxWaitMs, 10_000, 1000, 20_000),
        fallbackDelayMs: clampMs(waitConversationIdle.fallbackDelayMs, 3000, 0, 15_000),
      };
    }
  }

  const jobId = randomUUID();
  const jobPath = assertInsideDir(paths.jobsDir, join(paths.jobsDir, `job-${jobId}.enc.json`));
  const jobPayload = {
    v: 1,
    mode,
    targetEmail,
    tokenRaw,
    createdAt: nowIso,
    ...(cleanDelayMs > 0 ? { delayMs: cleanDelayMs } : {}),
    ...(cleanResume ? { resume: cleanResume } : {}),
    ...(cleanWaitConversationIdle ? { waitConversationIdle: cleanWaitConversationIdle } : {}),
    ...(cleanContext ? { context: cleanContext } : {}),
  };
  const jobEnvelope = encryptPayload(jobPayload, key);
  atomicWriteFile(jobPath, JSON.stringify(jobEnvelope) + '\n', 0o600);

  return {
    jobPath,
    targetEmail,
    targetMaskedEmail: maskEmail(targetEmail),
  };
}

export function appendSwitchLog(paths, message) {
  ensureSecureDir(paths.dataDir);
  const safeMsg = String(message || '').replace(/[\r\n]+/g, ' ').slice(0, 500);
  const line = `[${new Date().toISOString()}] ${safeMsg}\n`;
  let existing = '';
  if (assertNotSymlink(paths.logPath)) {
    const st = lstatSync(paths.logPath);
    if (st.size > MAX_LOG_BYTES) {
      const prevLines = readFileSync(paths.logPath, 'utf8').split('\n').filter(Boolean).slice(-100);
      existing = prevLines.join('\n') + (prevLines.length ? '\n' : '');
      atomicWriteFile(paths.logPath, existing + line, 0o600);
      return;
    }
  }
  writeFileSync(paths.logPath, line, { encoding: 'utf8', mode: 0o600, flag: 'a' });
  safeChmod(paths.logPath, 0o600);
}

export function readRecentLogs(paths, maxLines = 30) {
  if (!assertNotSymlink(paths.logPath)) {
    return [];
  }
  const st = lstatSync(paths.logPath);
  if (st.size > MAX_LOG_BYTES * 2) {
    return [];
  }
  const lines = readFileSync(paths.logPath, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-Math.max(1, Math.min(200, maxLines)));
}
