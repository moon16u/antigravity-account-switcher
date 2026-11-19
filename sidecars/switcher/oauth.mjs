import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { extractBinaryOAuthClients, extractElfOAuthClients } from './binary-oauth.mjs';
import { openExternalBrowserUrl, resolveLanguageServerCandidates } from './platform.mjs';
import { appendSwitchLog, assertNotSymlink, importAccount, normalizeLabel } from './vault.mjs';

export { extractBinaryOAuthClients, extractElfOAuthClients };

export const OAUTH_SCOPES = Object.freeze([
  'openid',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]);

const ALLOWED_OAUTH_HOSTS = new Set([
  'oauth2.googleapis.com',
  'www.googleapis.com',
  'daily-cloudcode-pa.googleapis.com',
  'cloudcode-pa.googleapis.com',
]);
const MAX_HTTP_BODY_BYTES = 256 * 1024;

const CALLBACK_HEADERS = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
});

const STATIC_SUCCESS_HTML =
  '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>授权成功</title></head>' +
  '<body><h2>授权成功</h2><p>新账号已加密保存至 Antigravity 账号切换面板，您现在可以关闭此浏览器标签页。</p></body></html>';

const STATIC_BAD_STATE_HTML =
  '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>状态校验失败</title></head>' +
  '<body><h2>请求校验失败</h2><p>OAuth state 无效或已过期，请返回插件面板重新发起授权。</p></body></html>';

const STATIC_ERROR_HTML =
  '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>授权未完成</title></head>' +
  '<body><h2>授权未完成</h2><p>Google 登录未完成或被取消，请关闭此页面后在插件面板重试。</p></body></html>';

const STATIC_EXCHANGE_ERROR_HTML =
  '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>凭证换取失败</title></head>' +
  '<body><h2>凭证换取失败</h2><p>Google 账号授权已完成，但插件换取登录凭证失败。请关闭此页面并查看插件面板的错误提示与最近日志。</p></body></html>';

const PROXY_ENV_KEYS = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);

let cachedClientsKey = '';
let cachedClients = [];

export function loadNativeOAuthClients(env = process.env) {
  const candidates = resolveLanguageServerCandidates(env);
  for (const binPath of candidates) {
    try {
      if (!assertNotSymlink(binPath)) continue;
      if (cachedClientsKey === binPath && cachedClients.length > 0) {
        return cachedClients;
      }
      const buf = readFileSync(binPath);
      const clients = extractBinaryOAuthClients(buf);
      if (clients.length > 0) {
        cachedClientsKey = binPath;
        cachedClients = clients;
        return clients;
      }
    } catch {
      // Try next candidate
    }
  }
  return [];
}

function buildProxyEnv(env) {
  const proxyEnv = {};
  if (!env || typeof env !== 'object') return proxyEnv;
  for (const key of PROXY_ENV_KEYS) {
    if (typeof env[key] === 'string') {
      proxyEnv[key] = env[key];
    }
  }
  return proxyEnv;
}

export function supportsNativeProxyEnv(nodeVersion = process.versions.node) {
  const parts = String(nodeVersion || '').split('.').map(Number);
  const major = parts[0] || 0;
  const minor = parts[1] || 0;
  return major > 24 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);
}

function matchesNoProxy(hostname, noProxyEnv) {
  if (!noProxyEnv) return false;
  const host = hostname.toLowerCase();
  const entries = String(noProxyEnv)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const pattern of entries) {
    if (pattern === '*') return true;
    const clean = pattern.replace(/^\*\.?/, '.');
    if (host === pattern || (clean.startsWith('.') && host.endsWith(clean))) {
      return true;
    }
  }
  return false;
}

function resolveProxyUrl(env, targetHost) {
  const noProxy = env?.NO_PROXY || env?.no_proxy || '';
  if (matchesNoProxy(targetHost, noProxy)) return null;
  const raw = env?.HTTPS_PROXY || env?.https_proxy || env?.HTTP_PROXY || env?.http_proxy || '';
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:') return null;
    return parsed;
  } catch {
    return null;
  }
}

class ProxyConnectAgent extends https.Agent {
  constructor(env, opts = {}) {
    super(opts);
    this._env = env;
    this._activeConnectReqs = new Set();
  }

  destroy() {
    for (const creq of this._activeConnectReqs) {
      try {
        creq.destroy();
      } catch {
        // Ignore cleanup failure
      }
    }
    this._activeConnectReqs.clear();
    super.destroy();
  }

  createConnection(options, callback) {
    const targetHost = options.hostname || options.host || '';
    const targetPort = Number(options.port) || 443;
    const proxyUrl = resolveProxyUrl(this._env, targetHost);

    let called = false;
    const done = (err, sock) => {
      if (called) return;
      called = true;
      if (typeof callback === 'function') {
        callback(err, sock);
      }
    };

    if (!proxyUrl) {
      const directSocket = tls.connect({
        host: targetHost,
        port: targetPort,
        servername: options.servername || targetHost,
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
      });
      directSocket.once('secureConnect', () => done(null, directSocket));
      directSocket.once('error', (err) => done(err));
      return directSocket;
    }

    const headers = { Host: `${targetHost}:${targetPort}` };
    if (proxyUrl.username || proxyUrl.password) {
      const auth = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(auth, 'utf8').toString('base64')}`;
    }

    const proxyHost = proxyUrl.hostname.replace(/^\[|\]$/g, '');
    const proxyPort = Number(proxyUrl.port) || 80;
    const connectReq = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers,
      agent: false,
      createConnection: () => net.connect({ host: proxyHost, port: proxyPort }),
    });
    this._activeConnectReqs.add(connectReq);

    connectReq.once('connect', (res, rawSocket) => {
      this._activeConnectReqs.delete(connectReq);
      if (res.statusCode !== 200) {
        rawSocket.destroy();
        const err = new Error('OAUTH_PROXY_CONNECT_FAILED');
        err.code = 'OAUTH_PROXY_CONNECT_FAILED';
        done(err);
        return;
      }
      const tlsSocket = tls.connect({
        socket: rawSocket,
        servername: options.servername || targetHost,
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
      });
      tlsSocket.once('secureConnect', () => done(null, tlsSocket));
      tlsSocket.once('error', (err) => {
        tlsSocket.destroy();
        done(err);
      });
    });

    connectReq.once('error', (err) => {
      this._activeConnectReqs.delete(connectReq);
      done(err);
    });
    connectReq.end();
    return undefined;
  }
}

export async function httpsJsonRequest(
  urlStr,
  { method = 'GET', headers = {}, body = '', timeoutMs = 15_000, forceLegacyProxy = false } = {},
  env = process.env
) {
  const parsed = new URL(urlStr);
  if (parsed.protocol !== 'https:' || !ALLOWED_OAUTH_HOSTS.has(parsed.hostname)) {
    throw new Error('DISALLOWED_OAUTH_HOST');
  }
  const targetPort = Number(parsed.port) || 443;
  const upperMethod = String(method || 'GET').toUpperCase();
  const bodyStr = typeof body === 'string' ? body : '';
  const reqHeaders = { ...headers };
  if (bodyStr || (upperMethod !== 'GET' && upperMethod !== 'HEAD')) {
    reqHeaders['Content-Length'] = String(Buffer.byteLength(bodyStr, 'utf8'));
  }

  const agent =
    !forceLegacyProxy && supportsNativeProxyEnv()
      ? new https.Agent({
          proxyEnv: buildProxyEnv(env),
          keepAlive: false,
          minVersion: 'TLSv1.2',
          rejectUnauthorized: true,
        })
      : new ProxyConnectAgent(env, {
          keepAlive: false,
          minVersion: 'TLSv1.2',
          rejectUnauthorized: true,
        });

  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        agent.destroy();
      } catch {
        // Ignore agent destroy error
      }
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      const err = new Error('OAUTH_HTTP_TIMEOUT');
      err.code = 'OAUTH_HTTP_TIMEOUT';
      try {
        req?.destroy(err);
      } catch {
        // Ignore destroy error
      }
      finish(err);
    }, timeoutMs);
    timer.unref?.();

    req = https.request(
      {
        hostname: parsed.hostname,
        port: targetPort,
        path: `${parsed.pathname}${parsed.search}`,
        method: upperMethod,
        headers: reqHeaders,
        agent,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total <= MAX_HTTP_BODY_BYTES) {
            chunks.push(chunk);
          }
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          finish(null, { status: res.statusCode || 0, json });
        });
        res.on('error', (err) => finish(err));
      }
    );

    req.on('timeout', () => {
      const err = new Error('OAUTH_HTTP_TIMEOUT');
      err.code = 'OAUTH_HTTP_TIMEOUT';
      req.destroy(err);
    });
    req.on('error', (err) => {
      if (err?.code === 'ERR_PROXY_TUNNEL') {
        const wrapped = new Error('OAUTH_PROXY_CONNECT_FAILED');
        wrapped.code = 'OAUTH_PROXY_CONNECT_FAILED';
        finish(wrapped);
        return;
      }
      finish(err);
    });
    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

export function openExternalBrowser(authUrl, env = process.env) {
  return openExternalBrowserUrl(authUrl, env);
}

function sanitizeOAuthErrorToken(val) {
  if (typeof val !== 'string') return '';
  return /^[A-Za-z0-9_.-]{1,48}$/.test(val) ? val : '';
}

function makeOAuthStageError(message, { stage = '', httpStatus = 0, oauthError = '' } = {}) {
  const err = new Error(message);
  err.code = message;
  err.stage = stage;
  err.httpStatus = httpStatus;
  err.oauthError = sanitizeOAuthErrorToken(oauthError);
  return err;
}

function mapOAuthUserMessage(safeCode, oauthErr) {
  if (safeCode === 'MISSING_REFRESH_TOKEN') {
    return '未获取到 refresh_token，请重试或先在 Google 账号安全设置中撤销旧授权。';
  }
  if (safeCode === 'OAUTH_UNVERIFIED_EMAIL') {
    return '该 Google 账号邮箱未验证，无法添加。';
  }
  if (oauthErr === 'invalid_client') {
    return 'Google 拒绝了 OAuth 客户端凭据（invalid_client），请确认本机 Antigravity 版本或更新插件。';
  }
  if (oauthErr === 'redirect_uri_mismatch') {
    return 'OAuth 回调地址不匹配（redirect_uri_mismatch），请重试。';
  }
  if (oauthErr === 'invalid_grant') {
    return '授权码已失效或已被使用（invalid_grant），请重新发起授权。';
  }
  if (
    safeCode === 'OAUTH_HTTP_TIMEOUT' ||
    safeCode === 'OAUTH_PROXY_CONNECT_FAILED' ||
    safeCode === 'ERR_PROXY_TUNNEL' ||
    safeCode === 'ECONNREFUSED' ||
    safeCode === 'ETIMEDOUT'
  ) {
    return '通过本机代理连接 Google 超时或失败，请确认代理（HTTPS_PROXY）运行正常后重试。';
  }
  return '换取登录凭证失败（详见「最近切换日志」错误码），请重试。';
}

function sendStaticHtml(res, status, html) {
  res.writeHead(status, CALLBACK_HEADERS);
  res.end(html);
}

export function createOAuthManager({
  paths,
  env = process.env,
  loadClients = loadNativeOAuthClients,
  requestFn = httpsJsonRequest,
  openBrowser = openExternalBrowser,
  fetchProfile = null,
  ttlMs = 300_000,
} = {}) {
  let session = {
    status: 'idle',
    sessionId: '',
    label: '',
    authUrl: '',
    state: '',
    codeVerifier: '',
    redirectUri: '',
    clientId: '',
    clientSecret: '',
    expiresAt: '',
    maskedEmail: '',
    error: '',
    server: null,
    timer: null,
  };

  function cleanupSessionHandle() {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    if (session.server) {
      const srv = session.server;
      session.server = null;
      try {
        srv.closeAllConnections?.();
        srv.close();
      } catch {
        // Ignore close error
      }
    }
  }

  function clearSecretsFromSession() {
    session.state = '';
    session.codeVerifier = '';
    session.clientSecret = '';
  }

  function publicStatus() {
    return {
      status: session.status,
      sessionId: session.sessionId,
      authUrl: session.status === 'pending' ? session.authUrl : '',
      expiresAt: session.expiresAt,
      maskedEmail: session.maskedEmail,
      label: session.label,
      error: session.error,
    };
  }

  async function handleCallback(req, res, mySessionId) {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Method Not Allowed');
      return;
    }
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    if (reqUrl.pathname !== '/auth/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Not Found');
      return;
    }

    if (session.sessionId !== mySessionId || session.status !== 'pending') {
      sendStaticHtml(res, 400, STATIC_BAD_STATE_HTML);
      return;
    }

    const providedState = reqUrl.searchParams.get('state') || '';
    const expectedBuf = Buffer.from(session.state, 'utf8');
    const providedBuf = Buffer.from(providedState, 'utf8');
    if (
      expectedBuf.length === 0 ||
      providedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(providedBuf, expectedBuf)
    ) {
      sendStaticHtml(res, 400, STATIC_BAD_STATE_HTML);
      return;
    }

    const oauthError = reqUrl.searchParams.get('error');
    if (oauthError) {
      session.status = 'failed';
      session.error = 'Google 授权已取消或被拒绝。';
      clearSecretsFromSession();
      cleanupSessionHandle();
      sendStaticHtml(res, 400, STATIC_ERROR_HTML);
      return;
    }

    const code = reqUrl.searchParams.get('code') || '';
    if (!code) {
      session.status = 'failed';
      session.error = '未收到有效授权码。';
      clearSecretsFromSession();
      cleanupSessionHandle();
      sendStaticHtml(res, 400, STATIC_ERROR_HTML);
      return;
    }

    // Consume single-use OAuth state and tear down the listener immediately after sending reply.
    const { clientId, clientSecret, codeVerifier, redirectUri, label } = session;
    session.status = 'exchanging';
    clearSecretsFromSession();
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    const srv = session.server;
    session.server = null;
    if (srv) {
      try {
        srv.close();
      } catch {
        // Ignore
      }
    }

    let currentStage = 'token';
    try {
      const tokenBody = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString();

      const tokenRes = await requestFn(
        'https://oauth2.googleapis.com/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenBody,
        },
        env
      );

      const tok = tokenRes?.json;
      if (tokenRes?.status < 200 || tokenRes?.status >= 300 || !tok?.access_token) {
        throw makeOAuthStageError('OAUTH_EXCHANGE_FAILED', {
          stage: 'token',
          httpStatus: tokenRes?.status || 0,
          oauthError: tok?.error,
        });
      }
      if (typeof tok.refresh_token !== 'string' || !tok.refresh_token.trim()) {
        throw makeOAuthStageError('MISSING_REFRESH_TOKEN', {
          stage: 'token',
          httpStatus: tokenRes?.status || 0,
        });
      }
      if (!Number.isFinite(tok.expires_in) || tok.expires_in <= 0) {
        throw makeOAuthStageError('OAUTH_EXCHANGE_FAILED', {
          stage: 'token',
          httpStatus: tokenRes?.status || 0,
        });
      }

      currentStage = 'userinfo';
      const userRes = await requestFn(
        'https://www.googleapis.com/oauth2/v2/userinfo',
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${tok.access_token}` },
        },
        env
      );

      const user = userRes?.json;
      if (userRes?.status < 200 || userRes?.status >= 300 || !user?.email) {
        throw makeOAuthStageError('OAUTH_USERINFO_FAILED', {
          stage: 'userinfo',
          httpStatus: userRes?.status || 0,
          oauthError: user?.error?.status || user?.error,
        });
      }
      if (user.verified_email === false) {
        throw makeOAuthStageError('OAUTH_UNVERIFIED_EMAIL', {
          stage: 'userinfo',
          httpStatus: userRes?.status || 0,
        });
      }

      currentStage = 'vault';
      let tierName = '';
      let projectId = '';
      if (typeof fetchProfile === 'function') {
        try {
          const prof = await fetchProfile(tok.access_token);
          if (prof && typeof prof === 'object') {
            tierName = typeof prof.tierName === 'string' ? prof.tierName : '';
            projectId = typeof prof.projectId === 'string' ? prof.projectId : '';
          }
        } catch {
          // Best-effort tier enrichment; never block OAuth completion
        }
      }

      const expiryIso = new Date(Date.now() + tok.expires_in * 1000).toISOString();
      const credentialPayload = {
        token: {
          access_token: tok.access_token,
          refresh_token: tok.refresh_token,
          token_type: 'Bearer',
          expiry: expiryIso,
          expires_in: tok.expires_in,
        },
        auth_method: 'consumer',
        id_token_email: user.email,
      };
      if (typeof tok.id_token === 'string' && tok.id_token) {
        credentialPayload.id_token = tok.id_token;
      }

      const saved = importAccount(paths, {
        credentialText: JSON.stringify(credentialPayload),
        label,
        emailOverride: user.email,
        tierName,
        projectId,
      });

      if (session.sessionId === mySessionId) {
        session.status = 'succeeded';
        session.maskedEmail = saved.maskedEmail;
        session.label = saved.label;
        session.authUrl = '';
        session.error = '';
      }

      sendStaticHtml(res, 200, STATIC_SUCCESS_HTML);
    } catch (err) {
      if (session.sessionId === mySessionId) {
        session.status = 'failed';
        session.authUrl = '';
        const stage = sanitizeOAuthErrorToken(err?.stage) || currentStage;
        const safeCode = sanitizeOAuthErrorToken(err?.code || err?.message) || 'UNKNOWN';
        const status = Number.isInteger(err?.httpStatus) && err.httpStatus > 0 ? err.httpStatus : 0;
        const oauthErr = sanitizeOAuthErrorToken(err?.oauthError) || 'none';
        const diagLine = `OAUTH_ERR stage=${stage} code=${safeCode} status=${status} oauth_error=${oauthErr}`;
        console.error(`[switcher] ${diagLine}`);
        try {
          appendSwitchLog(paths, diagLine);
        } catch {
          // Ignore logging failure
        }
        session.error = mapOAuthUserMessage(safeCode, oauthErr);
      }
      sendStaticHtml(res, 500, STATIC_EXCHANGE_ERROR_HTML);
    } finally {
      if (srv) {
        setTimeout(() => {
          try {
            srv.closeAllConnections?.();
          } catch {
            // Ignore
          }
        }, 200).unref?.();
      }
    }
  }

  async function start({ label = '' } = {}) {
    cleanupSessionHandle();
    clearSecretsFromSession();

    const clients = await loadClients(env);
    if (!Array.isArray(clients) || clients.length === 0) {
      throw new Error('OAUTH_CLIENT_UNAVAILABLE');
    }
    const client = clients[0];
    const mySessionId = randomUUID();
    const state = randomBytes(32).toString('hex');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const normLabel = normalizeLabel(label);

    const server = http.createServer((req, res) => {
      void handleCallback(req, res, mySessionId);
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;
    if (!port) {
      server.close();
      throw new Error('OAUTH_LISTEN_FAILED');
    }

    const redirectUri = `http://localhost:${port}/auth/callback`;
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', client.id);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', OAUTH_SCOPES.join(' '));
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'select_account consent');
    u.searchParams.set('include_granted_scopes', 'true');
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    const authUrl = u.toString();

    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const timer = setTimeout(() => {
      if (session.sessionId === mySessionId && session.status === 'pending') {
        session.status = 'expired';
        session.error = '浏览器授权已超时（5 分钟），请重新发起。';
        session.authUrl = '';
        clearSecretsFromSession();
        cleanupSessionHandle();
      }
    }, ttlMs);
    timer.unref?.();

    session = {
      status: 'pending',
      sessionId: mySessionId,
      label: normLabel,
      authUrl,
      state,
      codeVerifier,
      redirectUri,
      clientId: client.id,
      clientSecret: client.secret,
      expiresAt,
      maskedEmail: '',
      error: '',
      server,
      timer,
    };

    const browserRes = await Promise.resolve(openBrowser(authUrl, env)).catch(() => ({ opened: false }));
    return {
      ...publicStatus(),
      browserOpened: Boolean(browserRes?.opened),
    };
  }

  function getStatus() {
    return publicStatus();
  }

  function cancel() {
    cleanupSessionHandle();
    clearSecretsFromSession();
    session = {
      status: 'idle',
      sessionId: '',
      label: '',
      authUrl: '',
      state: '',
      codeVerifier: '',
      redirectUri: '',
      clientId: '',
      clientSecret: '',
      expiresAt: '',
      maskedEmail: '',
      error: '',
      server: null,
      timer: null,
    };
    return publicStatus();
  }

  function dispose() {
    cleanupSessionHandle();
    clearSecretsFromSession();
  }

  return {
    start,
    getStatus,
    cancel,
    dispose,
  };
}
