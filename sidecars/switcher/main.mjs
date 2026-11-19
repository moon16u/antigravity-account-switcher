import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { callLsRpc, detectActiveWork } from './active-work.mjs';
import { createCloudCodeService } from './cloudcode.mjs';
import { createOAuthManager } from './oauth.mjs';
import { resolveWindowsDirs, spawnDetachedWorker } from './platform.mjs';
import {
  appendSwitchLog,
  captureCurrentAccount,
  listPublicAccounts,
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
  INVALID_ACCOUNT_ID: '账号标识无效。',
  ACCOUNT_NOT_FOUND: '未找到对应的已保存账号，请刷新列表。',
  UNSAFE_FILE_TYPE: '检测到不安全的符号链接或非常规文件，已拒绝操作。',
  UNSAFE_DIR_TYPE: '检测到不安全的符号链接目录，已拒绝操作。',
  PATH_OUTSIDE_BOUNDARY: '路径越界，已拒绝操作。',
  INVALID_ENCRYPTED_ENVELOPE: '密钥库格式校验失败，请检查数据目录完整性。',
  CORRUPT_VAULT: '密钥库已损坏或无法解密。',
  INVALID_KEY_FILE: '密钥文件损坏，无法解锁账号库。',
  OAUTH_CLIENT_UNAVAILABLE: '未能从本机 Antigravity 解析到 OAuth 客户端配置。',
  OAUTH_LISTEN_FAILED: '本地 OAuth 回调监听端口启动失败。',
  MISSING_REFRESH_TOKEN: 'Google 未返回 refresh_token，请重试授权。',
  OAUTH_EXCHANGE_FAILED: '向 Google 换取登录令牌失败，请确认本机代理可访问 Google。',
  OAUTH_USERINFO_FAILED: '获取 Google 账号邮箱失败，请检查代理连通性。',
  OAUTH_UNVERIFIED_EMAIL: '该 Google 账号邮箱未验证，无法导入。',
  DISALLOWED_OAUTH_HOST: '拒绝访问非授权的远端主机。',
  TOKEN_REFRESH_REVOKED: '该账号授权已失效，请重新「+ 添加账号」或切号登录。',
  TOKEN_REFRESH_FAILED: '刷新该账号 OAuth 令牌失败，请检查代理连通性后重试。',
  USAGE_FETCH_FAILED: '获取用量失败，请确认代理可访问 Google 后重试。',
  USAGE_UNAVAILABLE: '该账号暂未返回用量配额数据。',
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
  return function allow() {
    const now = Date.now();
    while (hits.length > 0 && now - hits[0] >= windowMs) {
      hits.shift();
    }
    if (hits.length >= maxRequests) {
      return false;
    }
    hits.push(now);
    return true;
  };
}

export async function fetchLsUserStatus(env = process.env) {
  const parsed = await callLsRpc(env, 'GetUserStatus', { timeoutMs: 2000 });
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
  const oauthOpts = options.oauthOptions || {};
  const cloudCode =
    options.cloudCodeService ||
    createCloudCodeService({
      paths,
      env,
      ...(oauthOpts.loadClients ? { loadClients: oauthOpts.loadClients } : {}),
      ...(oauthOpts.requestFn ? { requestFn: oauthOpts.requestFn } : {}),
      ...(options.callLsRpc ? { callLsRpcFn: options.callLsRpc } : {}),
      ...(options.cloudCodeOptions || {}),
    });
  const oauthManager = createOAuthManager({
    paths,
    env,
    fetchProfile: (accessToken) => cloudCode.fetchProfileForAccessToken(accessToken),
    ...oauthOpts,
  });
  const getUserStatus = options.getUserStatus || (() => fetchLsUserStatus(env));
  const checkActiveWork = options.detectActiveWork || (() => detectActiveWork(env));
  const spawnWorker =
    options.spawnWorker ||
    ((jobPath, dataDir = paths.dataDir) =>
      spawnDetachedWorker(WORKER_SCRIPT, jobPath, env, undefined, { dataDir }));
  const readLimit = createRateLimiter(options.readLimit ?? 60, 60_000);
  const writeLimit = createRateLimiter(options.writeLimit ?? 10, 60_000);
  const remoteLimit = createRateLimiter(options.remoteLimit ?? 30, 60_000);
  const switchLockMs = options.switchLockMs ?? 15_000;
  let switchInProgress = false;

  function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
      status,
      contentType: 'application/json; charset=utf-8',
      headers: SECURITY_HEADERS,
    });
  }

  function assetResponse(fileName, contentType) {
    const body = readFileSync(join(PUBLIC_DIR, fileName), 'utf8');
    return new Response(body, {
      status: 200,
      contentType,
      headers: SECURITY_HEADERS,
    });
  }

  function mapError(err) {
    const code = err?.message || 'UNKNOWN';
    if (ERROR_MESSAGES[code]) {
      return { status: 400, error: ERROR_MESSAGES[code] };
    }
    console.error(`[switcher] internal error code=${code}`);
    return { status: 500, error: '操作失败，请检查本地日志或稍后重试。' };
  }

  function requireSecurityGate(limiter) {
    if (!uiToken) {
      return jsonResponse({ error: '未检测到安全访问令牌，操作已拒绝。' }, 403);
    }
    if (!limiter()) {
      return jsonResponse({ error: '请求过于频繁，请稍后再试。' }, 429);
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
    return {
      ok: true,
      active: sanitizeActiveState(active, lsUser, { revealEmail: revealEmails }),
      accounts: listPublicAccounts(paths, effectiveActiveEmail, { revealEmails, activeTierName }),
      logs: readRecentLogs(paths, 30),
      switching: switchInProgress,
    };
  }

  app.page('/', () => assetResponse('index.html', 'text/html; charset=utf-8'));
  app.api('/styles.css', () => assetResponse('styles.css', 'text/css; charset=utf-8'), 'GET');
  app.api('/app.js', () => assetResponse('app.js', 'application/javascript; charset=utf-8'), 'GET');

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
    '/api/accounts/sync-tiers',
    async (data) => {
      const blocked = requireSecurityGate(remoteLimit);
      if (blocked) return blocked;
      try {
        const sync = await cloudCode.syncAccountTiers({ onlyMissing: Boolean(data?.onlyMissing) });
        const state = await buildStatePayload({ revealEmails: Boolean(data?.revealEmails) });
        return jsonResponse({ ...state, sync });
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
      const blocked = requireSecurityGate(remoteLimit);
      if (blocked) return blocked;
      try {
        const active = readActiveToken(paths, env);
        const lsUser = await getUserStatus();
        const effectiveActiveEmail = normalizeEmail((lsUser.lsConnected ? lsUser.email : '') || active.email);
        const result = await cloudCode.fetchAccountUsage({
          id: data?.id,
          activeEmail: effectiveActiveEmail,
          lsConnected: Boolean(lsUser.lsConnected),
          forceRefresh: Boolean(data?.forceRefresh),
        });
        return jsonResponse({
          ok: true,
          id: result.id,
          usage: result.usage,
          tierName: result.tierName,
        });
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
        cloudCode.invalidateCache?.(data?.id);
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
    if (!force) {
      const activeWork = await checkActiveWork();
      if (activeWork?.busy) {
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
    switchInProgress = true;
    try {
      const lsUser = await getUserStatus();
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
      });
      await spawnWorker(job.jobPath, paths.dataDir);
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
            ? `正在关闭桌面应用并切换到 ${job.targetMaskedEmail}，窗口将在数秒后自动重开…`
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
    '/api/oauth/start',
    async (data) => {
      const blocked = requireSecurityGate(writeLimit);
      if (blocked) return blocked;
      try {
        const oauth = await oauthManager.start({
          label: typeof data?.label === 'string' ? data.label : '',
        });
        return jsonResponse({ ok: true, oauth });
      } catch (err) {
        const mapped = mapError(err);
        return jsonResponse({ error: mapped.error }, mapped.status);
      }
    },
    'POST'
  );

  app.api(
    '/api/oauth/status',
    async (data) => {
      const blocked = requireSecurityGate(readLimit);
      if (blocked) return blocked;
      try {
        const oauth = oauthManager.getStatus();
        if (oauth.status === 'succeeded' || oauth.status === 'failed' || oauth.status === 'expired') {
          const state = await buildStatePayload({ revealEmails: Boolean(data?.revealEmails) });
          return jsonResponse({ ...state, oauth });
        }
        return jsonResponse({ ok: true, oauth });
      } catch (err) {
        const mapped = mapError(err);
        return jsonResponse({ error: mapped.error }, mapped.status);
      }
    },
    'POST'
  );

  app.api(
    '/api/oauth/cancel',
    async () => {
      const blocked = requireSecurityGate(writeLimit);
      if (blocked) return blocked;
      try {
        const oauth = oauthManager.cancel();
        return jsonResponse({ ok: true, oauth });
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
    start: () => app.run(),
    close: async () => {
      oauthManager.dispose();
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
