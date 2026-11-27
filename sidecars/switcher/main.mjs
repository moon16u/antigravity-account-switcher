import { readFileSync, realpathSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { callLsRpc, detectActiveWork } from './active-work.mjs';
import { createQuotaService, deleteQuotaSnapshot, normalizeQuotaSummary } from './quota-snapshots.mjs';
import { resolveWindowsDirs, spawnDetachedWorker } from './platform.mjs';
import {
  computeNaturalPauseMs,
  computeSessionThresholds,
  evaluateQuotaAlert,
  loadGuardSettings,
  pickBestBackupAccount,
  readQuotaAlertSnapshot,
  readQuotaRefreshTrigger,
  saveGuardSettings,
  writeQuotaAlertSnapshot,
} from './quota-guard.mjs';
import {
  appendSwitchLog,
  captureCurrentAccount,
  ensureSecureDir,
  listPublicAccounts,
  maskEmail,
  normalizeEmail,
  prepareSwitchJob,
  readActiveToken,
  readRecentLogs,
  removeAccount,
  renameAccount,
  resolvePaths,
  sanitizeActiveState,
  syncActiveAccountTier,
} from './vault.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const WORKER_SCRIPT = join(__dirname, 'switcher-worker.mjs');

// TODO(security): X-Frame-Options: DENY and frame-ancestors 'self' are intentionally omitted because Antigravity 2.0 hosts the sidecar web UI inside a cross-origin plugin:// auxiliary pane iframe; CSP restricts scripts, styles, objects, forms, and base-uri strictly.
export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});

const ERROR_MESSAGES = Object.freeze({
  INVALID_CREDENTIAL: '凭证格式无效，请提供包含 refresh_token 的 Antigravity OAuth JSON。',
  INVALID_AUTH_METHOD: '仅支持个人版（consumer）OAuth 凭证。',
  MISSING_ACCOUNT_EMAIL: '未能识别该凭证所属邮箱，请重试。',
  NO_ACTIVE_CREDENTIAL: '当前未检测到有效的本机登录凭证。',
  WINDOWS_KEYRING_READ_BLOCKED: '未能读取 Windows 凭据管理器中的当前登录态（可能被安全软件拦截），请放行读取或安装 Python 后重试。',
  INVALID_ACCOUNT_ID: '账号标识无效。',
  ACCOUNT_NOT_FOUND: '未找到对应的已保存账号，请刷新列表。',
  UNSAFE_FILE_TYPE: '检测到不安全的符号链接或非常规文件，已拒绝操作。',
  UNSAFE_DIR_TYPE: '检测到不安全的符号链接目录，已拒绝操作。',
  PATH_OUTSIDE_BOUNDARY: '路径越界，已拒绝操作。',
  INVALID_ENCRYPTED_ENVELOPE: '密钥库格式校验失败，请检查数据目录完整性。',
  CORRUPT_VAULT: '密钥库已损坏或无法解密。',
  INVALID_KEY_FILE: '密钥文件损坏，无法解锁账号库。',
});

async function loadSidecarSdk() {
  try {
    return await import('sidecar_sdk');
  } catch {
    const appData = process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity');
    const fallback = join(appData, 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs');
    return await import(pathToFileURL(fallback).href);
  }
}

function createRateLimiter(maxRequests, windowMs) {
  const hits = [];
  return function check() {
    const now = Date.now();
    while (hits.length > 0 && now - hits[0] >= windowMs) {
      hits.shift();
    }
    if (hits.length >= maxRequests) {
      const retryMs = Math.max(1000, (hits[0] ?? now) + windowMs - now);
      const retryAfterSec = Math.max(1, Math.ceil(retryMs / 1000));
      return { allowed: false, retryAfterSec };
    }
    hits.push(now);
    return { allowed: true, retryAfterSec: 0 };
  };
}

export async function fetchLsUserStatus(env = process.env, callLsRpcFn = callLsRpc) {
  const parsed = await callLsRpcFn(env, 'GetUserStatus', { timeoutMs: 2000 });
  if (!parsed) {
    return { lsConnected: false, email: '', tierName: '' };
  }
  const us = parsed?.userStatus;
  const email = normalizeEmail(us?.email);
  const tierName = typeof us?.userTier?.name === 'string' ? us.userTier.name : '';
  return { lsConnected: true, email, tierName };
}

export async function createApp(options = {}) {
  const { SidecarApp, Response } = options.sidecarSdk || (await loadSidecarSdk());
  const env = { ...process.env, ...(options.env || {}) };
  if (options.uiToken !== undefined) {
    env.ANTIGRAVITY_SIDECAR_UI_TOKEN = options.uiToken;
  }
  if (options.port !== undefined) {
    env.ANTIGRAVITY_SIDECAR_WEB_PORT = String(options.port);
  }
  if (options.lsAddress !== undefined) {
    env.ANTIGRAVITY_LS_ADDRESS = options.lsAddress;
  }
  if (options.csrfToken !== undefined) {
    env.ANTIGRAVITY_CSRF_TOKEN = options.csrfToken;
  }

  const prevUiToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
  const prevPort = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
  const prevLsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const prevCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;

  let app;
  try {
    process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
    process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = env.ANTIGRAVITY_SIDECAR_WEB_PORT || '';
    process.env.ANTIGRAVITY_LS_ADDRESS = env.ANTIGRAVITY_LS_ADDRESS || '';
    process.env.ANTIGRAVITY_CSRF_TOKEN = env.ANTIGRAVITY_CSRF_TOKEN || '';
    app = new SidecarApp();
  } finally {
    if (prevUiToken === undefined) delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    else process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = prevUiToken;
    if (prevPort === undefined) delete process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
    else process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = prevPort;
    if (prevLsAddr === undefined) delete process.env.ANTIGRAVITY_LS_ADDRESS;
    else process.env.ANTIGRAVITY_LS_ADDRESS = prevLsAddr;
    if (prevCsrf === undefined) delete process.env.ANTIGRAVITY_CSRF_TOKEN;
    else process.env.ANTIGRAVITY_CSRF_TOKEN = prevCsrf;
  }

  const uiToken = String(env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '');
  const paths = resolvePaths(env, options.pathOverrides);
  const callLsRpcFn = options.callLsRpc || callLsRpc;
  const quotaService = options.quotaService || createQuotaService({ paths, env, callLsRpcFn });
  const getUserStatus = options.getUserStatus || (() => fetchLsUserStatus(env, callLsRpcFn));
  let stateIdentity = null;
  const checkActiveWork = options.detectActiveWork || (() => detectActiveWork(env));
  const spawnWorker =
    options.spawnWorker ||
    ((jobPath, dataDir = paths.dataDir) =>
      spawnDetachedWorker(WORKER_SCRIPT, jobPath, env, undefined, { dataDir }));
  const readLimit = createRateLimiter(options.readLimit ?? 60, 60_000);
  const writeLimit = createRateLimiter(options.writeLimit ?? 10, 60_000);
  const settingsLimit = createRateLimiter(options.settingsLimit ?? 25, 60_000);
  const usageLimit = createRateLimiter(options.usageLimit ?? options.remoteLimit ?? 30, 60_000);
  const switchLockMs = options.switchLockMs ?? 15_000;
  const minTriggerIntervalMs = options.triggerMinIntervalMs ?? 90_000;
  const sessionThresholdState = { key: '', thresholds: null };
  let switchInProgress = false;
  let pendingRefresh = Promise.resolve();
  let triggerWatcher = null;
  let triggerDebounce = null;

  function jsonResponse(payload, status = 200, headers = {}) {
    return new Response(JSON.stringify(payload), {
      status,
      contentType: 'application/json; charset=utf-8',
      headers: { ...SECURITY_HEADERS, ...headers },
    });
  }

  function assetResponse(fileName, contentType, encoding = 'utf8') {
    const filePath = join(PUBLIC_DIR, fileName);
    const body = encoding ? readFileSync(filePath, encoding) : readFileSync(filePath);
    return new Response(body, {
      status: 200,
      contentType,
      headers: SECURITY_HEADERS,
    });
  }

  function mapError(err) {
    const code = err?.message || 'UNKNOWN';
    if (Object.hasOwn(ERROR_MESSAGES, code)) {
      return { status: 400, error: ERROR_MESSAGES[code] };
    }
    console.error('[switcher] internal error');
    return { status: 500, error: '操作失败，请检查本地日志或稍后重试。' };
  }

  function requireSecurityGate(limiter, { scope = 'default' } = {}) {
    if (!uiToken) {
      return jsonResponse({ error: '未检测到安全访问令牌，操作已拒绝。' }, 403);
    }
    const { allowed, retryAfterSec } = limiter();
    if (!allowed) {
      return jsonResponse({
        code: 'RATE_LIMITED',
        retryAfterSec,
        error: scope === 'settings'
          ? `高级设置保护中，请 ${retryAfterSec} 秒后再试。`
          : `请求过于频繁，请 ${retryAfterSec} 秒后再试。`,
      }, 429, { 'Retry-After': String(retryAfterSec) });
    }
    return null;
  }

  async function buildStatePayload({ revealEmails = false } = {}) {
    const active = readActiveToken(paths, env);
    const lsUser = await getUserStatus();
    const effectiveActiveEmail = normalizeEmail((lsUser.lsConnected ? lsUser.email : '') || active.email);
    const activeTierName = lsUser.lsConnected ? lsUser.tierName : '';
    if (lsUser.lsConnected && lsUser.email && activeTierName) {
      try {
        syncActiveAccountTier(paths, { email: lsUser.email, tierName: activeTierName });
      } catch {
        // Best-effort tier persistence; do not fail state read
      }
    }
    const accounts = listPublicAccounts(paths, effectiveActiveEmail, { revealEmails, activeTierName });
    stateIdentity = { tokenEmail: active.email, activeId: accounts.find(a => a.isActive)?.id };
    return {
      ok: true,
      active: sanitizeActiveState(active, lsUser, { revealEmail: revealEmails }),
      accounts,
      logs: readRecentLogs(paths, 30),
      settings: loadGuardSettings(paths),
      quotaAlert: readQuotaAlertSnapshot(paths),
      switching: switchInProgress,
    };
  }

  function refreshQuotaAlertSnapshot({ forceRefresh = false, syncSource = 'manual' } = {}) {
    pendingRefresh = pendingRefresh.then(async () => {
      const lsUser = await getUserStatus();
      if (!lsUser.lsConnected) return readQuotaAlertSnapshot(paths);
      const activeEmail = normalizeEmail(lsUser.email) || readActiveToken(paths, env).email;
      const accounts = listPublicAccounts(paths, activeEmail, { activeTierName: lsUser.tierName });
      const activeAccount = accounts.find((acc) => acc.isActive);
      const activeAccountId = activeAccount?.id || '';
      const settings = loadGuardSettings(paths);
      const activeAccountKey = activeAccountId || activeEmail;
      const key = JSON.stringify([activeAccountKey, settings.thresholdPercent, settings.dynamicThresholdEnabled]);
      if (sessionThresholdState.key !== key) {
        sessionThresholdState.key = key;
        sessionThresholdState.thresholds = computeSessionThresholds(settings.thresholdPercent, {
          dynamicEnabled: settings.dynamicThresholdEnabled,
        });
      }

      let summary;
      if (activeAccount) {
        const live = await quotaService.fetchActiveQuota({
          accountId: activeAccountId, tierName: activeAccount.tierName, forceRefresh, syncSource,
        });
        summary = live?.usage;
      } else {
        const raw = await callLsRpcFn(env, 'RetrieveUserQuotaSummary', {
          timeoutMs: 2500, body: forceRefresh ? { forceRefresh: true } : {},
        });
        summary = normalizeQuotaSummary(raw);
      }
      if (!summary?.groups.length) return readQuotaAlertSnapshot(paths);

      const alert = evaluateQuotaAlert(summary, settings, { sessionThresholds: sessionThresholdState.thresholds });
      let bestCandidate = null;
      if (alert.triggered) {
        const usageById = quotaService.buildProjectedUsageMap(accounts, { activeAccountId, activeUsage: summary });
        bestCandidate = pickBestBackupAccount(accounts, usageById, {
          activeAccountId, activeEmail, thresholdPercent: settings.thresholdPercent,
        });
      }
      return writeQuotaAlertSnapshot(paths, {
        activeAccountId,
        activeMaskedEmail: maskEmail(activeEmail),
        activeTierName: lsUser.tierName || activeAccount?.tierName || '',
        ...alert,
        settings,
        bestCandidate,
      });
    }).catch(() => {
      console.error('[switcher] quota alert refresh failed');
      return readQuotaAlertSnapshot(paths);
    });
    return pendingRefresh;
  }

  if (options.watchTriggers !== false) {
    try {
      ensureSecureDir(paths.dataDir);
      let lastRequestedAt = readQuotaRefreshTrigger(paths)?.requestedAt || '';
      let lastRefreshMs = -Infinity;
      triggerWatcher = watch(paths.dataDir, { persistent: false }, (_event, filename) => {
        if (filename && filename !== 'quota-refresh-trigger.json') return;
        clearTimeout(triggerDebounce);
        triggerDebounce = setTimeout(() => {
          const requestedAt = readQuotaRefreshTrigger(paths)?.requestedAt;
          if (!requestedAt || requestedAt === lastRequestedAt) return;
          lastRequestedAt = requestedAt;
          const nowMs = Date.now();
          if (nowMs - lastRefreshMs < minTriggerIntervalMs) return;
          lastRefreshMs = nowMs;
          void refreshQuotaAlertSnapshot({ forceRefresh: false, syncSource: 'hook_trigger' });
        }, 200);
        triggerDebounce.unref();
      });
      triggerWatcher.on('error', () => triggerWatcher.close());
    } catch {
      // Manual refresh remains available when the data directory cannot be watched.
    }
  }

  app.page('/', () => assetResponse('index.html', 'text/html; charset=utf-8'));
  app.api('/styles.css', () => assetResponse('styles.css', 'text/css; charset=utf-8'), 'GET');
  app.api('/app.js', () => assetResponse('app.js', 'application/javascript; charset=utf-8'), 'GET');
  app.api('/fonts/GoogleSans-Latin.woff2', () => assetResponse('fonts/GoogleSans-Latin.woff2', 'font/woff2', null), 'GET');

  app.api(
    '/api/state',
    async (data) => {
      const blocked = requireSecurityGate(readLimit);
      if (blocked) return blocked;
      try {
        return jsonResponse(await buildStatePayload({ revealEmails: Boolean(data?.revealEmails) }));
      } catch (err) {
        const mapped = mapError(err);
        return jsonResponse({ error: mapped.error }, mapped.status);
      }
    },
    'POST'
  );

  app.api(
    '/api/accounts/capture',
    async (data) => {
      const blocked = requireSecurityGate(writeLimit);
      if (blocked) return blocked;
      try {
        const lsUser = await getUserStatus();
        const saved = captureCurrentAccount(paths, {
          label: typeof data?.label === 'string' ? data.label : '',
          fallbackEmail: lsUser.email,
          tierName: lsUser.lsConnected ? lsUser.tierName : '',
          env,
        });
        if (lsUser.lsConnected) {
          try {
            // The credential file can still belong to the previous LS user.
            const activeEmail = normalizeEmail(lsUser.email) || readActiveToken(paths, env).email;
            if (listPublicAccounts(paths, activeEmail).some((acc) => acc.id === saved.id && acc.isActive)) {
              await quotaService.fetchActiveQuota({
                accountId: saved.id, tierName: lsUser.tierName, syncSource: 'capture', forceRefresh: true,
              });
            }
          } catch {
            // The account has already been saved.
          }
        }
        const state = await buildStatePayload({ revealEmails: Boolean(data?.revealEmails) });
        return jsonResponse({ ...state, message: `已保存当前账号（${saved.maskedEmail}）` });
      } catch (err) {
        const mapped = mapError(err);
        return jsonResponse({ error: mapped.error }, mapped.status);
      }
    },
    'POST'
  );

  app.api(
    '/api/accounts/usage',
    async (data) => {
      const blocked = requireSecurityGate(usageLimit);
      if (blocked) return blocked;
      try {
        // A known inactive account can be projected without probing the LS.
        // Recheck identity before attributing a live summary to any account.
        const active = readActiveToken(paths, env);
        const activeId = stateIdentity && stateIdentity.tokenEmail === active.email
          ? stateIdentity.activeId
          : active.email && listPublicAccounts(paths, active.email).find(a => a.isActive)?.id;
        const lsUser = activeId && activeId === data?.id ? await getUserStatus() : null;
        const effectiveActiveEmail = normalizeEmail((lsUser?.lsConnected ? lsUser.email : '') || active.email);
        const result = await quotaService.getAccountUsage({
          id: data?.id,
          activeEmail: effectiveActiveEmail,
          tierName: lsUser?.tierName,
          lsConnected: Boolean(lsUser?.lsConnected),
          forceRefresh: Boolean(data?.forceRefresh),
        });
        return jsonResponse({ ok: true, ...result });
      } catch (err) {
        const mapped = mapError(err);
        return jsonResponse({ error: mapped.error }, mapped.status);
      }
    },
    'POST'
  );

  app.api(
    '/api/accounts/rename',
    async (data) => {
      const blocked = requireSecurityGate(writeLimit);
      if (blocked) return blocked;
      try {
        renameAccount(paths, {
          id: data?.id,
          label: typeof data?.label === 'string' ? data.label : '',
        });
        const state = await buildStatePayload({ revealEmails: Boolean(data?.revealEmails) });
        return jsonResponse({ ...state, message: '已更新账号别名' });
      } catch (err) {
        const mapped = mapError(err);
        return jsonResponse({ error: mapped.error }, mapped.status);
      }
    },
    'POST'
  );

  app.api(
    '/api/accounts/remove',
    async (data) => {
      const blocked = requireSecurityGate(writeLimit);
      if (blocked) return blocked;
      try {
        removeAccount(paths, { id: data?.id });
        quotaService.invalidateCache();
        deleteQuotaSnapshot(paths, data?.id);
        const state = await buildStatePayload({ revealEmails: Boolean(data?.revealEmails) });
        return jsonResponse({ ...state, message: '已从本机密钥库移除该账号' });
      } catch (err) {
        const mapped = mapError(err);
        return jsonResponse({ error: mapped.error }, mapped.status);
      }
    },
    'POST'
  );

  async function triggerSwitch(mode, accountId, { force = false } = {}) {
    const blocked = requireSecurityGate(writeLimit);
    if (blocked) return blocked;
    if (switchInProgress) {
      return jsonResponse({ error: '正在执行切号流程，请等待窗口重启完成。' }, 409);
    }
    switchInProgress = true;
    try {
      if (!force) {
        const activeWork = await checkActiveWork();
        if (activeWork?.busy) {
          switchInProgress = false;
          return jsonResponse(
            {
              ok: false,
              code: 'ACTIVE_WORK_RUNNING',
              error: '检测到当前仍有对话或子进程正在运行，已暂停切换，请先结束后重试。',
              activeWork,
            },
            409
          );
        }
      } else {
        try {
          appendSwitchLog(paths, `FORCE_SWITCH_REQUESTED mode=${mode}`);
        } catch {
          // Ignore audit log error before switch
        }
      }
      const lsUser = await getUserStatus();
      if (lsUser.lsConnected) {
        try {
          const activeEmail = normalizeEmail(lsUser.email) || readActiveToken(paths, env).email;
          const activeAccount = listPublicAccounts(paths, activeEmail).find((acc) => acc.isActive);
          await quotaService.capturePreSwitchSnapshot({ accountId: activeAccount?.id || '', tierName: lsUser.tierName });
        } catch {
          // A failed quota capture must not block switching.
        }
      }
      const settings = loadGuardSettings(paths);
      const winDirs = resolveWindowsDirs(env);
      const jobContext = {
        ...(winDirs.appData ? { appData: winDirs.appData } : {}),
        ...(winDirs.localAppData ? { localAppData: winDirs.localAppData } : {}),
        ...(env.ANTIGRAVITY_SWITCHER_RELAUNCH_EXE
          ? { relaunchExe: String(env.ANTIGRAVITY_SWITCHER_RELAUNCH_EXE).trim() }
          : {}),
        ...(env.ANTIGRAVITY_APP_STORAGE_PATH
          ? { appStoragePath: String(env.ANTIGRAVITY_APP_STORAGE_PATH).trim() }
          : {}),
        ...(env.ANTIGRAVITY_GEMINI_DIR ? { geminiDir: String(env.ANTIGRAVITY_GEMINI_DIR).trim() } : {}),
      };
      const job = prepareSwitchJob(paths, {
        mode,
        accountId,
        fallbackEmail: lsUser.email,
        env,
        context: jobContext,
        syncOnboarding: Boolean(settings.skipOnboardingPrompt),
        relaunchPauseMs: computeNaturalPauseMs({ enabled: settings.naturalPauseEnabled }),
      });
      await spawnWorker(job.jobPath, paths.dataDir);
      stateIdentity = null;
      quotaService.invalidateCache();
      const timer = setTimeout(() => {
        switchInProgress = false;
      }, switchLockMs);
      timer.unref?.();

      return jsonResponse({
        ok: true,
        switching: true,
        targetMaskedEmail: job.targetMaskedEmail,
        message:
          mode === 'switch'
            ? `正在关闭桌面应用并切换到 ${job.targetMaskedEmail}，\n窗口将在数秒后自动重开…`
            : '已备份当前账号，正在重启以进入官方 Google 登录…',
      });
    } catch (err) {
      switchInProgress = false;
      const mapped = mapError(err);
      return jsonResponse({ error: mapped.error }, mapped.status);
    }
  }

  app.api('/api/accounts/switch', (data) => triggerSwitch('switch', data?.id, { force: Boolean(data?.force) }), 'POST');
  app.api('/api/accounts/new-login', (data) => triggerSwitch('new-login', '', { force: Boolean(data?.force) }), 'POST');

  app.api(
    '/api/settings/update',
    async (data) => {
      const blocked = requireSecurityGate(settingsLimit, { scope: 'settings' });
      if (blocked) return blocked;
      try {
        const nextSettings = saveGuardSettings(paths, data && typeof data === 'object' ? data : {});
        await refreshQuotaAlertSnapshot({ forceRefresh: false });
        const state = await buildStatePayload({ revealEmails: Boolean(data?.revealEmails) });
        return jsonResponse({
          ...state,
          settings: nextSettings,
          message: '已更新 Agent 守护与切号设置',
        });
      } catch (err) {
        const mapped = mapError(err);
        return jsonResponse({ error: mapped.error }, mapped.status);
      }
    },
    'POST'
  );

  return {
    app,
    paths,
    refreshQuotaAlert: refreshQuotaAlertSnapshot,
    start: () => app.run(),
    close: async () => {
      triggerWatcher?.close();
      clearTimeout(triggerDebounce);
      await pendingRefresh;
      await app.close();
    },
  };
}

function isEntryScript() {
  if (!process.argv[1]) return false;
  try {
    const resolvedUrl = pathToFileURL(realpathSync(process.argv[1])).href;
    if (process.platform === 'win32') {
      return import.meta.url.toLowerCase() === resolvedUrl.toLowerCase();
    }
    return import.meta.url === resolvedUrl;
  } catch {
    return false;
  }
}

if (isEntryScript()) {
  const srv = await createApp();
  await srv.start();
}
