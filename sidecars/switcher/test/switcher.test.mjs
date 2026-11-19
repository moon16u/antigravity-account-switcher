import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  extractActiveItemsFromLs,
  findUserChildProcesses,
  isInfrastructureProcess,
  parsePsOutput,
} from '../active-work.mjs';
import {
  extractBinaryOAuthClients,
  extractMachOOAuthClients,
  extractPeOAuthClients,
} from '../binary-oauth.mjs';
import {
  buildCloudCodeUserAgent,
  DEFAULT_CLOUD_CODE_ENDPOINT,
  ensureFreshAccessToken,
  extractCloudCodeProfile,
  FALLBACK_CLOUD_CODE_ENDPOINT,
  mapCloudCodePlatform,
  normalizeQuotaSummary,
  postCloudCodeJson,
  resolveAntigravityVersion,
} from '../cloudcode.mjs';
import { createApp } from '../main.mjs';
import {
  extractElfOAuthClients,
  httpsJsonRequest,
  loadNativeOAuthClients,
  supportsNativeProxyEnv,
} from '../oauth.mjs';
import {
  buildRelaunchEnv,
  detectRuntime,
  readRunInBackgroundSetting,
  resolveAppStoragePath,
  resolveLanguageServerCandidates,
  winPathToWslPath,
  wslPathToWinPath,
} from '../platform.mjs';
import {
  buildWindowsForceKillArgBatches,
  parseWindowsTasklistCsv,
  resolveWindowsTaskExecutables,
  runWorker,
  stopWindowsOrWslAntigravity,
} from '../switcher-worker.mjs';
import {
  clearWindowsKeyringEntry,
  decodeMacKeychainSecret,
  KEYRING_SERVICE,
  KEYRING_USER,
  readActiveTokenRaw,
  removeActiveTokenRaw,
  shouldClearWindowsKeyring,
  shouldUseOsKeyring,
  WIN_CRED_TARGET,
  WIN_CRED_TARGET_LEGACY,
  writeActiveTokenRaw,
} from '../token-store.mjs';
import {
  captureCurrentAccount,
  getOrCreateKey,
  importAccount,
  listPublicAccounts,
  loadVault,
  maskEmail,
  normalizeProjectId,
  prepareSwitchJob,
  readActiveToken,
  removeAccount,
  renameAccount,
  resolvePaths,
  sanitizeActiveState,
  syncActiveAccountTier,
  updateAccountSyncFields,
} from '../vault.mjs';

const execFileAsync = promisify(execFile);
const NODE_BIN = process.execPath;
const WORKER_PATH = fileURLToPath(new URL('../switcher-worker.mjs', import.meta.url));
const OAUTH_MOD_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../oauth.mjs')).href;

function makeSampleToken(email, refresh = '1//test-refresh-token-value-123456', access = 'ya29.test-access-token') {
  return JSON.stringify({
    token: {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expiry: '2026-12-01T00:00:00Z',
    },
    auth_method: 'consumer',
    id_token_email: email,
    writer_id: 'test-writer-1',
  });
}

function makeFakeJwt(email) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ email, sub: '12345' })).toString('base64url');
  return `${header}.${payload}.fakesig`;
}

const SYNTH_SECRET_PREFIX = ['GOC', 'SPX-'].join('');

function createFallbackSidecarSdk() {
  class Response {
    constructor(body, { contentType = 'text/plain', status = 200, headers } = {}) {
      this.body = body;
      this.contentType = contentType;
      this.status = status;
      this.headers = headers;
    }
  }

  class SidecarApp {
    #token;
    #port;
    #server;
    #pages = new Map();
    #apis = new Map();

    constructor() {
      const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
      const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
      const portStr = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
      if (!lsAddr || !csrf || !portStr) {
        throw new Error('Missing required environment variables');
      }
      this.#token = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
      this.#port = parseInt(portStr, 10);
    }

    page(path, handler) {
      this.#pages.set(path, handler);
    }

    api(path, handler, method = 'POST') {
      if (!this.#apis.has(path)) this.#apis.set(path, new Map());
      this.#apis.get(path).set(method.toUpperCase(), handler);
    }

    run() {
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://127.0.0.1:${this.#port}`);
        if (req.method !== 'GET' && this.#token) {
          const provided = req.headers['x-sidecar-token'] || url.searchParams.get('token');
          if (provided !== this.#token) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
          }
        }
        if (req.method === 'GET' && this.#pages.has(url.pathname)) {
          const out = await this.#pages.get(url.pathname)();
          if (out instanceof Response) {
            res.writeHead(out.status || 200, { 'Content-Type': out.contentType, ...out.headers });
            res.end(out.body);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(out);
          return;
        }
        const methodMap = this.#apis.get(url.pathname);
        if (methodMap?.has(req.method)) {
          const chunks = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const data = raw ? JSON.parse(raw) : {};
              const result = await methodMap.get(req.method)(data);
              if (result instanceof Response) {
                res.writeHead(result.status || 200, {
                  'Content-Type': result.contentType,
                  ...result.headers,
                });
                res.end(typeof result.body === 'string' ? result.body : Buffer.from(result.body));
                return;
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }
        res.writeHead(404);
        res.end('Not found');
      });

      return new Promise((resolve) => {
        this.#server = server.listen(this.#port, '127.0.0.1', () => resolve(server));
      });
    }

    close() {
      return new Promise((resolve) => {
        if (!this.#server) return resolve();
        this.#server.closeAllConnections?.();
        this.#server.close(() => resolve());
      });
    }
  }

  return { SidecarApp, Response };
}

let cachedTestSidecarSdk = null;
async function resolveSidecarSdkForTest() {
  if (cachedTestSidecarSdk) return cachedTestSidecarSdk;
  try {
    cachedTestSidecarSdk = await import('sidecar_sdk');
    return cachedTestSidecarSdk;
  } catch {
    const appData = process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity');
    const fallback = join(appData, 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs');
    try {
      cachedTestSidecarSdk = await import(pathToFileURL(fallback).href);
      return cachedTestSidecarSdk;
    } catch {
      cachedTestSidecarSdk = createFallbackSidecarSdk();
      return cachedTestSidecarSdk;
    }
  }
}

function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'ag-switcher-test-'));
  const geminiDir = join(root, '.gemini');
  const dataDir = join(root, 'data');
  mkdirSync(geminiDir, { recursive: true, mode: 0o700 });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const env = {
    ANTIGRAVITY_GEMINI_DIR: geminiDir,
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
  };
  const paths = resolvePaths(env);
  return { root, geminiDir, dataDir, env, paths };
}

test('vault encryption, 0600/0700 permissions, and tamper rejection (fail-close)', (t) => {
  const { geminiDir, paths } = makeSandbox(t);
  const defaultPaths = resolvePaths({ ANTIGRAVITY_GEMINI_DIR: geminiDir });
  assert.equal(defaultPaths.dataDir, join(geminiDir, 'antigravity', 'plugin_data', 'antigravity-account-switcher'));

  const secretRefresh = '1//secret-refresh-should-never-appear-in-ciphertext';
  const secretAccess = 'ya29.secret-access-should-never-appear';
  writeFileSync(paths.tokenPath, makeSampleToken('Alice@Example.com', secretRefresh, secretAccess), {
    encoding: 'utf8',
    mode: 0o600,
  });

  const captured = captureCurrentAccount(paths, { label: '主号' });
  assert.equal(captured.maskedEmail, 'al***@example.com');
  assert.equal(maskEmail('a@b.io'), 'a***@b.io');

  if (process.platform !== 'win32') {
    assert.equal(lstatSync(paths.dataDir).mode & 0o777, 0o700);
    assert.equal(lstatSync(paths.keyPath).mode & 0o777, 0o600);
    assert.equal(lstatSync(paths.vaultPath).mode & 0o777, 0o600);
  }

  const cipherText = readFileSync(paths.vaultPath, 'utf8');
  assert.equal(cipherText.includes(secretRefresh), false);
  assert.equal(cipherText.includes(secretAccess), false);
  assert.equal(cipherText.includes('alice@example.com'), false);

  const vault = loadVault(paths);
  assert.equal(vault.accounts.length, 1);
  assert.equal(vault.accounts[0].email, 'alice@example.com');

  // Tamper auth tag and confirm fail-close
  const envObj = JSON.parse(cipherText);
  const tagBuf = Buffer.from(envObj.tag, 'base64');
  tagBuf[0] ^= 0xff;
  envObj.tag = tagBuf.toString('base64');
  writeFileSync(paths.vaultPath, JSON.stringify(envObj), { encoding: 'utf8', mode: 0o600 });
  assert.throws(() => loadVault(paths));
});

test('vault CRUD, same-email dedup, JWT email extraction, symlink & traversal guards', (t) => {
  const { root, paths } = makeSandbox(t);
  writeFileSync(paths.tokenPath, makeSampleToken('alpha@example.com', '1//refresh-alpha-111111'), {
    encoding: 'utf8',
    mode: 0o600,
  });

  const first = captureCurrentAccount(paths, { label: 'Alpha' });
  writeFileSync(paths.tokenPath, makeSampleToken('alpha@example.com', '1//refresh-alpha-222222'), {
    encoding: 'utf8',
    mode: 0o600,
  });
  const second = captureCurrentAccount(paths, { label: '' });
  assert.equal(second.id, first.id);
  assert.equal(second.label, 'Alpha');

  // Flat OAuth JSON with id_token only
  const imported = importAccount(paths, {
    credentialText: JSON.stringify({
      refresh_token: '1//refresh-beta-333333',
      id_token: makeFakeJwt('BetaUser@Example.org'),
      expiry_date: Date.now() + 3600_000,
    }),
    label: 'Beta',
  });
  assert.equal(imported.maskedEmail, 'be***@example.org');

  renameAccount(paths, { id: imported.id, label: 'Beta-Renamed' });
  const vaultAfterRename = loadVault(paths);
  assert.equal(vaultAfterRename.accounts.length, 2);
  assert.equal(vaultAfterRename.accounts.find((a) => a.id === imported.id).label, 'Beta-Renamed');

  assert.throws(() => renameAccount(paths, { id: '../etc/passwd', label: 'bad' }), /INVALID_ACCOUNT_ID/);
  assert.throws(() => removeAccount(paths, { id: '../etc/passwd' }), /INVALID_ACCOUNT_ID/);
  assert.throws(() => prepareSwitchJob(paths, { mode: 'switch', accountId: '../../evil' }), /INVALID_ACCOUNT_ID/);

  removeAccount(paths, { id: imported.id });
  assert.equal(loadVault(paths).accounts.length, 1);

  // Symlink protection on tokenPath
  if (process.platform !== 'win32') {
    const outsideFile = join(root, 'outside.json');
    writeFileSync(outsideFile, makeSampleToken('evil@example.com', '1//refresh-evil-444444'), 'utf8');
    rmSync(paths.tokenPath);
    symlinkSync(outsideFile, paths.tokenPath);
    assert.throws(() => readActiveToken(paths), /UNSAFE_FILE_TYPE/);
    assert.throws(() => captureCurrentAccount(paths, {}), /UNSAFE_FILE_TYPE/);
  }
});

test('HTTP sidecar routes: security headers, auth fail-close, rate limit, CRUD & no token leakage', async (t) => {
  const { env, paths } = makeSandbox(t);
  writeFileSync(paths.tokenPath, makeSampleToken('active@example.com', '1//refresh-active-secret-token-xyz'), {
    encoding: 'utf8',
    mode: 0o600,
  });

  const spawnedJobs = [];
  const srv = await createApp({
    sidecarSdk: await resolveSidecarSdkForTest(),
    env,
    port: 0,
    uiToken: 'unit-test-sidecar-token',
    lsAddress: 'test.invalid',
    csrfToken: 'test-csrf',
    writeLimit: 8,
    readLimit: 20,
    getUserStatus: async () => ({
      lsConnected: true,
      email: 'active@example.com',
      tierName: 'Google AI Pro',
    }),
    cloudCodeOptions: {
      requestFn: async () => ({ status: 200, json: {} }),
    },
    detectActiveWork: async () => ({ busy: false, count: 0, items: [], truncated: false }),
    spawnWorker: (jobPath) => {
      spawnedJobs.push(jobPath);
    },
  });

  const httpServer = await srv.start();
  t.after(async () => {
    await srv.close();
  });

  const addr = httpServer.address();
  assert.equal(addr.address, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // Static pages & headers
  for (const route of ['/', '/styles.css', '/app.js']) {
    const res = await fetch(`${baseUrl}${route}`);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy') || '';
    assert.ok(csp.includes("default-src 'self'"));
    assert.equal(csp.includes('unsafe-inline'), false);
    assert.equal(csp.includes('unsafe-eval'), false);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }

  // Missing token rejected (401)
  const unauthRes = await fetch(`${baseUrl}/api/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(unauthRes.status, 401);

  const postAuth = async (path, body = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sidecar-Token': 'unit-test-sidecar-token',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    assert.equal(text.includes('refresh_token'), false, `Leak in ${path}`);
    assert.equal(text.includes('access_token'), false, `Leak in ${path}`);
    assert.equal(text.includes('1//refresh-'), false, `Secret leak in ${path}`);
    return { status: res.status, json: JSON.parse(text) };
  };

  // State masked by default
  const st1 = await postAuth('/api/state', {});
  assert.equal(st1.status, 200);
  assert.equal(st1.json.active.maskedEmail, 'ac***@example.com');
  assert.equal(st1.json.active.email, '');
  assert.equal(st1.json.active.tierName, 'Google AI Pro');
  assert.equal(st1.json.active.source, 'file');

  // State with revealEmails=true
  const stRevealed = await postAuth('/api/state', { revealEmails: true });
  assert.equal(stRevealed.json.active.email, 'active@example.com');

  // Capture active & verify /api/accounts/import is removed
  const capRes = await postAuth('/api/accounts/capture', { label: 'Primary' });
  assert.equal(capRes.status, 200);
  assert.equal(capRes.json.accounts.length, 1);

  const removedImpRes = await fetch(`${baseUrl}/api/accounts/import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sidecar-Token': 'unit-test-sidecar-token',
    },
    body: JSON.stringify({
      credential: makeSampleToken('standby@example.com', '1//refresh-standby-secret-token-abc'),
      label: 'Standby',
    }),
  });
  assert.equal(removedImpRes.status, 404);

  const standby = importAccount(paths, {
    credentialText: makeSampleToken('standby@example.com', '1//refresh-standby-secret-token-abc'),
    label: 'Standby',
  });
  assert.ok(standby);
  const st2 = await postAuth('/api/state', {});
  assert.equal(st2.status, 200);
  assert.equal(st2.json.accounts.length, 2);

  // Rename
  const renRes = await postAuth('/api/accounts/rename', { id: standby.id, label: 'Backup-1' });
  assert.equal(renRes.status, 200);
  assert.equal(renRes.json.accounts.find((a) => a.id === standby.id).label, 'Backup-1');

  // Switch (triggers job creation without killing real IDE)
  const swRes = await postAuth('/api/accounts/switch', { id: standby.id });
  assert.equal(swRes.status, 200);
  assert.equal(swRes.json.switching, true);
  assert.equal(spawnedJobs.length, 1);
  assert.ok(existsSync(spawnedJobs[0]));
  if (process.platform !== 'win32') {
    assert.equal(lstatSync(paths.backupPath).mode & 0o777, 0o600);
  }

  // Second switch immediately hits concurrency lock (409)
  const swDup = await postAuth('/api/accounts/switch', { id: standby.id });
  assert.equal(swDup.status, 409);

  // Remove
  const remRes = await postAuth('/api/accounts/remove', { id: standby.id });
  assert.equal(remRes.status, 200);
  assert.equal(remRes.json.accounts.length, 1);

  // Trigger rate limit (writeLimit=8; already sent 5 write requests)
  for (let i = 0; i < 3; i++) {
    await postAuth('/api/accounts/rename', { id: capRes.json.accounts[0].id, label: `P${i}` });
  }
  const rateLimited = await postAuth('/api/accounts/rename', { id: capRes.json.accounts[0].id, label: 'P-over' });
  assert.equal(rateLimited.status, 429);
});

test('switcher-worker DRY_RUN end-to-end switch and new-login without touching real environment', async (t) => {
  const { env, paths } = makeSandbox(t);
  const tokenA = makeSampleToken('acc-a@example.com', '1//refresh-a-secret-999999');
  const tokenB = makeSampleToken('acc-b@example.com', '1//refresh-b-secret-888888');

  writeFileSync(paths.tokenPath, tokenA, { encoding: 'utf8', mode: 0o600 });
  const savedB = importAccount(paths, { credentialText: tokenB, label: 'Account B' });

  // Update tokenA on disk before switch to verify auto-sync into vault
  const tokenARotated = makeSampleToken('acc-a@example.com', '1//refresh-a-rotated-777777');
  writeFileSync(paths.tokenPath, tokenARotated, { encoding: 'utf8', mode: 0o600 });

  const switchJob = prepareSwitchJob(paths, { mode: 'switch', accountId: savedB.id });
  assert.ok(existsSync(switchJob.jobPath));

  await execFileAsync(NODE_BIN, [WORKER_PATH, switchJob.jobPath], {
    env: { ...process.env, ...env, SWITCHER_DRY_RUN: '1' },
  });

  // Job file destroyed, target token written with 0600, rotated token A synced in vault
  assert.equal(existsSync(switchJob.jobPath), false);
  if (process.platform !== 'win32') {
    assert.equal(lstatSync(paths.tokenPath).mode & 0o777, 0o600);
  }
  const activeAfterSwitch = readActiveToken(paths);
  assert.equal(activeAfterSwitch.email, 'acc-b@example.com');
  assert.ok(JSON.parse(activeAfterSwitch.rawJson).token.refresh_token === '1//refresh-b-secret-888888');

  const vault = loadVault(paths);
  const accA = vault.accounts.find((a) => a.email === 'acc-a@example.com');
  assert.ok(accA);
  assert.equal(JSON.parse(accA.tokenRaw).token.refresh_token, '1//refresh-a-rotated-777777');

  // Verify new-login removes tokenPath while keeping account B in vault
  const newLoginJob = prepareSwitchJob(paths, { mode: 'new-login' });
  await execFileAsync(NODE_BIN, [WORKER_PATH, newLoginJob.jobPath], {
    env: { ...process.env, ...env, SWITCHER_DRY_RUN: '1' },
  });
  assert.equal(existsSync(paths.tokenPath), false);

  const logContent = readFileSync(paths.logPath, 'utf8');
  assert.equal(logContent.includes('1//refresh-'), false);
  assert.equal(logContent.includes('acc-a@example.com'), false);
  assert.ok(logContent.includes('DRY_RUN'));

  // Switch back from vault to A
  const backJob = prepareSwitchJob(paths, { mode: 'switch', accountId: accA.id });
  await execFileAsync(NODE_BIN, [WORKER_PATH, backJob.jobPath], {
    env: { ...process.env, ...env, SWITCHER_DRY_RUN: '1' },
  });
  const activeRestored = readActiveToken(paths);
  assert.equal(activeRestored.email, 'acc-a@example.com');
  assert.equal(JSON.parse(activeRestored.rawJson).token.refresh_token, '1//refresh-a-rotated-777777');

  // Reject path traversal outside jobsDir
  getOrCreateKey(paths);
  const outsideJob = join(paths.dataDir, 'job-11111111-1111-4111-8111-111111111111.enc.json');
  writeFileSync(outsideJob, '{}', 'utf8');
  if (process.platform !== 'win32') {
    chmodSync(outsideJob, 0o600);
  }
  await assert.rejects(
    () =>
      execFileAsync(NODE_BIN, [WORKER_PATH, outsideJob], {
        env: { ...process.env, ...env, SWITCHER_DRY_RUN: '1' },
      }),
    /PATH_OUTSIDE_BOUNDARY/
  );
});

test('createApp fails closed when ANTIGRAVITY_SIDECAR_UI_TOKEN is missing', async (t) => {
  const { env } = makeSandbox(t);
  const srv = await createApp({
    sidecarSdk: await resolveSidecarSdkForTest(),
    env,
    port: 0,
    uiToken: '',
    lsAddress: 'test.invalid',
    csrfToken: 'test-csrf',
  });
  const httpServer = await srv.start();
  t.after(async () => {
    await srv.close();
  });
  const addr = httpServer.address();
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 403);
});

test('createApp works with fallback SidecarApp/Response test double when sidecar_sdk is absent', async (t) => {
  const { env } = makeSandbox(t);
  const fallbackSdk = createFallbackSidecarSdk();
  const srv = await createApp({
    sidecarSdk: fallbackSdk,
    env,
    port: 0,
    uiToken: 'fallback-sdk-token',
    lsAddress: 'test.invalid',
    csrfToken: 'test-csrf',
    getUserStatus: async () => ({ lsConnected: false, email: '', tierName: '' }),
  });
  const httpServer = await srv.start();
  t.after(async () => {
    await srv.close();
  });

  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  const htmlRes = await fetch(`${baseUrl}/`);
  assert.equal(htmlRes.status, 200);
  const jsRes = await fetch(`${baseUrl}/app.js`);
  assert.equal(jsRes.status, 200);

  const unauthRes = await fetch(`${baseUrl}/api/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(unauthRes.status, 401);

  const authRes = await fetch(`${baseUrl}/api/state`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sidecar-Token': 'fallback-sdk-token',
    },
    body: '{}',
  });
  assert.equal(authRes.status, 200);
  const payload = await authRes.json();
  assert.equal(payload.ok, true);

  const srvNoTok = await createApp({
    sidecarSdk: fallbackSdk,
    env,
    port: 0,
    uiToken: '',
    lsAddress: 'test.invalid',
    csrfToken: 'test-csrf',
  });
  const httpNoTok = await srvNoTok.start();
  t.after(async () => {
    await srvNoTok.close();
  });
  const denied = await fetch(`http://127.0.0.1:${httpNoTok.address().port}/api/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(denied.status, 403);
});

function hasElfMagic(filePath) {
  let fd = -1;
  try {
    fd = openSync(filePath, 'r');
    const head = Buffer.alloc(4);
    const n = readSync(fd, head, 0, 4, 0);
    return n === 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
  } catch {
    return false;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

test('loadNativeOAuthClients extracts paired 1071006060591 client from local language_server ELF with exact 35-char secrets', (t) => {
  const elfCandidates = resolveLanguageServerCandidates().filter(
    (p) => !p.toLowerCase().endsWith('.exe') && hasElfMagic(p)
  );
  if (elfCandidates.length === 0) {
    t.skip('No local ELF64 language_server binary found');
    return;
  }
  const clients = loadNativeOAuthClients();
  assert.ok(clients.length >= 1);
  assert.ok(clients[0].id.startsWith('1071006060591-'));
  assert.ok(clients[0].id.endsWith('.apps.googleusercontent.com'));
  assert.equal(clients[0].id.length, 73);
  for (const client of clients) {
    assert.ok(client.secret.startsWith('GOCSPX-'));
    assert.equal(client.secret.length, 35);
    assert.equal(/decoding|https|field/.test(client.secret), false);
  }
});

test('extractPeOAuthClients and extractBinaryOAuthClients extract paired client from local Windows PE64 language_server.exe', (t) => {
  const peCandidates = resolveLanguageServerCandidates().filter((p) =>
    p.toLowerCase().endsWith('language_server.exe')
  );
  if (peCandidates.length === 0) {
    t.skip('No local Windows PE64 language_server.exe binary found');
    return;
  }
  const peBuf = readFileSync(peCandidates[0]);
  const peClients = extractPeOAuthClients(peBuf);
  const binClients = extractBinaryOAuthClients(peBuf);
  assert.deepEqual(binClients, peClients);
  assert.ok(peClients.length >= 1);
  assert.ok(peClients[0].id.startsWith('1071006060591-'));
  assert.ok(peClients[0].id.endsWith('.apps.googleusercontent.com'));
  assert.equal(peClients[0].id.length, 73);
  for (const client of peClients) {
    assert.ok(client.secret.startsWith('GOCSPX-'));
    assert.equal(client.secret.length, 35);
    assert.equal(/decoding|https|field/.test(client.secret), false);
  }
});

function buildGoX64Text({ textVa, idVa, idLen, secVa, secLen }) {
  const textBuf = Buffer.alloc(64);
  const baseVa = BigInt(textVa);
  let pos = 0;
  // mov qword ptr [rsp+0x130], idLen (12 bytes)
  Buffer.from([0x48, 0xc7, 0x84, 0x24, 0x30, 0x01, 0x00, 0x00]).copy(textBuf, pos);
  textBuf.writeUInt32LE(idLen, pos + 8);
  pos += 12;
  // lea r8, [rip + idDisp] (7 bytes)
  const idPc = baseVa + BigInt(pos);
  textBuf[pos] = 0x4c;
  textBuf[pos + 1] = 0x8d;
  textBuf[pos + 2] = 0x05;
  textBuf.writeInt32LE(Number(BigInt(idVa) - (idPc + 7n)), pos + 3);
  pos += 7;
  // mov qword ptr [rsp+0x110], secLen (12 bytes)
  Buffer.from([0x48, 0xc7, 0x84, 0x24, 0x10, 0x01, 0x00, 0x00]).copy(textBuf, pos);
  textBuf.writeUInt32LE(secLen, pos + 8);
  pos += 12;
  // lea r9, [rip + secDisp] (7 bytes)
  const secPc = baseVa + BigInt(pos);
  textBuf[pos] = 0x4c;
  textBuf[pos + 1] = 0x8d;
  textBuf[pos + 2] = 0x0d;
  textBuf.writeInt32LE(Number(BigInt(secVa) - (secPc + 7n)), pos + 3);
  pos += 7;
  return textBuf.subarray(0, pos);
}

function encodeArm64Adrp(rd, pcVa, targetVa) {
  const pageDelta = Number(((BigInt(targetVa) & ~0xfffn) - (BigInt(pcVa) & ~0xfffn)) >> 12n);
  const rawImm21 = pageDelta & 0x1fffff;
  const immlo = rawImm21 & 0x3;
  const immhi = (rawImm21 >>> 2) & 0x7ffff;
  return (0x90000000 | (immlo << 29) | (immhi << 5) | (rd & 0x1f)) >>> 0;
}

function encodeArm64AddImm12(rd, rn, targetVa) {
  const imm12 = Number(BigInt(targetVa) & 0xfffn);
  return (0x91000000 | ((imm12 & 0xfff) << 10) | ((rn & 0x1f) << 5) | (rd & 0x1f)) >>> 0;
}

function encodeArm64MovzW(rd, imm16) {
  return (0x52800000 | ((imm16 & 0xffff) << 5) | (rd & 0x1f)) >>> 0;
}

function encodeArm64MovkLsl16(rd, imm16 = 0) {
  return (0xf2a00000 | ((imm16 & 0xffff) << 5) | (rd & 0x1f)) >>> 0;
}

function buildGoArm64Text({ textVa, idVa, idLen, secVa, secLen }) {
  const baseVa = BigInt(textVa);
  const insns = [];
  const emit = (u32) => insns.push(u32 >>> 0);
  // Load client_id pointer (ADRP + ADD) and length (MOVZ + MOVK)
  emit(encodeArm64Adrp(0, baseVa + BigInt(insns.length * 4), idVa));
  emit(encodeArm64AddImm12(0, 0, idVa));
  emit(encodeArm64MovzW(1, idLen));
  emit(encodeArm64MovkLsl16(1, 0));
  // Load client_secret pointer (ADRP + ADD) and length (MOVZ + MOVK)
  emit(encodeArm64Adrp(2, baseVa + BigInt(insns.length * 4), secVa));
  emit(encodeArm64AddImm12(2, 2, secVa));
  emit(encodeArm64MovzW(3, secLen));
  emit(encodeArm64MovkLsl16(3, 0));

  const out = Buffer.alloc(insns.length * 4);
  insns.forEach((insn, idx) => out.writeUInt32LE(insn, idx * 4));
  return out;
}

function buildSyntheticElf64({ idStr, idTrailing, secretStr, secretTrailing }) {
  const buf = Buffer.alloc(0x600);
  buf[0] = 0x7f;
  buf[1] = 0x45;
  buf[2] = 0x4c;
  buf[3] = 0x46;
  buf[4] = 2; // ELF64
  buf[5] = 1; // little endian
  buf[6] = 1;
  buf.writeUInt16LE(0x3e, 18); // x86_64
  const eShoff = 0x500;
  buf.writeBigUInt64LE(BigInt(eShoff), 40);
  buf.writeUInt16LE(64, 58); // e_shentsize
  buf.writeUInt16LE(4, 60); // e_shnum
  buf.writeUInt16LE(1, 62); // e_shstrndx

  const shstr = '\0.shstrtab\0.rodata\0.text\0';
  buf.write(shstr, 0x100, 'ascii');
  const roNameOff = shstr.indexOf('.rodata');
  const textNameOff = shstr.indexOf('.text');
  const shstrNameOff = shstr.indexOf('.shstrtab');

  const roVa = 0x10000;
  const roChunk = `${idStr}${idTrailing}${secretStr}${secretTrailing}`;
  buf.write(roChunk, 0x200, 'latin1');
  const idVa = roVa;
  const secVa = roVa + idStr.length + idTrailing.length;

  const textVa = 0x20000;
  const textBuf = buildGoX64Text({
    textVa,
    idVa,
    idLen: idStr.length,
    secVa,
    secLen: secretStr.length,
  });
  textBuf.copy(buf, 0x400);

  const writeSection = (idx, nameOff, addr, off, size) => {
    const sh = eShoff + idx * 64;
    buf.writeUInt32LE(nameOff, sh);
    buf.writeBigUInt64LE(BigInt(addr), sh + 16);
    buf.writeBigUInt64LE(BigInt(off), sh + 24);
    buf.writeBigUInt64LE(BigInt(size), sh + 32);
  };
  writeSection(1, shstrNameOff, 0, 0x100, shstr.length);
  writeSection(2, roNameOff, roVa, 0x200, roChunk.length);
  writeSection(3, textNameOff, textVa, 0x400, textBuf.length);
  return buf;
}

function buildSyntheticPe64({ idStr, idTrailing, secretStr, secretTrailing, machine = 0x8664 }) {
  const buf = Buffer.alloc(0x700);
  buf[0] = 0x4d; // M
  buf[1] = 0x5a; // Z
  const peOff = 0x80;
  buf.writeUInt32LE(peOff, 0x3c);
  buf.write('PE\0\0', peOff, 'ascii');
  buf.writeUInt16LE(machine, peOff + 4);
  buf.writeUInt16LE(2, peOff + 6); // NumberOfSections
  const optSize = 0xf0;
  buf.writeUInt16LE(optSize, peOff + 20);

  const optOff = peOff + 24;
  buf.writeUInt16LE(0x20b, optOff); // PE32+
  const imageBase = 0x140000000n;
  buf.writeBigUInt64LE(imageBase, optOff + 24);

  const rdataRva = 0x1000;
  const rdataRaw = 0x300;
  const roChunk = `${idStr}${idTrailing}${secretStr}${secretTrailing}`;
  buf.write(roChunk, rdataRaw, 'latin1');

  const textRva = 0x2000;
  const textRaw = 0x500;
  const textVa = imageBase + BigInt(textRva);
  const idVa = imageBase + BigInt(rdataRva);
  const secVa = idVa + BigInt(idStr.length + idTrailing.length);
  const textBuf =
    machine === 0xaa64
      ? buildGoArm64Text({ textVa, idVa, idLen: idStr.length, secVa, secLen: secretStr.length })
      : buildGoX64Text({ textVa, idVa, idLen: idStr.length, secVa, secLen: secretStr.length });
  textBuf.copy(buf, textRaw);

  const secOff = optOff + optSize;
  const writePeSec = (idx, name, vaddr, rawSize, rawPtr) => {
    const o = secOff + idx * 40;
    buf.write(name, o, 'ascii');
    buf.writeUInt32LE(vaddr, o + 12);
    buf.writeUInt32LE(rawSize, o + 16);
    buf.writeUInt32LE(rawPtr, o + 20);
  };
  writePeSec(0, '.rdata', rdataRva, roChunk.length, rdataRaw);
  writePeSec(1, '.text', textRva, textBuf.length, textRaw);
  return buf;
}

function buildSyntheticMachO64({
  arch = 'x64',
  idStr = '',
  idTrailing = '',
  secretStr = '',
  secretTrailing = '',
  roSectName = '__rodata',
  includeClient = true,
}) {
  const buf = Buffer.alloc(0x600);
  const isArm64 = arch === 'arm64';
  const cputype = isArm64 ? 0x0100000c : 0x01000007;
  buf.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
  buf.writeInt32LE(cputype, 4);
  buf.writeUInt32LE(1, 16); // ncmds
  const cmdSize = 72 + 2 * 80;
  buf.writeUInt32LE(cmdSize, 20); // sizeofcmds

  const cmdOff = 32;
  buf.writeUInt32LE(0x19, cmdOff); // LC_SEGMENT_64
  buf.writeUInt32LE(cmdSize, cmdOff + 4);
  buf.write('__TEXT', cmdOff + 8, 'ascii');
  buf.writeUInt32LE(2, cmdOff + 64); // nsects

  const roOff = 0x200;
  const roVa = 0x10000n;
  const roChunk = includeClient ? `${idStr}${idTrailing}${secretStr}${secretTrailing}` : 'decoy_slice_data';
  buf.write(roChunk, roOff, 'latin1');

  const textOff = 0x400;
  const textVa = 0x20000n;
  let textBuf;
  if (!includeClient) {
    textBuf = Buffer.from([0x90, 0x90, 0x90, 0x90]);
  } else if (isArm64) {
    textBuf = buildGoArm64Text({
      textVa,
      idVa: roVa,
      idLen: idStr.length,
      secVa: roVa + BigInt(idStr.length + idTrailing.length),
      secLen: secretStr.length,
    });
  } else {
    textBuf = buildGoX64Text({
      textVa,
      idVa: roVa,
      idLen: idStr.length,
      secVa: roVa + BigInt(idStr.length + idTrailing.length),
      secLen: secretStr.length,
    });
  }
  textBuf.copy(buf, textOff);

  const writeMachOSect = (idx, sectname, segname, addr, size, offset) => {
    const o = cmdOff + 72 + idx * 80;
    buf.write(sectname, o, 'ascii');
    buf.write(segname, o + 16, 'ascii');
    buf.writeBigUInt64LE(BigInt(addr), o + 32);
    buf.writeBigUInt64LE(BigInt(size), o + 40);
    buf.writeUInt32LE(offset, o + 48);
  };
  writeMachOSect(0, roSectName, '__TEXT', roVa, roChunk.length, roOff);
  writeMachOSect(1, '__text', '__TEXT', textVa, textBuf.length, textOff);
  return buf;
}

function buildUniversalFatMachO(slices, { fat64 = false } = {}) {
  const archSize = fat64 ? 32 : 20;
  const headerSize = 8 + slices.length * archSize;
  const alignedHeader = Math.ceil(headerSize / 16) * 16;
  const totalSize = alignedHeader + slices.reduce((sum, s) => sum + s.buf.length, 0);
  const out = Buffer.alloc(totalSize);

  out.writeUInt32BE(fat64 ? 0xcafebabf : 0xcafebabe, 0);
  out.writeUInt32BE(slices.length, 4);

  let cursor = alignedHeader;
  slices.forEach((slice, idx) => {
    const o = 8 + idx * archSize;
    out.writeInt32BE(slice.cputype, o);
    out.writeInt32BE(slice.cpusubtype || 0, o + 4);
    if (fat64) {
      out.writeBigUInt64BE(BigInt(cursor), o + 8);
      out.writeBigUInt64BE(BigInt(slice.buf.length), o + 16);
    } else {
      out.writeUInt32BE(cursor, o + 8);
      out.writeUInt32BE(slice.buf.length, o + 12);
    }
    slice.buf.copy(out, cursor);
    cursor += slice.buf.length;
  });
  return out;
}

test('extractElfOAuthClients trims non-null-terminated .rodata strings using Go x64 string-length immediates', () => {
  const idStr = '1071006060591-synthid00000001.apps.googleusercontent.com';
  const secretStr = `${SYNTH_SECRET_PREFIX}synth0123456789abcdefghij123`;
  assert.equal(secretStr.length, 35);
  const elf = buildSyntheticElf64({
    idStr,
    idTrailing: 'TRAILING',
    secretStr,
    secretTrailing: 'decodingNEXTSTRING',
  });
  const clients = extractElfOAuthClients(elf);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].id, idStr);
  assert.equal(clients[0].secret, secretStr);
  assert.equal(clients[0].secret.length, 35);
  assert.equal(clients[0].secret.includes('decoding'), false);
});

test('extractPeOAuthClients and extractBinaryOAuthClients extract synthetic PE64 x64 and ARM64 clients', () => {
  const idStr = '1071006060591-synthpe64x6400000000000000000001.apps.googleusercontent.com';
  const secretStr = `${SYNTH_SECRET_PREFIX}synthpe64x640123456789abcdef`;
  assert.equal(idStr.length, 73);
  assert.equal(secretStr.length, 35);

  for (const machine of [0x8664, 0xaa64]) {
    const pe = buildSyntheticPe64({
      idStr,
      idTrailing: 'TRAILING',
      secretStr,
      secretTrailing: 'decodingNEXTSTRING',
      machine,
    });
    const peClients = extractPeOAuthClients(pe);
    const binClients = extractBinaryOAuthClients(pe);
    assert.deepEqual(peClients, [{ id: idStr, secret: secretStr }]);
    assert.deepEqual(binClients, peClients);
  }

  assert.deepEqual(extractPeOAuthClients(Buffer.from('MZshort')), []);
});

test('extractMachOOAuthClients and extractBinaryOAuthClients support Mach-O x64, ARM64 (ADRP+ADD+MOVZ/MOVK), and Universal Fat Mach-O', () => {
  const idStr = '1071006060591-synthmacho0000000000000000000001.apps.googleusercontent.com';
  const secretStr = `${SYNTH_SECRET_PREFIX}synthmacho0123456789abcdefgh`;
  assert.equal(idStr.length, 73);
  assert.equal(secretStr.length, 35);

  const machX64 = buildSyntheticMachO64({
    arch: 'x64',
    idStr,
    idTrailing: 'TRAILING',
    secretStr,
    secretTrailing: 'decodingNEXTSTRING',
  });
  assert.deepEqual(extractMachOOAuthClients(machX64), [{ id: idStr, secret: secretStr }]);
  assert.deepEqual(extractBinaryOAuthClients(machX64), [{ id: idStr, secret: secretStr }]);

  const machArm64 = buildSyntheticMachO64({
    arch: 'arm64',
    idStr,
    idTrailing: 'TRAILING',
    secretStr,
    secretTrailing: 'httpsNEXTSTRING',
    roSectName: '__cstring',
  });
  assert.deepEqual(extractMachOOAuthClients(machArm64), [{ id: idStr, secret: secretStr }]);
  assert.deepEqual(extractBinaryOAuthClients(machArm64), [{ id: idStr, secret: secretStr }]);

  const decoyX64 = buildSyntheticMachO64({ arch: 'x64', includeClient: false });
  const fat32 = buildUniversalFatMachO([
    { cputype: 0x01000007, buf: decoyX64 },
    { cputype: 0x0100000c, buf: machArm64 },
  ]);
  assert.deepEqual(extractMachOOAuthClients(fat32), [{ id: idStr, secret: secretStr }]);
  assert.deepEqual(extractBinaryOAuthClients(fat32), [{ id: idStr, secret: secretStr }]);

  const fat64 = buildUniversalFatMachO(
    [
      { cputype: 0x01000007, buf: decoyX64 },
      { cputype: 0x01000007, buf: machX64 },
    ],
    { fat64: true }
  );
  assert.deepEqual(extractMachOOAuthClients(fat64), [{ id: idStr, secret: secretStr }]);
  assert.deepEqual(extractBinaryOAuthClients(fat64), [{ id: idStr, secret: secretStr }]);
});

function generateTestTlsCert(commonName = 'oauth2.googleapis.com') {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const derLen = (n) => {
    if (n < 128) return Buffer.from([n]);
    const bytes = [];
    let x = n;
    while (x > 0) {
      bytes.unshift(x & 0xff);
      x >>= 8;
    }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  };
  const tlv = (tag, ...parts) => {
    const body = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
  };
  const oid = (hex) => tlv(0x06, Buffer.from(hex, 'hex'));
  const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
  const utc = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    const s =
      String(d.getUTCFullYear()).slice(-2) +
      p(d.getUTCMonth() + 1) +
      p(d.getUTCDate()) +
      p(d.getUTCHours()) +
      p(d.getUTCMinutes()) +
      p(d.getUTCSeconds()) +
      'Z';
    return tlv(0x17, Buffer.from(s, 'ascii'));
  };
  const seq = (...p) => tlv(0x30, ...p);
  const set = (...p) => tlv(0x31, ...p);
  const int = (b) => {
    let buf = Buffer.isBuffer(b) ? b : Buffer.from([b]);
    if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
    return tlv(0x02, buf);
  };
  const bitStr = (b) => tlv(0x03, Buffer.from([0]), b);
  const ctx = (n, ...p) => tlv(0xa0 | n, ...p);

  const algId = seq(oid('2a8648ce3d040302')); // ecdsa-with-SHA256
  const name = seq(set(seq(oid('550403'), utf8(commonName))));
  const now = Date.now();
  const validity = seq(utc(new Date(now - 3600_000)), utc(new Date(now + 86400_000)));
  const sanExt = seq(oid('551d11'), tlv(0x04, seq(tlv(0x82, Buffer.from(commonName, 'ascii')))));
  const bcExt = seq(oid('551d13'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq(tlv(0x01, Buffer.from([0xff])))));
  const exts = ctx(3, seq(bcExt, sanExt));
  const tbs = seq(ctx(0, int(2)), int(randomBytes(8)), algId, name, validity, name, spki, exts);
  const sig = cryptoSign('sha256', tbs, privateKey);
  const certDer = seq(tbs, algId, bitStr(sig));
  const certPem =
    '-----BEGIN CERTIFICATE-----\n' +
    certDer.toString('base64').match(/.{1,64}/g).join('\n') +
    '\n-----END CERTIFICATE-----\n';
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { certPem, keyPem };
}

test('httpsJsonRequest routes through HTTP CONNECT proxyEnv without hanging and enforces host allow-list', async (t) => {
  assert.equal(supportsNativeProxyEnv('18.20.0'), false);
  assert.equal(supportsNativeProxyEnv('20.19.0'), false);
  assert.equal(supportsNativeProxyEnv('22.21.0'), true);
  assert.equal(supportsNativeProxyEnv('24.4.0'), false);
  assert.equal(supportsNativeProxyEnv('24.5.0'), true);

  const connectTargets = [];
  const proxyServer = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  proxyServer.on('connect', (req, socket) => {
    connectTargets.push(req.url);
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    socket.destroy();
  });
  await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
  t.after(() => proxyServer.close());

  const { port } = proxyServer.address();
  const startedAt = Date.now();
  await assert.rejects(
    () =>
      httpsJsonRequest(
        'https://oauth2.googleapis.com/token',
        { method: 'POST', body: 'a=1', timeoutMs: 3000 },
        { HTTPS_PROXY: `http://127.0.0.1:${port}`, NO_PROXY: '' }
      ),
    (err) => err?.code === 'OAUTH_PROXY_CONNECT_FAILED'
  );
  assert.ok(Date.now() - startedAt < 2500);
  assert.deepEqual(connectTargets, ['oauth2.googleapis.com:443']);

  await assert.rejects(
    () => httpsJsonRequest('https://evil.example.com/token', {}, {}),
    /DISALLOWED_OAUTH_HOST/
  );
});

test('ProxyConnectAgent (forceLegacyProxy) handles CONNECT headers, non-200 rejection, strict TLS verification, and --use-env-proxy bypass', async (t) => {
  const { root } = makeSandbox(t);
  const { certPem, keyPem } = generateTestTlsCert('oauth2.googleapis.com');
  const caPath = join(root, 'mock-ca.pem');
  writeFileSync(caPath, certPem, 'utf8');

  // 1. Non-200 CONNECT rejection + Proxy-Authorization header encoding
  const rejectedReqs = [];
  const rejectProxy = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  rejectProxy.on('connect', (req, socket) => {
    rejectedReqs.push({
      url: req.url,
      host: req.headers.host,
      proxyAuth: req.headers['proxy-authorization'] || '',
    });
    socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
    socket.destroy();
  });
  await new Promise((resolve) => rejectProxy.listen(0, '127.0.0.1', resolve));
  t.after(() => rejectProxy.close());

  const rejectPort = rejectProxy.address().port;
  await assert.rejects(
    () =>
      httpsJsonRequest(
        'https://oauth2.googleapis.com/token',
        { method: 'POST', body: 'a=1', timeoutMs: 3000, forceLegacyProxy: true },
        { HTTPS_PROXY: `http://alice%40corp:s3cr%3At@127.0.0.1:${rejectPort}`, NO_PROXY: '' }
      ),
    (err) => err?.code === 'OAUTH_PROXY_CONNECT_FAILED'
  );
  assert.equal(rejectedReqs.length, 1);
  assert.equal(rejectedReqs[0].url, 'oauth2.googleapis.com:443');
  assert.equal(rejectedReqs[0].host, 'oauth2.googleapis.com:443');
  assert.equal(
    rejectedReqs[0].proxyAuth,
    `Basic ${Buffer.from('alice@corp:s3cr:t', 'utf8').toString('base64')}`
  );

  // 2. 200 CONNECT -> mock HTTPS target: in-process rejects untrusted cert (SNI verified),
  //    and child processes with NODE_EXTRA_CA_CERTS succeed under both normal and --use-env-proxy
  const seenSni = [];
  const secureCtx = tls.createSecureContext({ key: keyPem, cert: certPem });
  const httpsTarget = https.createServer(
    {
      key: keyPem,
      cert: certPem,
      SNICallback(servername, cb) {
        seenSni.push(servername);
        cb(null, secureCtx);
      },
    },
    (req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'mock-access-token',
            method: req.method,
            path: req.url,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      });
    }
  );
  await new Promise((resolve) => httpsTarget.listen(0, '127.0.0.1', resolve));
  t.after(() => httpsTarget.close());
  const targetPort = httpsTarget.address().port;

  const tunnelReqs = [];
  const tunnelProxy = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  tunnelProxy.on('connect', (req, clientSock, head) => {
    tunnelReqs.push({
      url: req.url,
      host: req.headers.host,
      proxyAuth: req.headers['proxy-authorization'] || '',
    });
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSock);
      clientSock.pipe(upstream);
    });
    upstream.on('error', () => clientSock.destroy());
    clientSock.on('error', () => upstream.destroy());
  });
  await new Promise((resolve) => tunnelProxy.listen(0, '127.0.0.1', resolve));
  t.after(() => tunnelProxy.close());
  const tunnelPort = tunnelProxy.address().port;

  // In-process without NODE_EXTRA_CA_CERTS must reject self-signed cert (rejectUnauthorized: true)
  await assert.rejects(
    () =>
      httpsJsonRequest(
        'https://oauth2.googleapis.com/token',
        { method: 'POST', body: 'code=untrusted', timeoutMs: 3000, forceLegacyProxy: true },
        { HTTPS_PROXY: `http://127.0.0.1:${tunnelPort}`, NO_PROXY: '' }
      ),
    (err) =>
      ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(
        err?.code
      )
  );
  assert.ok(seenSni.includes('oauth2.googleapis.com'));

  // Trap proxy verifies CONNECT never loops through global env proxy agent under --use-env-proxy
  let trapHits = 0;
  const trapProxy = http.createServer((_req, res) => {
    trapHits += 1;
    res.writeHead(500);
    res.end();
  });
  trapProxy.on('connect', (_req, sock) => {
    trapHits += 1;
    sock.destroy();
  });
  await new Promise((resolve) => trapProxy.listen(0, '127.0.0.1', resolve));
  t.after(() => trapProxy.close());
  const trapPort = trapProxy.address().port;

  const childScript = `
    import { httpsJsonRequest } from ${JSON.stringify(OAUTH_MOD_URL)};
    const res = await httpsJsonRequest(
      'https://oauth2.googleapis.com/token',
      { method: 'POST', body: 'code=ok', timeoutMs: 5000, forceLegacyProxy: true },
      { HTTPS_PROXY: 'http://alice:pw123@127.0.0.1:${tunnelPort}', NO_PROXY: '' }
    );
    console.log(JSON.stringify(res));
  `;

  const extraArgCases = supportsNativeProxyEnv() ? [[], ['--use-env-proxy']] : [[]];
  for (const extraArgs of extraArgCases) {
    const childRes = await execFileAsync(
      NODE_BIN,
      [...extraArgs, '--input-type=module', '-e', childScript],
      {
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: caPath,
          HTTP_PROXY: `http://127.0.0.1:${trapPort}`,
          HTTPS_PROXY: `http://127.0.0.1:${trapPort}`,
          http_proxy: `http://127.0.0.1:${trapPort}`,
          https_proxy: `http://127.0.0.1:${trapPort}`,
          NO_PROXY: '',
          no_proxy: '',
        },
      }
    );
    const parsed = JSON.parse(childRes.stdout.trim());
    assert.equal(parsed.status, 200);
    assert.deepEqual(parsed.json, {
      access_token: 'mock-access-token',
      method: 'POST',
      path: '/token',
      body: 'code=ok',
    });
  }
  assert.equal(trapHits, 0);
  const expectedAuth = `Basic ${Buffer.from('alice:pw123', 'utf8').toString('base64')}`;
  assert.equal(tunnelReqs.filter((r) => r.proxyAuth === expectedAuth).length, extraArgCases.length);
});

test('OAuth loopback flow adds second account without modifying active token, validates state, and supports cancel', async (t) => {
  const { env, paths } = makeSandbox(t);
  const activeTokenRaw = makeSampleToken('first@example.com', '1//refresh-first-account-111');
  writeFileSync(paths.tokenPath, activeTokenRaw, { encoding: 'utf8', mode: 0o600 });

  const capturedAuthUrls = [];
  const tokenExchangeCalls = [];
  const userInfoCalls = [];
  const fakeClientId = '1071006060591-testclientid0001.apps.googleusercontent.com';
  const fakeClientSecret = `${SYNTH_SECRET_PREFIX}fakeTestSecret000000000000000000`;

  const srv = await createApp({
    sidecarSdk: await resolveSidecarSdkForTest(),
    env,
    port: 0,
    uiToken: 'oauth-unit-test-token',
    lsAddress: 'test.invalid',
    csrfToken: 'test-csrf',
    getUserStatus: async () => ({
      lsConnected: true,
      email: 'first@example.com',
      tierName: 'Google AI Pro',
    }),
    oauthOptions: {
      loadClients: () => [{ id: fakeClientId, secret: fakeClientSecret }],
      openBrowser: (authUrl) => {
        capturedAuthUrls.push(authUrl);
        return { opened: true };
      },
      requestFn: async (urlStr, opts) => {
        if (urlStr === 'https://oauth2.googleapis.com/token') {
          const params = new URLSearchParams(opts.body);
          tokenExchangeCalls.push(Object.fromEntries(params.entries()));
          return {
            status: 200,
            json: {
              access_token: 'ya29.second-account-access-token',
              refresh_token: '1//second-account-refresh-token-222',
              expires_in: 3600,
              token_type: 'Bearer',
            },
          };
        }
        if (urlStr === 'https://www.googleapis.com/oauth2/v2/userinfo') {
          userInfoCalls.push(opts.headers?.Authorization || '');
          return {
            status: 200,
            json: { email: 'SecondUser@Example.com', verified_email: true },
          };
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      },
    },
  });

  const httpServer = await srv.start();
  t.after(async () => {
    await srv.close();
  });

  const addr = httpServer.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const postAuth = async (path, body = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sidecar-Token': 'oauth-unit-test-token',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    assert.equal(text.includes(fakeClientSecret), false);
    assert.equal(text.includes('codeVerifier'), false);
    assert.equal(text.includes('refresh-token'), false);
    assert.equal(text.includes('access-token'), false);
    return { status: res.status, json: JSON.parse(text) };
  };

  // Capture first account into vault
  await postAuth('/api/accounts/capture', { label: 'Main' });

  // Start OAuth flow for second account
  const startRes = await postAuth('/api/oauth/start', { label: 'Second' });
  assert.equal(startRes.status, 200);
  assert.equal(startRes.json.oauth.status, 'pending');
  assert.equal(startRes.json.oauth.browserOpened, true);
  assert.equal(capturedAuthUrls.length, 1);

  const authUrl = new URL(startRes.json.oauth.authUrl);
  assert.equal(authUrl.origin, 'https://accounts.google.com');
  assert.equal(authUrl.searchParams.get('client_id'), fakeClientId);
  assert.equal(authUrl.searchParams.get('prompt'), 'select_account consent');
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');

  const redirectUri = authUrl.searchParams.get('redirect_uri');
  const stateParam = authUrl.searchParams.get('state');
  const challenge = authUrl.searchParams.get('code_challenge');
  assert.ok(redirectUri && redirectUri.startsWith('http://localhost:'));
  assert.ok(stateParam && stateParam.length === 64);
  assert.ok(challenge && challenge.length >= 40);

  // Check status does not expose raw state, codeVerifier, or secrets
  const pendingStatus = await postAuth('/api/oauth/status');
  assert.equal(pendingStatus.status, 200);
  assert.equal(pendingStatus.json.oauth.status, 'pending');
  assert.equal('state' in pendingStatus.json.oauth, false);
  assert.equal('codeVerifier' in pendingStatus.json.oauth, false);
  assert.equal('clientSecret' in pendingStatus.json.oauth, false);
  assert.equal(JSON.stringify(pendingStatus.json).includes(fakeClientSecret), false);

  // Bad state rejected with 400 and does not close valid callback listener
  const cbUrl = new URL(redirectUri);
  const badCb = await fetch(`http://127.0.0.1:${cbUrl.port}/auth/callback?state=wrong-state&code=fake`);
  assert.equal(badCb.status, 400);

  // Valid callback succeeds with strict static security headers
  const goodCb = await fetch(
    `http://127.0.0.1:${cbUrl.port}/auth/callback?state=${encodeURIComponent(stateParam)}&code=mock-auth-code-999`
  );
  assert.equal(goodCb.status, 200);
  assert.equal(goodCb.headers.get('content-security-policy'), "default-src 'none'; base-uri 'none'; form-action 'none'");
  assert.equal(goodCb.headers.get('x-frame-options'), 'DENY');
  assert.equal(goodCb.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(goodCb.headers.get('cache-control'), 'no-store');

  // Verify token exchange & userinfo calls
  assert.equal(tokenExchangeCalls.length, 1);
  assert.equal(tokenExchangeCalls[0].grant_type, 'authorization_code');
  assert.equal(tokenExchangeCalls[0].code, 'mock-auth-code-999');
  assert.ok(tokenExchangeCalls[0].code_verifier && tokenExchangeCalls[0].code_verifier.length >= 40);
  assert.equal(userInfoCalls[0], 'Bearer ya29.second-account-access-token');

  // Verify callback listener is closed after single use
  await new Promise((r) => setTimeout(r, 250));
  await assert.rejects(() => fetch(`http://127.0.0.1:${cbUrl.port}/auth/callback?state=${stateParam}&code=replay`));

  // Verify /api/oauth/status returns succeeded + updated 2-account vault, while active token file untouched
  const doneStatus = await postAuth('/api/oauth/status');
  assert.equal(doneStatus.status, 200);
  assert.equal(doneStatus.json.oauth.status, 'succeeded');
  assert.equal(doneStatus.json.oauth.maskedEmail, 'se***@example.com');
  assert.equal(doneStatus.json.accounts.length, 2);
  const firstAcc = doneStatus.json.accounts.find((a) => a.label === 'Main');
  const secondAcc = doneStatus.json.accounts.find((a) => a.label === 'Second');
  assert.equal(firstAcc.isActive, true);
  assert.equal(secondAcc.isActive, false);
  assert.equal(readFileSync(paths.tokenPath, 'utf8'), activeTokenRaw);

  // Start another OAuth flow and test cancel closes listener
  const start2 = await postAuth('/api/oauth/start', { label: 'Third' });
  const cbUrl2 = new URL(new URL(start2.json.oauth.authUrl).searchParams.get('redirect_uri'));
  const cancelRes = await postAuth('/api/oauth/cancel');
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.json.oauth.status, 'idle');
  await assert.rejects(() => fetch(`http://127.0.0.1:${cbUrl2.port}/auth/callback`));
});

test('OAuth token exchange 401 invalid_client renders distinct HTML, maps message, and writes safe switch.log', async (t) => {
  const { env, paths } = makeSandbox(t);
  const fakeClientId = '1071006060591-testclientid0002.apps.googleusercontent.com';
  const fakeClientSecret = `${SYNTH_SECRET_PREFIX}fakeTestSecret111111111111111111`;

  const srv = await createApp({
    sidecarSdk: await resolveSidecarSdkForTest(),
    env,
    port: 0,
    uiToken: 'oauth-fail-test-token',
    lsAddress: 'test.invalid',
    csrfToken: 'test-csrf',
    getUserStatus: async () => ({ lsConnected: false, email: '', tierName: '' }),
    oauthOptions: {
      loadClients: () => [{ id: fakeClientId, secret: fakeClientSecret }],
      openBrowser: () => ({ opened: false }),
      requestFn: async () => ({
        status: 401,
        json: {
          error: 'invalid_client',
          error_description: 'secret_details_should_not_leak',
        },
      }),
    },
  });

  const httpServer = await srv.start();
  t.after(async () => {
    await srv.close();
  });

  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  const postAuth = async (path, body = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sidecar-Token': 'oauth-fail-test-token',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    assert.equal(text.includes(fakeClientSecret), false);
    assert.equal(text.includes('mock-code-xyz'), false);
    assert.equal(text.includes('secret_details_should_not_leak'), false);
    return { status: res.status, json: JSON.parse(text) };
  };

  const startRes = await postAuth('/api/oauth/start', { label: 'FailCase' });
  const authUrl = new URL(startRes.json.oauth.authUrl);
  const redirectUri = new URL(authUrl.searchParams.get('redirect_uri'));
  const stateParam = authUrl.searchParams.get('state');

  const cbRes = await fetch(
    `http://127.0.0.1:${redirectUri.port}/auth/callback?state=${encodeURIComponent(stateParam)}&code=mock-code-xyz`
  );
  assert.equal(cbRes.status, 500);
  const cbHtml = await cbRes.text();
  assert.ok(cbHtml.includes('凭证换取失败'));
  assert.equal(cbHtml.includes('Google 登录未完成或被取消'), false);

  const statusRes = await postAuth('/api/oauth/status');
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.json.oauth.status, 'failed');
  assert.ok(statusRes.json.oauth.error.includes('invalid_client'));
  assert.ok(
    statusRes.json.logs.some((line) =>
      line.includes('OAUTH_ERR stage=token code=OAUTH_EXCHANGE_FAILED status=401 oauth_error=invalid_client')
    )
  );

  const logText = readFileSync(paths.logPath, 'utf8');
  assert.equal(logText.includes(fakeClientSecret), false);
  assert.equal(logText.includes('mock-code-xyz'), false);
  assert.equal(logText.includes('secret_details_should_not_leak'), false);
});

test('active-work helpers filter permanent MCP/sidecar children and detect active LS items without leaking args', () => {
  const lsPids = new Set([1000]);
  const ownPid = 2001;
  const procEntries = [
    {
      pid: ownPid,
      ppid: 1000,
      argv: ['/usr/local/bin/node', '--use-env-proxy', 'main.mjs'],
    },
    {
      pid: 2002,
      ppid: 1000,
      argv: ['/home/alice/.gemini/config/plugins/other/sidecars/ui/main.mjs'],
    },
    {
      pid: 2003,
      ppid: 1000,
      argv: ['npm', 'exec', '@modelcontextprotocol/server-everything', 'stdio'],
    },
    {
      pid: 2004,
      ppid: 1000,
      argv: ['npm', 'exec', 'mcp-remote', 'http://127.0.0.1:9924/mcp'],
    },
    {
      pid: 2005,
      ppid: 1000,
      argv: ['/init', '/mnt/c/Users/alice/.cua-driver/packages/current/cua-driver.exe', 'mcp'],
    },
    {
      pid: 2006,
      ppid: 1000,
      argv: ['/usr/bin/python3', '-c', 'SECRET_TOKEN=should_not_leak'],
    },
    {
      pid: 2007,
      ppid: 9999,
      argv: ['/bin/bash', '-c', 'unrelated parent'],
    },
  ];

  const foundProcs = findUserChildProcesses(procEntries, { lsPids, ownPid });
  assert.equal(foundProcs.length, 1);
  assert.equal(foundProcs[0].kind, 'process');
  assert.equal(foundProcs[0].pid, 2006);
  assert.equal(foundProcs[0].label, 'python3 (PID 2006)');
  assert.equal(foundProcs[0].label.includes('should_not_leak'), false);

  const lsItems = extractActiveItemsFromLs({
    trajectories: {
      trajectorySummaries: {
        idle1: { summary: 'Done chat', status: 'CASCADE_RUN_STATUS_IDLE' },
        run1: { summary: 'Running refactor', status: 'CASCADE_RUN_STATUS_RUNNING' },
        busy1: { summary: 'Busy task', status: 'CASCADE_RUN_STATUS_BUSY' },
      },
    },
    backgroundTasks: {
      tasks: [
        { summary: 'Old build', status: 'TASK_STATUS_COMPLETED' },
        { summary: 'Dev watcher', status: 'TASK_STATUS_IN_PROGRESS' },
      ],
    },
    terminals: {
      terminals: [
        { name: 'Closed shell', exited: true },
        { name: 'npm run dev', status: 'RUNNING' },
      ],
    },
  });

  assert.equal(lsItems.length, 4);
  assert.deepEqual(
    lsItems.map((x) => `${x.kind}:${x.label}`),
    [
      'cascade:Running refactor',
      'cascade:Busy task',
      'task:Dev watcher',
      'terminal:npm run dev',
    ]
  );
});

test('HTTP switch and new-login pause with 409 ACTIVE_WORK_RUNNING unless force=true is passed', async (t) => {
  const { env, paths } = makeSandbox(t);
  writeFileSync(paths.tokenPath, makeSampleToken('first@example.com', '1//refresh-first-guard-111'), {
    encoding: 'utf8',
    mode: 0o600,
  });
  const standby = importAccount(paths, {
    credentialText: makeSampleToken('second@example.com', '1//refresh-second-guard-222'),
    label: 'Standby',
  });

  let busy = true;
  const spawnedJobs = [];
  const srv = await createApp({
    sidecarSdk: await resolveSidecarSdkForTest(),
    env,
    port: 0,
    uiToken: 'guard-test-token',
    lsAddress: 'test.invalid',
    csrfToken: 'test-csrf',
    getUserStatus: async () => ({ lsConnected: true, email: 'first@example.com', tierName: 'Pro' }),
    detectActiveWork: async () =>
      busy
        ? {
            busy: true,
            count: 2,
            items: [
              { kind: 'cascade', label: 'Demo Task' },
              { kind: 'process', pid: 9999, label: 'python3 (PID 9999)' },
            ],
            truncated: false,
          }
        : { busy: false, count: 0, items: [], truncated: false },
    spawnWorker: (jobPath) => {
      spawnedJobs.push(jobPath);
    },
  });

  const httpServer = await srv.start();
  t.after(async () => {
    await srv.close();
  });

  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  const postAuth = async (path, body = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sidecar-Token': 'guard-test-token',
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  // Switch blocked when active work exists
  const blockedSwitch = await postAuth('/api/accounts/switch', { id: standby.id });
  assert.equal(blockedSwitch.status, 409);
  assert.equal(blockedSwitch.json.code, 'ACTIVE_WORK_RUNNING');
  assert.equal(blockedSwitch.json.activeWork.count, 2);
  assert.equal(spawnedJobs.length, 0);

  // Force switch bypasses guard and records audit log
  const forcedSwitch = await postAuth('/api/accounts/switch', { id: standby.id, force: true });
  assert.equal(forcedSwitch.status, 200);
  assert.equal(forcedSwitch.json.switching, true);
  assert.equal(spawnedJobs.length, 1);

  const logText = readFileSync(paths.logPath, 'utf8');
  assert.ok(logText.includes('FORCE_SWITCH_REQUESTED mode=switch'));

  // Re-check once idle succeeds without force (new-login path after switch lock expires)
  busy = false;
  const blockedWhenBusy = await postAuth('/api/accounts/new-login');
  // Hits active switchInProgress lock (409) without ACTIVE_WORK_RUNNING
  assert.equal(blockedWhenBusy.status, 409);
  assert.notEqual(blockedWhenBusy.json.code, 'ACTIVE_WORK_RUNNING');
});

test('switcher-worker helpers parse Windows tasklist CSV titles (including GBK 暂缺) and readRunInBackgroundSetting', (t) => {
  const { root } = makeSandbox(t);
  const gbkPlaceholder = Buffer.from([0xd4, 0xdd, 0xc8, 0xb1]);
  const csvBuf = Buffer.concat([
    Buffer.from('"Antigravity.exe","20028","Console","1","164,148 K","Running","WORKGROUP\\\\alice","0:00:09","Anti-Gravity 2.0"\r\n', 'latin1'),
    Buffer.from('"Antigravity.exe","8008","Console","1","172,128 K","Running","WORKGROUP\\\\alice","0:00:36","', 'latin1'),
    gbkPlaceholder,
    Buffer.from('"\r\n', 'latin1'),
    Buffer.from('"Antigravity.exe","26304","Console","1","65,440 K","Running","WORKGROUP\\\\alice","0:00:00","OleMainThreadWndName"\r\n', 'latin1'),
    Buffer.from('"Antigravity.exe","18960","Console","1","75,768 K","Unknown","WORKGROUP\\\\alice","0:00:00","N/A"\r\n', 'latin1'),
  ]);

  const parsedOpen = parseWindowsTasklistCsv(csvBuf);
  assert.equal(parsedOpen.totalCount, 4);
  assert.deepEqual(parsedOpen.visibleWindowPids, [20028]);

  const headlessOnlyBuf = Buffer.concat([
    Buffer.from('"Antigravity.exe","8008","Console","1","172,128 K","Running","WORKGROUP\\\\alice","0:00:36","', 'latin1'),
    gbkPlaceholder,
    Buffer.from('"\r\n', 'latin1'),
    Buffer.from('"Antigravity.exe","26304","Console","1","65,440 K","Running","WORKGROUP\\\\alice","0:00:00","OleMainThreadWndName"\r\n', 'latin1'),
    Buffer.from('"Antigravity.exe","18960","Console","1","75,768 K","Unknown","WORKGROUP\\\\alice","0:00:00","暂缺"\r\n', 'utf8'),
  ]);
  const parsedTray = parseWindowsTasklistCsv(headlessOnlyBuf);
  assert.equal(parsedTray.totalCount, 3);
  assert.deepEqual(parsedTray.visibleWindowPids, []);

  assert.equal(
    parseWindowsTasklistCsv(Buffer.from('信息: 没有运行的任务匹配指定标准。\r\n', 'utf8')).totalCount,
    0
  );

  const storagePath = join(root, 'app_storage.json');
  assert.equal(readRunInBackgroundSetting({ ANTIGRAVITY_APP_STORAGE_PATH: storagePath }), false);

  writeFileSync(storagePath, JSON.stringify({ runInBackground: 'true' }), 'utf8');
  assert.equal(readRunInBackgroundSetting({ ANTIGRAVITY_APP_STORAGE_PATH: storagePath }), true);

  writeFileSync(storagePath, JSON.stringify({ runInBackground: 'false' }), 'utf8');
  assert.equal(readRunInBackgroundSetting({ ANTIGRAVITY_APP_STORAGE_PATH: storagePath }), false);
});

test('active-work isInfrastructureProcess and parsePsOutput classify generic sidecars, MCP servers, and user work', () => {
  assert.equal(isInfrastructureProcess('node main.mjs'), true);
  assert.equal(isInfrastructureProcess('node --use-env-proxy main.mjs'), true);
  assert.equal(
    isInfrastructureProcess(
      '/usr/local/bin/node --import=file:///home/alice/.gemini/antigravity/lib/node_modules/sidecar_sdk/register_loader.js main.mjs'
    ),
    true
  );
  assert.equal(isInfrastructureProcess('node.exe main.mjs'), true);
  assert.equal(isInfrastructureProcess('C:\\Program Files\\nodejs\\node.exe main.mjs --port 9000'), true);
  assert.equal(isInfrastructureProcess('/home/alice/ext/sidecars/foo/main.mjs'), true);
  assert.equal(isInfrastructureProcess('C:\\Users\\alice\\ext\\sidecars\\foo\\main.mjs'), true);
  assert.equal(
    isInfrastructureProcess('/home/alice/.gemini/antigravity/plugin_data/gdrive/bin/gdrive-123456 context-provider'),
    true
  );
  assert.equal(
    isInfrastructureProcess('/opt/custom-daemon --serve', { cwd: '/home/alice/.gemini/config/plugins/gmail' }),
    true
  );
  assert.equal(isInfrastructureProcess('npm exec @modelcontextprotocol/server-everything stdio'), true);
  assert.equal(isInfrastructureProcess('uvx my-tool-mcp'), true);
  assert.equal(isInfrastructureProcess('python3 -m pkg.mcp_server --transport stdio'), true);
  assert.equal(isInfrastructureProcess('npx -y @acme/linear-mcp'), true);
  assert.equal(isInfrastructureProcess('mcp-proxy --port 8080'), true);
  assert.equal(isInfrastructureProcess('fastmcp run server.py'), true);

  assert.equal(isInfrastructureProcess('/usr/bin/python3 -m http.server'), false);
  assert.equal(isInfrastructureProcess('node build.mjs'), false);
  assert.equal(isInfrastructureProcess('node /home/alice/project/main.mjs'), false);
  assert.equal(
    isInfrastructureProcess('npm run dev', { cwd: '/home/alice/project/sidecars/switcher' }),
    false
  );

  const psText = [
    '  100   1 /Applications/Antigravity.app/Contents/Resources/bin/language_server --port 1234',
    '  200   1 /home/alice/.antigravity-server/bin/2.32.1/language_server --port 5678',
    '  101 100 node main.mjs',
    '  102 100 node.exe main.mjs',
    '  103 100 /usr/local/bin/node /home/alice/plugins/demo/sidecars/foo/main.mjs',
    '  104 100 /usr/local/bin/node --use-env-proxy main.mjs',
    '  105 100 /usr/bin/python3 -c SECRET_ARG=nope',
    '  201 200 /bin/bash -c cargo test --secret=abc',
    '  202 200 npx mcp-remote http://127.0.0.1:8080/mcp',
    '  203 200 /usr/local/bin/node --import=file:///tmp/register_loader.js main.mjs',
    '  204 200 uvx some-custom-mcp',
  ].join('\n');

  const detected = parsePsOutput(psText, 104);
  assert.deepEqual(detected, [
    { kind: 'process', pid: 105, label: 'python3 (PID 105)' },
    { kind: 'process', pid: 201, label: 'bash (PID 201)' },
  ]);
});

test('active-work findUserChildProcesses uses cwd to filter plugin daemons while preserving real user child work', () => {
  const detected = findUserChildProcesses(
    [
      {
        pid: 301,
        ppid: 200,
        argv: ['/home/alice/.gemini/antigravity/plugin_data/gdrive/bin/gdrive-123456', 'context-provider'],
        cwd: '/home/alice/.gemini/config/plugins/gdrive',
      },
      {
        pid: 302,
        ppid: 200,
        argv: ['/usr/local/bin/node', '--import=file:///home/alice/.gemini/antigravity/lib/node_modules/sidecar_sdk/register_loader.js', 'main.mjs'],
        cwd: '/home/alice/.gemini/antigravity/builtin/plugins/swarm/sidecars/swarm_board',
      },
      {
        pid: 303,
        ppid: 200,
        argv: ['/opt/helper', '--daemon'],
        cwd: '/home/alice/.gemini/config/plugins/custom-plugin',
      },
      {
        pid: 304,
        ppid: 200,
        argv: ['/bin/bash', '-c', 'cargo test'],
        cwd: '/home/alice/project/sidecars/switcher',
      },
      {
        pid: 305,
        ppid: 200,
        argv: ['/usr/bin/python3', '-m', 'http.server'],
        cwd: '/home/alice/project',
      },
    ],
    { lsPids: [200], ownPid: 999 }
  );

  assert.deepEqual(detected, [
    { kind: 'process', pid: 304, label: 'bash (PID 304)' },
    { kind: 'process', pid: 305, label: 'python3 (PID 305)' },
  ]);
});

test('platform helpers handle runtime detection, path conversion, app_storage defaults, and candidate discovery', (t) => {
  const { root } = makeSandbox(t);

  assert.equal(detectRuntime({}, { platform: 'win32' }), 'win32');
  assert.equal(detectRuntime({}, { platform: 'darwin' }), 'darwin');
  assert.equal(detectRuntime({ WSL_DISTRO_NAME: 'Ubuntu' }, { platform: 'linux', procVersion: '' }), 'wsl');
  assert.equal(detectRuntime({ WSL_INTEROP: '/run/WSL/1_interop' }, { platform: 'linux', procVersion: '' }), 'wsl');
  assert.equal(
    detectRuntime({}, { platform: 'linux', procVersion: 'Linux version 5.15.0-microsoft-standard-WSL2' }),
    'wsl'
  );
  assert.equal(detectRuntime({}, { platform: 'linux', procVersion: 'Linux version 6.8.0-generic' }), 'linux');

  assert.equal(winPathToWslPath('C:\\Users\\alice\\AppData\\Local'), '/mnt/c/Users/alice/AppData/Local');
  assert.equal(winPathToWslPath('D:/work/repo'), '/mnt/d/work/repo');
  assert.equal(winPathToWslPath('C:\\'), '/mnt/c');
  assert.equal(winPathToWslPath('/already/unix'), '/already/unix');

  assert.equal(wslPathToWinPath('/mnt/c/Users/alice/AppData/Roaming'), 'C:\\Users\\alice\\AppData\\Roaming');
  assert.equal(wslPathToWinPath('/mnt/d'), 'D:\\');
  assert.equal(wslPathToWinPath('/home/alice'), '/home/alice');

  const overridePath = join(root, 'custom_app_storage.json');
  assert.equal(resolveAppStoragePath({ ANTIGRAVITY_APP_STORAGE_PATH: overridePath }, 'linux'), overridePath);
  assert.equal(
    resolveAppStoragePath({ APPDATA: join(root, 'WinAppData') }, 'win32'),
    join(root, 'WinAppData', 'Antigravity', 'app_storage.json')
  );
  assert.equal(
    resolveAppStoragePath(
      {
        ANTIGRAVITY_WIN_APPDATA: '/mnt/c/Users/alice/AppData/Roaming',
        ANTIGRAVITY_WIN_LOCALAPPDATA: '/mnt/c/Users/alice/AppData/Local',
      },
      'wsl'
    ),
    '/mnt/c/Users/alice/AppData/Roaming/Antigravity/app_storage.json'
  );
  assert.equal(
    resolveAppStoragePath({ PATH: '/usr/bin:/mnt/c/Users/alice/AppData/Local/Microsoft/WindowsApps' }, 'wsl'),
    '/mnt/c/Users/alice/AppData/Roaming/Antigravity/app_storage.json'
  );
  assert.equal(
    resolveAppStoragePath({ XDG_CONFIG_HOME: join(root, 'xdg') }, 'linux'),
    join(root, 'xdg', 'Antigravity', 'app_storage.json')
  );
  assert.ok(
    resolveAppStoragePath({}, 'darwin').endsWith(
      join('Library', 'Application Support', 'Antigravity', 'app_storage.json')
    )
  );

  // readRunInBackgroundSetting defaults and symlink/corrupt guards
  const missingStorage = join(root, 'missing_storage.json');
  assert.equal(readRunInBackgroundSetting({ ANTIGRAVITY_APP_STORAGE_PATH: missingStorage }, 'darwin'), true);
  assert.equal(readRunInBackgroundSetting({ ANTIGRAVITY_APP_STORAGE_PATH: missingStorage }, 'win32'), false);
  assert.equal(readRunInBackgroundSetting({ ANTIGRAVITY_APP_STORAGE_PATH: missingStorage }, 'linux'), false);

  const badJsonStorage = join(root, 'bad_storage.json');
  writeFileSync(badJsonStorage, '{not-json', 'utf8');
  assert.equal(readRunInBackgroundSetting({ ANTIGRAVITY_APP_STORAGE_PATH: badJsonStorage }, 'darwin'), true);
  assert.equal(readRunInBackgroundSetting({ ANTIGRAVITY_APP_STORAGE_PATH: badJsonStorage }, 'linux'), false);

  const realStorage = join(root, 'real_storage.json');
  writeFileSync(realStorage, JSON.stringify({ runInBackground: true }), 'utf8');
  assert.equal(readRunInBackgroundSetting({ ANTIGRAVITY_APP_STORAGE_PATH: realStorage }, 'linux'), true);

  if (process.platform !== 'win32') {
    const linkStorage = join(root, 'link_storage.json');
    symlinkSync(realStorage, linkStorage);
    assert.equal(readRunInBackgroundSetting({ ANTIGRAVITY_APP_STORAGE_PATH: linkStorage }, 'linux'), false);
  }

  // resolveLanguageServerCandidates: regular override vs symlink rejection, plus win32/wsl discovery
  const fakeAgentExe = join(root, 'custom_ls');
  writeFileSync(fakeAgentExe, 'binary', 'utf8');
  const winLocal = join(root, 'win-local');
  const winLsExe = join(winLocal, 'Programs', 'Antigravity', 'resources', 'bin', 'language_server.exe');
  mkdirSync(dirname(winLsExe), { recursive: true });
  writeFileSync(winLsExe, 'pe', 'utf8');

  const winCands = resolveLanguageServerCandidates(
    {
      ANTIGRAVITY_AGENTAPI_EXE: fakeAgentExe,
      LOCALAPPDATA: winLocal,
      ProgramFiles: join(root, 'pf-empty'),
    },
    'win32'
  );
  assert.deepEqual(winCands, [fakeAgentExe, winLsExe]);

  if (process.platform !== 'win32') {
    const linkExe = join(root, 'link_ls');
    symlinkSync(fakeAgentExe, linkExe);
    const linkCands = resolveLanguageServerCandidates(
      {
        ANTIGRAVITY_AGENTAPI_EXE: linkExe,
        LOCALAPPDATA: winLocal,
        ProgramFiles: join(root, 'pf-empty'),
      },
      'win32'
    );
    assert.deepEqual(linkCands, [winLsExe]);
  }

  if (process.platform === 'linux') {
    const wslCands = resolveLanguageServerCandidates(
      {
        ANTIGRAVITY_WIN_APPDATA: join(root, 'win-roaming'),
        ANTIGRAVITY_WIN_LOCALAPPDATA: winLocal,
      },
      'wsl'
    );
    assert.ok(wslCands.includes(winLsExe));
  }
});

test('token-store: OS keyring & Windows cmdkey routing, cmdkey invocation, and macOS decoding', () => {
  assert.equal(shouldUseOsKeyring({ useKeyring: false }, {}, 'darwin'), false);
  assert.equal(shouldUseOsKeyring({ useKeyring: true }, { SWITCHER_TOKEN_STORE: 'file' }, 'darwin'), false);
  assert.equal(shouldUseOsKeyring({ useKeyring: true }, {}, 'wsl'), false);
  assert.equal(shouldUseOsKeyring({ useKeyring: true }, {}, 'win32'), false);
  assert.equal(shouldUseOsKeyring({ useKeyring: true }, {}, 'darwin'), true);
  assert.equal(shouldUseOsKeyring({ useKeyring: true }, {}, 'linux'), false);
  assert.equal(
    shouldUseOsKeyring({ useKeyring: true }, { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }, 'linux'),
    true
  );

  assert.equal(shouldClearWindowsKeyring({ useKeyring: true }, {}, 'win32'), true);
  assert.equal(shouldClearWindowsKeyring({ useKeyring: false }, {}, 'win32'), false);
  assert.equal(shouldClearWindowsKeyring({ useKeyring: true }, { SWITCHER_TOKEN_STORE: 'file' }, 'win32'), false);
  assert.equal(shouldClearWindowsKeyring({ useKeyring: true }, {}, 'wsl'), false);
  assert.equal(shouldClearWindowsKeyring({ useKeyring: true }, {}, 'darwin'), false);

  // resolvePaths disables OS keyring / cmdkey when isolated in tests or custom tokenPath/geminiDir
  assert.equal(resolvePaths({ ANTIGRAVITY_GEMINI_DIR: '/tmp/custom-gem' }).useKeyring, false);
  assert.equal(resolvePaths({}, { tokenPath: '/tmp/custom-token' }).useKeyring, false);
  assert.equal(resolvePaths({ SWITCHER_TOKEN_STORE: 'file' }).useKeyring, false);

  assert.equal(KEYRING_SERVICE, 'gemini');
  assert.equal(KEYRING_USER, 'antigravity');
  assert.equal(WIN_CRED_TARGET, 'gemini:antigravity');
  assert.equal(WIN_CRED_TARGET_LEGACY, 'LegacyGeneric:target=gemini:antigravity');

  // clearWindowsKeyringEntry tries LegacyGeneric:target=gemini:antigravity first, then gemini:antigravity fallback without PowerShell
  const cmdCalls = [];
  const clearedOk = clearWindowsKeyringEntry(
    { SystemRoot: 'C:\\Windows' },
    {
      execFn: (bin, args, opts) => {
        cmdCalls.push({ bin, args, opts });
      },
    }
  );
  assert.equal(clearedOk, true);
  assert.equal(cmdCalls.length, 1);
  assert.equal(cmdCalls[0].bin, join('C:\\Windows', 'System32', 'cmdkey.exe'));
  assert.deepEqual(cmdCalls[0].args, [`/delete:${WIN_CRED_TARGET_LEGACY}`]);
  assert.equal(cmdCalls[0].opts.windowsHide, true);

  const fallbackCalls = [];
  const clearedFallback = clearWindowsKeyringEntry(
    { SystemRoot: 'C:\\Windows' },
    {
      execFn: (bin, args, opts) => {
        fallbackCalls.push({ bin, args, opts });
        if (args[0] === `/delete:${WIN_CRED_TARGET_LEGACY}`) {
          throw new Error('Element not found');
        }
      },
    }
  );
  assert.equal(clearedFallback, true);
  assert.equal(fallbackCalls.length, 2);
  assert.deepEqual(fallbackCalls[0].args, [`/delete:${WIN_CRED_TARGET_LEGACY}`]);
  assert.deepEqual(fallbackCalls[1].args, [`/delete:${WIN_CRED_TARGET}`]);

  const missCalls = [];
  const clearedMiss = clearWindowsKeyringEntry(
    { SystemRoot: 'C:\\Windows' },
    {
      execFn: (bin, args) => {
        missCalls.push({ bin, args });
        throw new Error('Element not found');
      },
    }
  );
  assert.equal(clearedMiss, false);
  assert.equal(missCalls.length, 2);

  // macOS Keychain secret decoding: raw JSON, go-keyring-base64, hex-encoded JSON & hex-encoded base64
  assert.equal(decodeMacKeychainSecret('  {"a":1} \n'), '{"a":1}');
  const b64Payload = `go-keyring-base64:${Buffer.from('{"k":"v"}', 'utf8').toString('base64')}`;
  assert.equal(decodeMacKeychainSecret(b64Payload), '{"k":"v"}');
  assert.equal(decodeMacKeychainSecret(Buffer.from('{"hex":true}', 'utf8').toString('hex')), '{"hex":true}');
  assert.equal(decodeMacKeychainSecret(Buffer.from(b64Payload, 'utf8').toString('hex')), '{"k":"v"}');
});

test('token-store: Windows cmdkey clear + file handoff and Darwin/Linux keyring composite behavior', (t) => {
  const { root } = makeSandbox(t);
  const paths = {
    tokenPath: join(root, 'standalone-token'),
    dataDir: join(root, 'store-data'),
    useKeyring: true,
  };

  // Win32: read directly from file (zero subprocesses); write clears cmdkey & writes file; remove clears both
  let winClearCalls = 0;
  const winToken = makeSampleToken('win-user@example.com', '1//win-refresh-000');
  const wWin = writeActiveTokenRaw(paths, winToken, {}, { runtime: 'win32', winKeyringClear: () => ++winClearCalls > 0 });
  assert.deepEqual(wWin, { target: 'file', keyringCleared: true });
  assert.equal(winClearCalls, 1);
  const rWin = readActiveTokenRaw(paths, {}, { runtime: 'win32' });
  assert.equal(rWin.present, true);
  assert.equal(rWin.source, 'file');
  assert.equal(rWin.raw, winToken);
  const rmWin = removeActiveTokenRaw(paths, {}, { runtime: 'win32', winKeyringClear: () => ++winClearCalls > 0 });
  assert.deepEqual(rmWin, { keyringRemoved: true, fileRemoved: true });
  assert.equal(winClearCalls, 2);
  assert.equal(existsSync(paths.tokenPath), false);

  // Darwin / Linux D-Bus: keyring priority, stale file cleanup, write fallback + clear, removal
  let keyringValue = makeSampleToken('kr-user@example.com', '1//kr-refresh-111');
  let failWrite = false;
  const backend = {
    read: () => keyringValue,
    write: (val) => {
      if (failWrite) throw new Error('KEYRING_WRITE_ERR');
      keyringValue = val;
    },
    remove: () => {
      const had = Boolean(keyringValue);
      keyringValue = '';
      return had;
    },
  };

  writeFileSync(paths.tokenPath, makeSampleToken('file-stale@example.com', '1//stale-file-222'), 'utf8');
  const rMac = readActiveTokenRaw(paths, {}, { runtime: 'darwin', keyringBackend: backend });
  assert.equal(rMac.present, true);
  assert.equal(rMac.source, 'keyring');
  assert.ok(rMac.raw.includes('kr-user@example.com'));

  const nextToken = makeSampleToken('next@example.com', '1//next-refresh-333');
  const wMac = writeActiveTokenRaw(paths, nextToken, {}, { runtime: 'darwin', keyringBackend: backend });
  assert.deepEqual(wMac, { target: 'keyring', keyringCleared: false });
  assert.equal(existsSync(paths.tokenPath), false);
  assert.equal(keyringValue, nextToken);

  failWrite = true;
  const fallbackToken = makeSampleToken('fallback@example.com', '1//fallback-444');
  const wLinux = writeActiveTokenRaw(
    paths,
    fallbackToken,
    { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
    { runtime: 'linux', keyringBackend: backend }
  );
  assert.deepEqual(wLinux, { target: 'file', keyringCleared: true });
  assert.equal(keyringValue, '');
  const rLinux = readActiveTokenRaw(
    paths,
    { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
    { runtime: 'linux', keyringBackend: backend }
  );
  assert.equal(rLinux.source, 'file');
  assert.equal(rLinux.raw, fallbackToken);

  failWrite = false;
  keyringValue = makeSampleToken('both@example.com', '1//both-555');
  const rmMac = removeActiveTokenRaw(paths, {}, { runtime: 'darwin', keyringBackend: backend });
  assert.deepEqual(rmMac, { keyringRemoved: true, fileRemoved: true });
  assert.equal(keyringValue, '');
  assert.equal(existsSync(paths.tokenPath), false);
});

test('switcher-worker --detach-worker double-fork DRY_RUN and runWorker with dataDirArg + job.context', async (t) => {
  const { geminiDir, dataDir, paths } = makeSandbox(t);

  // Part A: Double-fork --detach-worker trampoline spawns detached grandchild, exits 0 immediately, grandchild finishes DRY_RUN switch
  const tokenDetach = makeSampleToken('detach-user@example.com', '1//refresh-detach-777');
  const importedDetach = importAccount(paths, { credentialText: tokenDetach, label: 'Detach Account' });
  const detachJob = prepareSwitchJob(paths, {
    mode: 'switch',
    accountId: importedDetach.id,
    context: { geminiDir },
  });
  assert.ok(existsSync(detachJob.jobPath));

  await execFileAsync(NODE_BIN, [WORKER_PATH, '--detach-worker', detachJob.jobPath, dataDir], {
    env: {
      ...process.env,
      SWITCHER_DRY_RUN: '1',
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: '',
      ANTIGRAVITY_GEMINI_DIR: '',
    },
  });

  const deadline = Date.now() + 4000;
  let detachDone = false;
  while (Date.now() < deadline) {
    if (
      !existsSync(detachJob.jobPath) &&
      existsSync(paths.logPath) &&
      readFileSync(paths.logPath, 'utf8').includes('DONE mode=switch DRY_RUN')
    ) {
      detachDone = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(detachDone, true);
  const afterDetach = readActiveToken(paths);
  assert.equal(afterDetach.present, true);
  assert.equal(afterDetach.email, 'detach-user@example.com');

  // Part B: Direct runWorker using dataDirArg + job.context WITHOUT ANTIGRAVITY_EXECUTABLE_DATA_DIR or ANTIGRAVITY_GEMINI_DIR
  const tokenC = makeSampleToken('ctx-user@example.com', '1//refresh-ctx-999');
  const importedC = importAccount(paths, { credentialText: tokenC, label: 'Context Account' });
  const ctxJob = prepareSwitchJob(paths, {
    mode: 'switch',
    accountId: importedC.id,
    context: { geminiDir },
  });
  assert.ok(existsSync(ctxJob.jobPath));

  await runWorker(
    ctxJob.jobPath,
    {
      ...process.env,
      SWITCHER_DRY_RUN: '1',
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: '',
      ANTIGRAVITY_GEMINI_DIR: '',
    },
    dataDir
  );

  assert.equal(existsSync(ctxJob.jobPath), false);
  const written = readActiveToken(paths);
  assert.equal(written.present, true);
  assert.equal(written.email, 'ctx-user@example.com');
  const logText = readFileSync(paths.logPath, 'utf8');
  assert.ok(logText.includes('store=file keyringCleared='));
});

test('win32 shutdown helpers resolve tasklist/taskkill paths via path.join and complete cleanly without ReferenceError', async (t) => {
  const { root, paths } = makeSandbox(t);

  const winExecs = resolveWindowsTaskExecutables({ SystemRoot: 'C:\\Windows' }, 'win32');
  assert.equal(winExecs.tasklistExe, join('C:\\Windows', 'System32', 'tasklist.exe'));
  assert.equal(winExecs.taskkillExe, join('C:\\Windows', 'System32', 'taskkill.exe'));

  const wslExecs = resolveWindowsTaskExecutables(
    {
      ANTIGRAVITY_WIN_APPDATA: '/mnt/c/Users/alice/AppData/Roaming',
      ANTIGRAVITY_WIN_LOCALAPPDATA: '/mnt/c/Users/alice/AppData/Local',
    },
    'wsl'
  );
  assert.equal(wslExecs.tasklistExe, '/mnt/c/Windows/System32/tasklist.exe');
  assert.equal(wslExecs.taskkillExe, '/mnt/c/Windows/System32/taskkill.exe');

  await stopWindowsOrWslAntigravity(
    paths,
    {
      SystemRoot: join(root, 'empty-win'),
      APPDATA: join(root, 'empty-appdata'),
    },
    'win32'
  );

  const logText = readFileSync(paths.logPath, 'utf8');
  assert.ok(logText.includes('LS_WAIT_DONE remaining=0'));
});

test('win32 worker excludes self PID under ELECTRON_RUN_AS_NODE, kills via /PID batches, and buildRelaunchEnv strips Electron-as-Node env vars', () => {
  const csvBuf = Buffer.from(
    [
      '"Antigravity.exe","20028","Console","1","164,148 K","Running","WORKGROUP\\\\alice","0:00:09","Anti-Gravity 2.0"',
      '"Antigravity.exe","8008","Console","1","25,000 K","Running","WORKGROUP\\\\alice","0:00:01","N/A"',
      '"Antigravity.exe","26304","Console","1","65,440 K","Running","WORKGROUP\\\\alice","0:00:00","OleMainThreadWndName"',
    ].join('\r\n') + '\r\n',
    'latin1'
  );

  const filtered = parseWindowsTasklistCsv(csvBuf, { excludePids: [20028, 8008] });
  assert.equal(filtered.totalCount, 1);
  assert.deepEqual(filtered.pids, [26304]);
  assert.deepEqual(filtered.visibleWindowPids, []);

  const batches = buildWindowsForceKillArgBatches([101, 202, 101, 303, 404, -1, 0], {
    selfPid: 202,
    chunkSize: 2,
  });
  assert.deepEqual(batches, [
    ['/F', '/PID', '101', '/PID', '303'],
    ['/F', '/PID', '404'],
  ]);
  for (const args of batches) {
    assert.equal(args.includes('/IM'), false);
    assert.equal(args.includes('/T'), false);
    assert.equal(args.includes('202'), false);
  }

  const cleanEnv = buildRelaunchEnv({
    ELECTRON_RUN_AS_NODE: '1',
    Electron_Run_As_Node: '1',
    ANTIGRAVITY_SIDECAR_UI_TOKEN: 'tok',
    ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1234',
    ANTIGRAVITY_CSRF_TOKEN: 'csrf',
    ANTIGRAVITY_SIDECAR_ID: 'antigravity-account-switcher/switcher',
    ANTIGRAVITY_SIDECAR_WEB_PORT: '9999',
    ANTIGRAVITY_SIDECAR_GATEWAY_URL: 'http://127.0.0.1:9998',
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: '/tmp/data',
    ANTIGRAVITY_AGENTAPI_EXE: '/tmp/ls',
    ANTIGRAVITY_APP_DATA_DIR: '/tmp/appdata',
    PATH: '/usr/bin',
    HTTPS_PROXY: 'http://127.0.0.1:8080',
    EMPTY_UNDEF: undefined,
  });
  assert.deepEqual(cleanEnv, {
    PATH: '/usr/bin',
    HTTPS_PROXY: 'http://127.0.0.1:8080',
  });
});

test('sanitizeActiveState prefers live connected LS email over stale local token file', () => {
  const staleActive = {
    present: true,
    valid: true,
    source: 'file',
    email: 'stale@example.com',
    expiry: '2026-11-20T00:17:54Z',
    hasRefreshToken: true,
  };

  // Connected LS email differs from stale file -> prefer LS identity & mask file mismatch as keyring
  const liveConnected = sanitizeActiveState(
    staleActive,
    { lsConnected: true, email: 'live@example.com', tierName: 'Google AI Pro' },
    { revealEmail: true }
  );
  assert.equal(liveConnected.maskedEmail, 'li***@example.com');
  assert.equal(liveConnected.email, 'live@example.com');
  assert.equal(liveConnected.present, false);
  assert.equal(liveConnected.valid, false);
  assert.equal(liveConnected.source, 'keyring');
  assert.equal(liveConnected.expiry, '');
  assert.equal(liveConnected.hasRefreshToken, false);
  assert.equal(liveConnected.lsConnected, true);

  // Disconnected LS or matching email -> preserve local file metadata
  const offlineFallback = sanitizeActiveState(
    staleActive,
    { lsConnected: false, email: 'live@example.com', tierName: '' },
    { revealEmail: true }
  );
  assert.equal(offlineFallback.maskedEmail, 'st***@example.com');
  assert.equal(offlineFallback.email, 'stale@example.com');
  assert.equal(offlineFallback.present, true);
  assert.equal(offlineFallback.valid, true);
  assert.equal(offlineFallback.source, 'file');
  assert.equal(offlineFallback.expiry, '2026-11-20T00:17:54Z');

  const matched = sanitizeActiveState(
    staleActive,
    { lsConnected: true, email: 'stale@example.com', tierName: 'Google AI Pro' },
    { revealEmail: true }
  );
  assert.equal(matched.maskedEmail, 'st***@example.com');
  assert.equal(matched.present, true);
  assert.equal(matched.valid, true);
  assert.equal(matched.source, 'file');
  assert.equal(matched.expiry, '2026-11-20T00:17:54Z');
});

test('syncActiveAccountTier persists tierName, pins active account first, and UI removes redundant active-account card and source text', async (t) => {
  const { env, paths } = makeSandbox(t);

  // Import alpha first, then beta; when beta is active, listPublicAccounts pins beta first with live tierName
  const alpha = importAccount(paths, {
    credentialText: makeSampleToken('alpha@example.com', '1//refresh-alpha-tier-1'),
    label: 'Alpha',
  });
  const beta = importAccount(paths, {
    credentialText: makeSampleToken('beta@example.com', '1//refresh-beta-tier-2'),
    label: 'Beta',
  });

  // Persist tier on alpha via syncActiveAccountTier; repeated sync with identical tier returns false
  assert.equal(syncActiveAccountTier(paths, { email: 'alpha@example.com', tierName: 'Google AI Pro' }), true);
  assert.equal(syncActiveAccountTier(paths, { email: 'alpha@example.com', tierName: 'Google AI Pro' }), false);
  assert.equal(syncActiveAccountTier(paths, { email: 'unknown@example.com', tierName: 'Free' }), false);

  writeFileSync(paths.tokenPath, makeSampleToken('beta@example.com', '1//refresh-beta-tier-2'), {
    encoding: 'utf8',
    mode: 0o600,
  });

  const srv = await createApp({
    sidecarSdk: await resolveSidecarSdkForTest(),
    env,
    port: 0,
    uiToken: 'tier-ui-token',
    lsAddress: 'test.invalid',
    csrfToken: 'test-csrf',
    getUserStatus: async () => ({
      lsConnected: true,
      email: 'beta@example.com',
      tierName: 'Google AI Ultra',
    }),
  });

  const httpServer = await srv.start();
  t.after(async () => {
    await srv.close();
  });

  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  const stateRes = await fetch(`${baseUrl}/api/state`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sidecar-Token': 'tier-ui-token',
    },
    body: '{}',
  });
  assert.equal(stateRes.status, 200);
  const payload = await stateRes.json();
  assert.equal(payload.accounts.length, 2);
  assert.equal(payload.accounts[0].id, beta.id);
  assert.equal(payload.accounts[0].isActive, true);
  assert.equal(payload.accounts[0].tierName, 'Google AI Ultra');
  assert.equal(payload.accounts[1].id, alpha.id);
  assert.equal(payload.accounts[1].isActive, false);
  assert.equal(payload.accounts[1].tierName, 'Google AI Pro');

  // Verify static UI bundle satisfies CSP + removes redundant active-account card & credential source label
  const htmlRes = await fetch(`${baseUrl}/`);
  assert.equal(htmlRes.status, 200);
  const html = await htmlRes.text();
  assert.equal(html.includes('当前登录账号'), false);
  assert.equal(html.includes('凭据源'), false);
  assert.equal(html.includes('style='), false);
  assert.equal(html.includes('import-form'), false);
  assert.equal(html.includes('手动导入'), false);

  const cssRes = await fetch(`${baseUrl}/styles.css`);
  assert.equal(cssRes.status, 200);
  const jsRes = await fetch(`${baseUrl}/app.js`);
  assert.equal(jsRes.status, 200);
  const js = await jsRes.text();
  assert.equal(js.includes('凭据源'), false);
  assert.equal(js.includes('Token 过期'), false);
  assert.equal(js.includes('/api/accounts/import'), false);
  assert.equal(js.includes('innerHTML'), false);
  assert.equal(js.includes('style='), false);
  assert.equal(/\.style\./.test(js), false);
  assert.ok(js.includes('createUsageCardNode'));
  assert.ok(js.includes('查看用量'));
  assert.ok(js.includes('View usage'));
  assert.ok(js.includes('USAGE_EXPAND_REFRESH_MS = 10_000'));
  assert.ok(js.includes('usageLastFetchAt'));
  assert.ok(js.includes('forceRefresh: !isInitialExpand'));
  assert.ok(!js.includes('USAGE_AUTO_REFRESH_MS'));
});

test('cloudcode helpers extract profile, normalize quota summaries, handle fallback, and refresh expired tokens', async () => {
  assert.equal(mapCloudCodePlatform('darwin', 'arm64'), 'DARWIN_ARM64');
  assert.equal(mapCloudCodePlatform('darwin', 'x64'), 'DARWIN_AMD64');
  assert.equal(mapCloudCodePlatform('win32', 'x64'), 'WINDOWS_AMD64');
  assert.equal(mapCloudCodePlatform('linux', 'arm64'), 'LINUX_ARM64');
  assert.equal(mapCloudCodePlatform('linux', 'x64'), 'LINUX_AMD64');

  // paidTier takes priority over currentTier; falls back cleanly to currentTier
  assert.deepEqual(
    extractCloudCodeProfile({
      currentTier: { name: 'Free' },
      paidTier: { name: 'Google AI Pro', description: 'Pro' },
      cloudaicompanionProject: { id: 'proj-abc-123' },
    }),
    { tierName: 'Google AI Pro', projectId: 'proj-abc-123' }
  );
  assert.deepEqual(
    extractCloudCodeProfile({
      currentTier: { description: 'Standard Tier' },
      cloudaicompanionProject: 'string-proj-id\n../evil',
    }),
    { tierName: 'Standard Tier', projectId: '' }
  );
  assert.deepEqual(
    extractCloudCodeProfile({
      currentTier: { name: 'Standard Tier' },
      cloudaicompanionProject: 'projects/my-proj/locations/global',
    }),
    { tierName: 'Standard Tier', projectId: 'projects/my-proj/locations/global' }
  );
  assert.deepEqual(extractCloudCodeProfile(null), { tierName: '', projectId: '' });

  // normalizeQuotaSummary unwraps LS { response }, clamps numbers, drops invalid resetTime, and falls back to flat buckets
  const wrapped = normalizeQuotaSummary({
    response: {
      description: 'Quota\ndesc',
      groups: [
        {
          displayName: 'Gemini\tModels',
          description: 'Gemini 4',
          buckets: [
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly Limit Remaining',
              window: 'WEEKLY',
              remainingFraction: 1.4,
              resetTime: '2026-11-25T03:00:02Z',
            },
            {
              bucketId: 'gemini-5h',
              window: '5h',
              remainingFraction: -0.2,
              resetTime: 'not-a-date',
            },
          ],
        },
      ],
    },
  });
  assert.equal(wrapped.description, 'Quota desc');
  assert.equal(wrapped.groups.length, 1);
  assert.equal(wrapped.groups[0].displayName, 'Gemini Models');
  assert.equal(wrapped.groups[0].buckets[0].window, 'weekly');
  assert.equal(wrapped.groups[0].buckets[0].remainingFraction, 1);
  assert.equal(wrapped.groups[0].buckets[0].resetTime, '2026-11-25T03:00:02Z');
  assert.equal(wrapped.groups[0].buckets[1].remainingFraction, 0);
  assert.equal(wrapped.groups[0].buckets[1].resetTime, '');

  const flat = normalizeQuotaSummary({
    buckets: [{ bucketId: 'b1', window: 'weekly', remainingFraction: 0.5 }],
  });
  assert.equal(flat.groups.length, 1);
  assert.equal(flat.groups[0].displayName, 'Models');
  assert.equal(flat.groups[0].buckets[0].remainingFraction, 0.5);

  // postCloudCodeJson retries on fallback endpoint on HTTP 500 or 404
  const seenUrls = [];
  const resFallback = await postCloudCodeJson(
    '/v1internal:loadCodeAssist',
    'tok-1',
    { test: true },
    {
      requestFn: async (url, opts) => {
        seenUrls.push({ url, ua: opts.headers['User-Agent'] });
        if (url.startsWith(DEFAULT_CLOUD_CODE_ENDPOINT)) {
          return { status: 503, json: { error: 'busy' } };
        }
        return { status: 200, json: { ok: true } };
      },
    }
  );
  assert.equal(resFallback.status, 200);
  assert.equal(seenUrls.length, 2);
  assert.equal(seenUrls[0].url, `${DEFAULT_CLOUD_CODE_ENDPOINT}/v1internal:loadCodeAssist`);
  assert.equal(seenUrls[1].url, `${FALLBACK_CLOUD_CODE_ENDPOINT}/v1internal:loadCodeAssist`);
  assert.match(
    seenUrls[0].ua,
    /^antigravity\/hub\/\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)? \(os_type=(?:linux|darwin|windows); arch=[a-z0-9_]+; auth_method=consumer; purpose=aidev_client\)$/
  );
  assert.equal(
    buildCloudCodeUserAgent({ version: '2.35.0', platform: 'win32', arch: 'x64' }),
    'antigravity/hub/2.35.0 (os_type=windows; arch=amd64; auth_method=consumer; purpose=aidev_client)'
  );
  assert.equal(
    buildCloudCodeUserAgent({ version: 'invalid\r\nheader', platform: 'darwin', arch: 'arm64' }),
    'antigravity/hub/2.32.1 (os_type=darwin; arch=arm64; auth_method=consumer; purpose=aidev_client)'
  );
  assert.equal(
    resolveAntigravityVersion({}, { candidates: ['/home/u/.antigravity-server/bin/2.99.1/language_server'] }),
    '2.99.1'
  );
  assert.equal(resolveAntigravityVersion({ ANTIGRAVITY_IDE_VERSION: '3.1.0' }, { candidates: [] }), '3.1.0');
  assert.equal(resolveAntigravityVersion({}, { candidates: [] }), '2.32.1');

  // ensureFreshAccessToken skips HTTP for valid unexpired tokens
  const nowMs = Date.parse('2026-11-20T00:00:00Z');
  const freshToken = JSON.stringify({
    token: {
      access_token: 'ya29.still-valid',
      refresh_token: '1//orig-refresh-keep',
      token_type: 'Bearer',
      expiry: '2026-11-20T00:30:00Z',
    },
    auth_method: 'consumer',
    id_token_email: 'u@example.com',
  });
  let refreshCalls = 0;
  const cachedTok = await ensureFreshAccessToken(freshToken, {
    nowMs,
    loadClients: () => [{ id: 'cid', secret: 'csec' }],
    requestFn: async () => {
      refreshCalls += 1;
      return { status: 500, json: null };
    },
  });
  assert.equal(cachedTok.refreshed, false);
  assert.equal(cachedTok.accessToken, 'ya29.still-valid');
  assert.equal(refreshCalls, 0);

  // Refreshes expired token and preserves original refresh_token when omitted by Google
  const expiredToken = JSON.stringify({
    token: {
      access_token: 'ya29.expired',
      refresh_token: '1//orig-refresh-keep',
      token_type: 'Bearer',
      expiry: '2026-11-19T23:55:00Z',
    },
    auth_method: 'consumer',
    id_token_email: 'u@example.com',
    writer_id: 'keep-writer',
  });
  const refreshed = await ensureFreshAccessToken(expiredToken, {
    nowMs,
    loadClients: () => [{ id: 'cid', secret: 'csec' }],
    requestFn: async (url, opts) => {
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      const params = new URLSearchParams(opts.body);
      assert.equal(params.get('grant_type'), 'refresh_token');
      assert.equal(params.get('refresh_token'), '1//orig-refresh-keep');
      return {
        status: 200,
        json: { access_token: 'ya29.fresh-access', expires_in: 3600 },
      };
    },
  });
  assert.equal(refreshed.refreshed, true);
  assert.equal(refreshed.accessToken, 'ya29.fresh-access');
  const parsedUpdated = JSON.parse(refreshed.updatedTokenRaw);
  assert.equal(parsedUpdated.token.refresh_token, '1//orig-refresh-keep');
  assert.equal(parsedUpdated.token.access_token, 'ya29.fresh-access');
  assert.equal(parsedUpdated.writer_id, 'keep-writer');

  // Maps invalid_grant to TOKEN_REFRESH_REVOKED
  await assert.rejects(
    () =>
      ensureFreshAccessToken(expiredToken, {
        nowMs,
        loadClients: () => [{ id: 'cid', secret: 'csec' }],
        requestFn: async () => ({ status: 400, json: { error: 'invalid_grant' } }),
      }),
    /TOKEN_REFRESH_REVOKED/
  );
});

test('vault updateAccountSyncFields updates tier/project/token without altering lastUsedAt or exposing internal fields', (t) => {
  const { paths } = makeSandbox(t);
  assert.equal(normalizeProjectId('proj_123-abc/x:1'), 'proj_123-abc/x:1');
  assert.equal(normalizeProjectId('bad proj\nid'), '');

  const imported = importAccount(paths, {
    credentialText: makeSampleToken('sync@example.com', '1//refresh-sync-1'),
    label: 'SyncAcc',
  });
  const beforeVault = loadVault(paths);
  const originalLastUsed = beforeVault.accounts[0].lastUsedAt;

  const updated = updateAccountSyncFields(paths, [
    {
      id: imported.id,
      tierName: 'Google AI Ultra',
      projectId: 'cloudaicompanion-proj-999',
      tokenRaw: makeSampleToken('sync@example.com', '1//refresh-sync-1', 'ya29.updated-token'),
    },
  ]);
  assert.equal(updated, 1);

  const afterVault = loadVault(paths);
  assert.equal(afterVault.accounts[0].tierName, 'Google AI Ultra');
  assert.equal(afterVault.accounts[0].projectId, 'cloudaicompanion-proj-999');
  assert.equal(afterVault.accounts[0].lastUsedAt, originalLastUsed);
  assert.ok(afterVault.accounts[0].tokenRaw.includes('ya29.updated-token'));

  const pub = listPublicAccounts(paths, '', { revealEmails: true });
  assert.equal(pub[0].tierName, 'Google AI Ultra');
  assert.equal('projectId' in pub[0], false);
  assert.equal('tokenRaw' in pub[0], false);
});

test('Option B sync-tiers and per-account usage: OAuth tier fetch, LS fast path, remote 401/404 retries, cache & leak checks', async (t) => {
  const { env, paths } = makeSandbox(t);
  const activeToken = JSON.stringify({
    token: {
      access_token: 'ya29.active-token',
      refresh_token: '1//refresh-active-111',
      token_type: 'Bearer',
      expiry: new Date(Date.now() + 3600_000).toISOString(),
    },
    auth_method: 'consumer',
    id_token_email: 'active@example.com',
  });
  writeFileSync(paths.tokenPath, activeToken, { encoding: 'utf8', mode: 0o600 });
  const activeAcc = importAccount(paths, {
    credentialText: activeToken,
    label: 'Main',
    tierName: 'Google AI Pro',
  });

  // Standby account with expired token and stale cached projectId
  const standbyExpired = JSON.stringify({
    token: {
      access_token: 'ya29.standby-stale',
      refresh_token: '1//refresh-standby-222',
      token_type: 'Bearer',
      expiry: '2020-01-01T00:00:00Z',
    },
    auth_method: 'consumer',
    id_token_email: 'standby@example.com',
  });
  const standbyAcc = importAccount(paths, {
    credentialText: standbyExpired,
    label: 'Standby',
    projectId: 'proj-stale-000',
  });
  const standbyBeforeLastUsed = loadVault(paths).accounts.find((a) => a.id === standbyAcc.id).lastUsedAt;

  // Revoked account for error handling check
  const revokedToken = JSON.stringify({
    token: {
      access_token: 'ya29.revoked-old',
      refresh_token: '1//refresh-revoked-333',
      token_type: 'Bearer',
      expiry: '2020-01-01T00:00:00Z',
    },
    auth_method: 'consumer',
    id_token_email: 'revoked@example.com',
  });
  const revokedAcc = importAccount(paths, {
    credentialText: revokedToken,
    label: 'Revoked',
  });

  const lsRpcCalls = [];
  const remoteCalls = [];
  let allowUsageSuccess = false;
  let simulateStandbyProject404 = true;
  let clockNow = Date.parse('2026-11-20T02:00:00Z');
  const fakeClientId = '1071006060591-cloudcodeunit.apps.googleusercontent.com';
  const fakeClientSecret = `${SYNTH_SECRET_PREFIX}fakeCloudCodeUnitTestSecret000000`;

  const srv = await createApp({
    sidecarSdk: await resolveSidecarSdkForTest(),
    env,
    port: 0,
    uiToken: 'cloudcode-ui-token',
    lsAddress: 'test.invalid',
    csrfToken: 'test-csrf',
    getUserStatus: async () => ({
      lsConnected: true,
      email: 'active@example.com',
      tierName: 'Google AI Pro',
    }),
    callLsRpc: async (_env, method, opts) => {
      lsRpcCalls.push({ method, body: opts?.body || {} });
      return {
        response: {
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [
                {
                  bucketId: 'gemini-weekly',
                  window: 'weekly',
                  remainingFraction: 0.66,
                  resetTime: '2026-11-25T03:00:02Z',
                },
              ],
            },
          ],
        },
      };
    },
    cloudCodeOptions: {
      nowFn: () => clockNow,
      cacheTtlMs: 30_000,
    },
    oauthOptions: {
      loadClients: () => [{ id: fakeClientId, secret: fakeClientSecret }],
      openBrowser: () => ({ opened: true }),
      requestFn: async (urlStr, opts) => {
        remoteCalls.push({ urlStr, auth: opts?.headers?.Authorization || '', body: opts?.body || '' });

        if (urlStr === 'https://oauth2.googleapis.com/token') {
          const params = new URLSearchParams(opts.body);
          const grant = params.get('grant_type');
          const rt = params.get('refresh_token');
          if (grant === 'authorization_code') {
            return {
              status: 200,
              json: {
                access_token: 'ya29.oauth-new-access',
                refresh_token: '1//oauth-new-refresh-444',
                expires_in: 3600,
              },
            };
          }
          if (rt === '1//refresh-standby-222') {
            return {
              status: 200,
              json: { access_token: 'ya29.standby-refreshed', expires_in: 3600 },
            };
          }
          if (rt === '1//refresh-revoked-333') {
            return { status: 400, json: { error: 'invalid_grant' } };
          }
        }

        if (urlStr === 'https://www.googleapis.com/oauth2/v2/userinfo') {
          return {
            status: 200,
            json: { email: 'oauthadded@example.com', verified_email: true },
          };
        }

        if (urlStr.endsWith('/v1internal:loadCodeAssist')) {
          const auth = opts?.headers?.Authorization || '';
          if (auth === 'Bearer ya29.oauth-new-access') {
            return {
              status: 200,
              json: {
                paidTier: { name: 'Google AI Ultra' },
                cloudaicompanionProject: { id: 'proj-oauth-new' },
              },
            };
          }
          if (auth === 'Bearer ya29.standby-refreshed') {
            // Simulate primary 500 -> fallback 200 on first hit
            if (urlStr.startsWith(DEFAULT_CLOUD_CODE_ENDPOINT)) {
              return { status: 500, json: null };
            }
            return {
              status: 200,
              json: {
                paidTier: { name: 'Google AI Pro' },
                cloudaicompanionProject: { id: 'proj-standby-fresh' },
              },
            };
          }
          if (auth === 'Bearer ya29.active-token') {
            return {
              status: 200,
              json: { currentTier: { name: 'Free' }, cloudaicompanionProject: 'proj-active-1' },
            };
          }
        }

        if (urlStr.endsWith('/v1internal:retrieveUserQuotaSummary')) {
          const parsedBody = JSON.parse(opts.body || '{}');
          if (parsedBody.project === 'proj-stale-000') {
            return { status: 404, json: { error: 'project_not_found' } };
          }
          if (!allowUsageSuccess) {
            return { status: 500, json: null };
          }
          return {
            status: 200,
            json: {
              groups: [
                {
                  displayName: 'Claude and GPT models',
                  buckets: [
                    { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.88, resetTime: '2026-11-26T18:00:00Z' },
                    { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-20T07:00:00Z' },
                  ],
                },
              ],
            },
          };
        }

        return { status: 500, json: null };
      },
    },
  });

  const httpServer = await srv.start();
  t.after(async () => {
    await srv.close();
  });

  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  const postAuth = async (path, body = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sidecar-Token': 'cloudcode-ui-token',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    assert.equal(text.includes(fakeClientSecret), false, `Client secret leak in ${path}`);
    assert.equal(text.includes('refresh_token'), false, `refresh_token leak in ${path}`);
    assert.equal(text.includes('access_token'), false, `access_token leak in ${path}`);
    assert.equal(text.includes('1//'), false, `Refresh token value leak in ${path}`);
    assert.equal(text.includes('ya29.'), false, `Access token value leak in ${path}`);
    assert.equal(text.includes('proj-standby-fresh'), false, `projectId leak in ${path}`);
    assert.equal(text.includes('proj-oauth-new'), false, `projectId leak in ${path}`);
    return { status: res.status, json: JSON.parse(text) };
  };

  // 1. OAuth add enriches tierName & projectId immediately upon callback completion
  const startRes = await postAuth('/api/oauth/start', { label: 'UltraNew' });
  const authUrl = new URL(startRes.json.oauth.authUrl);
  const cbUrl = new URL(authUrl.searchParams.get('redirect_uri'));
  const cbRes = await fetch(
    `http://127.0.0.1:${cbUrl.port}/auth/callback?state=${encodeURIComponent(authUrl.searchParams.get('state'))}&code=code-1`
  );
  assert.equal(cbRes.status, 200);
  const oauthStatus = await postAuth('/api/oauth/status');
  const oauthAddedPub = oauthStatus.json.accounts.find((a) => a.label === 'UltraNew');
  assert.ok(oauthAddedPub);
  assert.equal(oauthAddedPub.tierName, 'Google AI Ultra');
  assert.equal(
    loadVault(paths).accounts.find((a) => a.id === oauthAddedPub.id).projectId,
    'proj-oauth-new'
  );

  // 2. sync-tiers with onlyMissing=true skips accounts that already have tierName, syncs standby, preserves lastUsedAt
  const syncMissingRes = await postAuth('/api/accounts/sync-tiers', { onlyMissing: true });
  assert.equal(syncMissingRes.status, 200);
  assert.equal(syncMissingRes.json.sync.skippedCount, 2); // active + oauthAdded already have tierName
  const standbyPubAfterSync = syncMissingRes.json.accounts.find((a) => a.id === standbyAcc.id);
  assert.equal(standbyPubAfterSync.tierName, 'Google AI Pro');
  const standbyAfterVault = loadVault(paths).accounts.find((a) => a.id === standbyAcc.id);
  assert.equal(standbyAfterVault.lastUsedAt, standbyBeforeLastUsed);
  assert.equal(standbyAfterVault.projectId, 'proj-standby-fresh');
  assert.equal(JSON.parse(standbyAfterVault.tokenRaw).token.refresh_token, '1//refresh-standby-222');

  // Reset standby projectId back to stale to test /api/accounts/usage 404 projectId auto-recovery
  updateAccountSyncFields(paths, [{ id: standbyAcc.id, projectId: 'proj-stale-000' }]);

  // 3. Active account usage uses local LS fast path + respects cache + forceRefresh
  const activeUsage1 = await postAuth('/api/accounts/usage', { id: activeAcc.id });
  assert.equal(activeUsage1.status, 200);
  assert.equal(activeUsage1.json.usage.source, 'ls');
  assert.equal(activeUsage1.json.usage.groups[0].buckets[0].remainingFraction, 0.66);
  assert.equal(lsRpcCalls.length, 1);
  assert.deepEqual(lsRpcCalls[0].body, {});

  // Within TTL -> cache hit, no extra RPC
  const activeUsageCached = await postAuth('/api/accounts/usage', { id: activeAcc.id });
  assert.equal(activeUsageCached.status, 200);
  assert.equal(lsRpcCalls.length, 1);

  // forceRefresh=true bypasses cache and forwards { forceRefresh: true } to LS
  const activeUsageForce = await postAuth('/api/accounts/usage', { id: activeAcc.id, forceRefresh: true });
  assert.equal(activeUsageForce.status, 200);
  assert.equal(lsRpcCalls.length, 2);
  assert.deepEqual(lsRpcCalls[1].body, { forceRefresh: true });

  // 4. Standby non-active account usage recovers from 404 stale projectId and returns remote quota
  allowUsageSuccess = true;
  const standbyUsage = await postAuth('/api/accounts/usage', { id: standbyAcc.id });
  assert.equal(standbyUsage.status, 200);
  assert.equal(standbyUsage.json.usage.source, 'remote');
  assert.equal(standbyUsage.json.tierName, 'Google AI Pro');
  assert.equal(standbyUsage.json.usage.groups[0].displayName, 'Claude and GPT models');
  assert.equal(standbyUsage.json.usage.groups[0].buckets.length, 2);
  assert.equal(loadVault(paths).accounts.find((a) => a.id === standbyAcc.id).projectId, 'proj-standby-fresh');

  // 5. Validation & revoked error handling
  const badIdRes = await postAuth('/api/accounts/usage', { id: 'not-a-uuid' });
  assert.equal(badIdRes.status, 400);
  const missingIdRes = await postAuth('/api/accounts/usage', { id: '00000000-0000-0000-0000-000000000000' });
  assert.equal(missingIdRes.status, 400);
  const revokedUsage = await postAuth('/api/accounts/usage', { id: revokedAcc.id });
  assert.equal(revokedUsage.status, 400);
  assert.ok(revokedUsage.json.error.includes('授权已失效'));
});
