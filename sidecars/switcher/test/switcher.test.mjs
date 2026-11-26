import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  extractActiveItemsFromLs,
  findUserChildProcesses,
  isInfrastructureProcess,
  parsePsOutput,
} from '../active-work.mjs';
import { createApp } from '../main.mjs';
import { readQuotaAlertSnapshot, writeQuotaRefreshTrigger } from '../quota-guard.mjs';
import {
  createQuotaService,
  deleteQuotaSnapshot,
  loadQuotaSnapshots,
  projectQuotaSummary,
  upsertQuotaSnapshot,
} from '../quota-snapshots.mjs';
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
  decryptPayload,
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

// Exercise the same authenticated request dispatch on CI and in socket-restricted sandboxes.
function createTestSidecarSdk() {
  class SidecarApp {
    routes = new Map();
    token = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;

    page(path, handler) {
      this.api(path, handler, 'GET');
    }

    api(path, handler, method = 'POST') {
      this.routes.set(method + ' ' + path, handler);
    }

    async dispatch(request) {
      const { pathname } = new URL(request.url);
      if (request.method !== 'GET' && this.token && request.headers.get('x-sidecar-token') !== this.token) {
        return new Response(null, { status: 401 });
      }
      const handler = this.routes.get(request.method + ' ' + pathname);
      if (!handler) return new Response(null, { status: 404 });
      return handler(request.method === 'POST' ? await request.json() : {});
    }

    async run() {
      const origin = 'http://127.0.0.1';
      this.server = http.createServer(async (req, res) => {
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const result = await this.dispatch(new Request(origin + req.url, {
            method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
          }));
          res.writeHead(result.status, Object.fromEntries(result.headers));
          res.end(await result.text());
        } catch {
          res.writeHead(500);
          res.end();
        }
      });
      try {
        await new Promise((resolve, reject) => {
          this.server.once('error', reject);
          this.server.listen(0, '127.0.0.1', resolve);
        });
      } catch (err) {
        if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
        return (path, init) => this.dispatch(new Request(origin + path, init));
      }
      const { address, port } = this.server.address();
      assert.equal(address, '127.0.0.1');
      return (path, init) => fetch(origin + ':' + port + path, init);
    }

    async close() {
      if (!this.server?.listening) return;
      this.server.closeAllConnections();
      await new Promise((resolve) => this.server.close(resolve));
    }
  }

  class SdkResponse extends Response {
    constructor(body, { contentType, status, headers }) {
      super(body, { status, headers: { ...headers, 'Content-Type': contentType } });
    }
  }

  return { SidecarApp, Response: SdkResponse };
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
    ANTIGRAVITY_APP_DATA_DIR: join(geminiDir, 'antigravity'),
    ANTIGRAVITY_APP_STORAGE_PATH: join(root, 'app_storage.json'),
    ANTIGRAVITY_LS_ADDRESS: 'test.invalid',
    ANTIGRAVITY_CSRF_TOKEN: 'test-csrf',
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
  };
  const paths = resolvePaths(env);
  assert.equal(paths.useKeyring, false);
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
    sidecarSdk: createTestSidecarSdk(),
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
    callLsRpc: async () => null,
    detectActiveWork: async () => ({ busy: false, count: 0, items: [], truncated: false }),
    spawnWorker: (jobPath) => {
      spawnedJobs.push(jobPath);
    },
  });

  const request = await srv.start();
  t.after(async () => {
    await srv.close();
  });


  // Static pages & headers
  for (const route of ['/', '/styles.css', '/app.js']) {
    const res = await request(route);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy') || '';
    assert.ok(csp.includes("default-src 'self'"));
    assert.equal(csp.includes('unsafe-inline'), false);
    assert.equal(csp.includes('unsafe-eval'), false);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }

  // Missing token rejected (401)
  const unauthRes = await request('/api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(unauthRes.status, 401);

  const postAuth = async (path, body = {}) => {
    const res = await request(path, {
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

  // Capture current credentials via the native-login flow.
  const capRes = await postAuth('/api/accounts/capture', { label: 'Primary' });
  assert.equal(capRes.status, 200);
  assert.equal(capRes.json.accounts.length, 1);

  for (const route of ['/api/accounts/import', '/api/oauth/start', '/api/accounts/sync-tiers']) {
    const removed = await request(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': 'unit-test-sidecar-token' },
      body: '{}',
    });
    assert.equal(removed.status, 404, route);
  }

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

test('settings updates have a dedicated rate limit with a retry countdown', async (t) => {
  const { env } = makeSandbox(t);
  const srv = await createApp({
    sidecarSdk: createTestSidecarSdk(),
    env,
    port: 0,
    uiToken: 'test-ui',
    writeLimit: 1,
    settingsLimit: 2,
    callLsRpc: async () => null,
    watchTriggers: false,
  });
  const request = await srv.start();
  t.after(() => srv.close());

  const updateThreshold = (thresholdPercent) => request('/api/settings/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': 'test-ui' },
    body: JSON.stringify({ thresholdPercent }),
  });
  for (const threshold of [20, 30]) {
    const res = await updateThreshold(threshold);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).settings.thresholdPercent, threshold);
  }

  const blocked = await updateThreshold(40);
  assert.equal(blocked.status, 429);
  const { code, retryAfterSec, error } = await blocked.json();
  assert.equal(code, 'RATE_LIMITED');
  assert.ok(Number.isInteger(retryAfterSec) && retryAfterSec > 0);
  assert.equal(blocked.headers.get('Retry-After'), String(retryAfterSec));
  assert.equal(error, `高级设置保护中，请 ${retryAfterSec} 秒后再试。`);
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
    () => runWorker(outsideJob, { ...env, SWITCHER_DRY_RUN: '1' }),
    /PATH_OUTSIDE_BOUNDARY/
  );
});

test('createApp fails closed when ANTIGRAVITY_SIDECAR_UI_TOKEN is missing', async (t) => {
  const { env } = makeSandbox(t);
  const srv = await createApp({
    sidecarSdk: createTestSidecarSdk(),
    env,
    port: 0,
    uiToken: '',
    lsAddress: 'test.invalid',
    csrfToken: 'test-csrf',
  });
  const request = await srv.start();
  t.after(async () => {
    await srv.close();
  });
  const res = await request('/api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 403);
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
    sidecarSdk: createTestSidecarSdk(),
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

  const request = await srv.start();
  t.after(async () => {
    await srv.close();
  });

  const postAuth = async (path, body = {}) => {
    const res = await request(path, {
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
  assert.equal(
    readRunInBackgroundSetting({ ANTIGRAVITY_APP_STORAGE_PATH: storagePath }),
    process.platform === 'darwin'
  );
  assert.equal(readRunInBackgroundSetting({ ANTIGRAVITY_APP_STORAGE_PATH: storagePath }, 'win32'), false);
  assert.equal(readRunInBackgroundSetting({ ANTIGRAVITY_APP_STORAGE_PATH: storagePath }, 'darwin'), true);

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

test('token-store: OS keyring & Windows cmdkey routing, cmdkey invocation, and macOS decoding', (t) => {
  const { env, root } = makeSandbox(t);
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
  assert.equal(resolvePaths(env).useKeyring, false);
  assert.equal(resolvePaths({ ANTIGRAVITY_APP_DATA_DIR: root }, { tokenPath: join(root, 'custom-token') }).useKeyring, false);
  assert.equal(resolvePaths({ ANTIGRAVITY_APP_DATA_DIR: root, SWITCHER_TOKEN_STORE: 'file' }).useKeyring, false);

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
  const { geminiDir, dataDir, paths, env } = makeSandbox(t);

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
      ...env,
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
      ...env,
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
    sidecarSdk: createTestSidecarSdk(),
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

  const request = await srv.start();
  t.after(async () => {
    await srv.close();
  });

  const stateRes = await request('/api/state', {
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
  const htmlRes = await request('/');
  assert.equal(htmlRes.status, 200);
  const html = await htmlRes.text();
  assert.equal(html.includes('当前登录账号'), false);
  assert.equal(html.includes('凭据源'), false);
  assert.equal(html.includes('style='), false);
  assert.equal(html.includes('import-form'), false);
  assert.equal(html.includes('手动导入'), false);

  const cssRes = await request('/styles.css');
  assert.equal(cssRes.status, 200);
  const jsRes = await request('/app.js');
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

function quotaSummary(remainingFraction, resetTime = '') {
  return {
    groups: [{
      displayName: 'Gemini',
      buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction, resetTime }],
    }],
  };
}

function savedAccount(paths, email) {
  return importAccount(paths, { credentialText: makeSampleToken(email) });
}

test('active LS quota is persisted privately and inactive usage is projected without RPC', async (t) => {
  const { env, paths } = makeSandbox(t);
  const active = savedAccount(paths, 'active@example.com');
  const other = savedAccount(paths, 'other@example.com');
  const resetTime = new Date(Date.now() - 60_000).toISOString();
  const rpc = t.mock.fn(async () => ({ response: quotaSummary(0.08, resetTime) }));
  const service = createQuotaService({ paths, env, callLsRpcFn: rpc });
  const live = await service.getAccountUsage({ id: active.id, activeAccountId: active.id, lsConnected: true });
  assert.equal(live.source, 'live');
  assert.equal(live.usage.groups[0].buckets[0].remainingFraction, 0.08);
  assert.deepEqual(rpc.mock.calls.map(c => c.arguments), [[env, 'RetrieveUserQuotaSummary', { timeoutMs: 2500, body: {} }]]);
  const record = loadQuotaSnapshots(paths).accounts[active.id];
  assert.equal(record.accountId, active.id);
  assert.equal(record.capturedAt, live.capturedAt);
  assert.ok(Number.isFinite(Date.parse(record.capturedAt)));
  if (process.platform !== 'win32') assert.equal(lstatSync(paths.quotaSnapshotsPath).mode & 0o777, 0o600);

  const inactive = () => service.getAccountUsage({
    id: active.id, activeAccountId: other.id, lsConnected: true, forceRefresh: true,
  });
  const projected = await inactive();
  assert.equal(projected.source, 'snapshot');
  assert.equal(projected.hasSnapshot, true);
  assert.equal(projected.estimatedAnyReset, true);
  assert.equal(projected.capturedAt, live.capturedAt);
  const bucket = projected.usage.groups[0].buckets[0];
  assert.equal(bucket.estimatedReset, true);
  assert.equal(bucket.remainingFraction, 1);
  assert.equal(bucket.snapshotRemainingFraction, 0.08);
  assert.deepEqual(loadQuotaSnapshots(paths).accounts[active.id], record);

  deleteQuotaSnapshot(paths, active.id);
  const missing = await inactive();
  assert.equal(missing.source, 'none');
  assert.equal(missing.hasSnapshot, false);
  assert.equal(missing.usage, null);
  assert.equal(rpc.mock.callCount(), 1);
});

test('snapshot projection applies reset and stale boundaries and preserves disabled buckets', () => {
  const capturedAt = '2026-01-01T00:00:00Z';
  const resetTime = '2026-01-02T00:00:00Z';
  const summary = quotaSummary(0.1, resetTime);
  summary.groups[0].buckets.push({ remainingFraction: 0.2, disabled: true, resetTime });
  const project = offset => projectQuotaSummary({ capturedAt, summary }, { nowMs: Date.parse(resetTime) + offset });
  assert.equal(project(-1).estimatedAnyReset, false);
  assert.equal(project(0).isStale, false);
  assert.equal(project(0).estimatedAnyReset, true);
  assert.equal(project(1).isStale, true);
  const disabled = project(1).usage.groups[0].buckets[1];
  assert.equal(disabled.estimatedReset, false);
  assert.equal(disabled.remainingFraction, 0.2);
});

test('snapshot storage rejects symlinks without reading or overwriting the target', {
  skip: process.platform === 'win32',
}, (t) => {
  const { root, paths } = makeSandbox(t);
  const account = savedAccount(paths, 'sandbox@example.com');
  const record = { accountId: account.id, summary: quotaSummary(0.4) };
  upsertQuotaSnapshot(paths, record);
  const original = readFileSync(paths.quotaSnapshotsPath, 'utf8');
  const target = join(root, 'target.json');
  writeFileSync(target, original);
  rmSync(paths.quotaSnapshotsPath);
  symlinkSync(target, paths.quotaSnapshotsPath);
  assert.deepEqual(loadQuotaSnapshots(paths).accounts, {});
  assert.throws(() => upsertQuotaSnapshot(paths, record), /UNSAFE_FILE_TYPE/);
  assert.equal(readFileSync(target, 'utf8'), original);
  assert.ok(lstatSync(paths.quotaSnapshotsPath).isSymbolicLink());
});

test('active quota coalesces in-flight reads, expires at TTL, and discards invalidated results', async (t) => {
  const { env, paths } = makeSandbox(t);
  const { id: accountId } = savedAccount(paths, 'cache@example.com');
  let now = 1000;
  let finish;
  const rpc = t.mock.fn(() => new Promise(resolve => { finish = resolve; }));
  const service = createQuotaService({ paths, env, callLsRpcFn: rpc, nowFn: () => now, cacheTtlMs: 100 });
  const fetchActive = (forceRefresh = false) => service.fetchActiveQuota({ accountId, forceRefresh });
  const first = fetchActive();
  const concurrent = fetchActive();
  assert.equal(rpc.mock.callCount(), 1);
  finish(quotaSummary(0.5));
  assert.deepEqual(await first, await concurrent);
  now += 99;
  assert.deepEqual(await fetchActive(), await first);
  assert.equal(rpc.mock.callCount(), 1);
  now++;
  const expired = fetchActive();
  assert.equal(rpc.mock.callCount(), 2);
  finish(quotaSummary(0.25));
  assert.equal((await expired).usage.groups[0].buckets[0].remainingFraction, 0.25);
  const forced = fetchActive(true);
  assert.equal(rpc.mock.callCount(), 3);
  assert.deepEqual(rpc.mock.calls[2].arguments[2].body, { forceRefresh: true });
  service.invalidateCache();
  deleteQuotaSnapshot(paths, accountId);
  finish(quotaSummary(0.8));
  assert.equal(await forced, null);
  assert.deepEqual(loadQuotaSnapshots(paths).accounts, {});
});

async function startQuotaSidecar(t, env, options = {}) {
  const srv = await createApp({ sidecarSdk: createTestSidecarSdk(), env, uiToken: 'test-ui', port: 0, ...options });
  const request = await srv.start();
  t.after(() => srv.close());
  return async (path, data = {}) => {
    const res = await request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': 'test-ui' },
      body: JSON.stringify(data),
    });
    assert.equal(res.status, 200, path);
    return res.json();
  };
}

test('sidecar usage fetches only the active account and removal deletes only its target snapshot', async (t) => {
  const { env, paths } = makeSandbox(t);
  const active = savedAccount(paths, 'active@example.com');
  const backup = savedAccount(paths, 'backup@example.com');
  const missing = savedAccount(paths, 'missing@example.com');
  writeFileSync(paths.tokenPath, makeSampleToken('active@example.com'));
  upsertQuotaSnapshot(paths, { accountId: backup.id, summary: quotaSummary(0.42) });
  const methods = [];
  const post = await startQuotaSidecar(t, env, {
    callLsRpc: async (_env, method) => {
      methods.push(method);
      if (method === 'GetUserStatus') return { userStatus: { email: 'active@example.com' } };
      return quotaSummary(0.73);
    },
  });
  const usage = id => post('/api/accounts/usage', { id, forceRefresh: true });
  assert.equal((await usage(backup.id)).source, 'snapshot');
  assert.equal((await usage(missing.id)).source, 'none');
  assert.deepEqual(methods, []);
  const live = await usage(active.id);
  assert.equal(live.source, 'live');
  assert.equal(live.usage.groups[0].buckets[0].remainingFraction, 0.73);
  assert.deepEqual(methods, ['GetUserStatus', 'RetrieveUserQuotaSummary']);
  await post('/api/accounts/remove', { id: backup.id });
  assert.deepEqual(Object.keys(loadQuotaSnapshots(paths).accounts), [active.id]);
});

for (const optIn of [false, true]) {
  test(`sidecar switch persists outgoing quota before dispatch with onboarding opt-in ${optIn}`, async (t) => {
    const { env, paths } = makeSandbox(t);
    const active = savedAccount(paths, 'active@example.com');
    const backup = savedAccount(paths, 'backup@example.com');
    upsertQuotaSnapshot(paths, { accountId: backup.id, summary: quotaSummary(0.9) });
    const methods = [];
    let outgoing;
    let job;
    const post = await startQuotaSidecar(t, env, {
      callLsRpc: async (_env, method, opts) => {
        methods.push([method, opts.body]);
        if (method === 'GetUserStatus') return { userStatus: { email: 'active@example.com' } };
        return quotaSummary(0.03);
      },
      detectActiveWork: async () => ({ busy: false }),
      spawnWorker: (path) => {
        outgoing = loadQuotaSnapshots(paths).accounts[active.id];
        job = decryptPayload(JSON.parse(readFileSync(path, 'utf8')), getOrCreateKey(paths));
      },
    });
    if (optIn) {
      const updated = await post('/api/settings/update', {
        skipOnboardingPrompt: true, naturalPauseEnabled: false, dynamicThresholdEnabled: false,
      });
      assert.equal(updated.settings.skipOnboardingPrompt, true);
      assert.equal(updated.settings.naturalPauseEnabled, false);
      assert.equal(updated.settings.dynamicThresholdEnabled, false);
      assert.equal(updated.quotaAlert.level, 'hard');
      assert.equal(updated.quotaAlert.bestCandidate.id, backup.id);
      assert.doesNotMatch(JSON.stringify(updated.quotaAlert), /1\/\/|backup@example\.com/);
      if (process.platform !== 'win32') {
        for (const path of [paths.settingsPath, paths.quotaAlertPath]) {
          assert.equal(lstatSync(path).mode & 0o777, 0o600);
        }
      }
    }
    const result = await post('/api/accounts/switch', { id: backup.id });
    assert.equal(result.switching, true);
    assert.deepEqual(methods.at(-1), ['RetrieveUserQuotaSummary', { forceRefresh: true }]);
    assert.equal(outgoing.syncSource, 'pre_switch_snapshot');
    assert.equal(outgoing.summary.groups[0].buckets[0].remainingFraction, 0.03);
    assert.equal(job.syncOnboarding, optIn);
    if (optIn) assert.equal(job.relaunchPauseMs ?? 0, 0);
    else assert.ok(job.relaunchPauseMs >= 3000 && job.relaunchPauseMs <= 8000);
  });
}

test('idle sidecar makes zero LS requests over multiple polling intervals', async (t) => {
  const { env, paths } = makeSandbox(t);
  const rpc = t.mock.fn(async () => null);
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const srv = await createApp({ sidecarSdk: createTestSidecarSdk(), env, callLsRpc: rpc });
  t.after(() => srv.close());
  t.mock.timers.tick(180_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rpc.mock.callCount(), 0);
  assert.equal(existsSync(paths.quotaAlertPath), false);
});

test('filesystem trigger refreshes quota, throttles a second write, and accepts a later trigger', async (t) => {
  const { paths, env } = makeSandbox(t);
  const active = savedAccount(paths, 'watch@example.com');
  const methods = [];
  let quota = 0.01;
  const srv = await createApp({
    sidecarSdk: createTestSidecarSdk(), env,
    callLsRpc: async (_env, method) => {
      methods.push(method);
      if (method === 'GetUserStatus') return { userStatus: { email: 'watch@example.com' } };
      return quotaSummary(quota);
    },
  });
  t.after(() => srv.close());
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const trigger = () => writeQuotaRefreshTrigger(paths, { nowMs: now, minIntervalMs: 0 });
  const waitForLevel = async level => {
    for (let i = 0; i < 100; i++) {
      if (readQuotaAlertSnapshot(paths)?.level === level) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('Timed out waiting for quota alert level ' + level);
  };
  trigger();
  await waitForLevel('hard');
  assert.equal(loadQuotaSnapshots(paths).accounts[active.id].syncSource, 'hook_trigger');
  const oneRefresh = ['GetUserStatus', 'RetrieveUserQuotaSummary'];
  assert.deepEqual(methods, oneRefresh);
  quota = 0.85;
  now += 60_000;
  trigger();
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.deepEqual(methods, oneRefresh);
  now += 30_000;
  trigger();
  await waitForLevel('ok');
  assert.deepEqual(methods, [...oneRefresh, ...oneRefresh]);
});

test('public UI uses external assets and local quota and native account controls', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  for (const asset of [html, js]) {
    assert.doesNotMatch(asset, /innerHTML|outerHTML|insertAdjacentHTML|\/api\/oauth\/|v1internal|antigravity\/hub\//i);
    assert.doesNotMatch(asset, /<style\b|\bstyle\s*=/i);
  }
  assert.doesNotMatch(html, /\bon\w+\s*=/i);
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(attrs, /\ssrc\s*=\s*["']\/(?!\/)/i);
    assert.equal(body.trim(), '');
  }
  for (const id of [
    'guard-alert-enabled',
    'guard-watch-weekly',
    'guard-watch-5h',
    'guard-dynamic-threshold',
    'guard-natural-pause',
    'guard-auto-switch',
    'guard-auto-resume',
    'guard-skip-onboarding',
  ]) {
    const group = html.match(new RegExp(`(<div\\b[^>]*\\sid\\s*=\\s*(["'])${id}\\2[^>]*>)([\\s\\S]*?)<\\/div>`));
    assert.ok(group, `Missing radiogroup ${id}`);
    assert.match(group[1], /\sclass\s*=\s*(["'])(?:[^"']*\s)?guard-segmented(?:\s[^"']*)?\1/i);
    assert.match(group[1], /\srole\s*=\s*(["'])radiogroup\1/i);
    const buttons = [...group[3].matchAll(/<button\b[^>]*>/gi)].map(([button]) => button);
    assert.equal(buttons.length, 2);
    for (const button of buttons) {
      assert.match(button, /\stype\s*=\s*(["'])button\1/i);
      assert.match(button, /\sclass\s*=\s*(["'])(?:[^"']*\s)?guard-seg-btn(?:\s[^"']*)?\1/i);
      assert.match(button, /\srole\s*=\s*(["'])radio\1/i);
      assert.match(button, /\saria-checked\s*=\s*(["'])(?:true|false)\1/);
    }
    assert.match(buttons[0], /\sdata-value\s*=\s*(["'])false\1/);
    assert.match(buttons[1], /\sdata-value\s*=\s*(["'])true\1/);
    assert.ok(js.includes(id));
  }
  const posSkipOnboarding = html.search(/\sid\s*=\s*(["'])guard-skip-onboarding\1/);
  const posAutoSwitch = html.search(/\sid\s*=\s*(["'])guard-auto-switch\1/);
  const posAutoResume = html.search(/\sid\s*=\s*(["'])guard-auto-resume\1/);
  const posThreshold = html.search(/\sid\s*=\s*(["'])guard-threshold\1/);
  assert.ok(posSkipOnboarding > 0 && posSkipOnboarding < posAutoSwitch);
  assert.ok(posAutoSwitch < posAutoResume && posAutoResume < posThreshold);
  assert.doesNotMatch(html, /<input\b[^>]*\stype\s*=\s*(?:(["'])checkbox\1|checkbox(?=[\s/>]))/i);
  assert.doesNotMatch(html, /\sid\s*=\s*(?:(["'])guard-save-btn\1|guard-save-btn(?=[\s/>]))/i);
  assert.match(html, /<button\b[^>]*\sclass\s*=\s*(["'])(?:[^"']*\s)?info-tip-btn(?:\s[^"']*)?\1/i);
  assert.match(html, /<[^>]+\srole\s*=\s*(["'])tooltip\1/i);
  assert.match(css, /\.notice-warn\s*\{/);
  assert.match(js, /showNotice\([^,\n]+,\s*'warn'/);
  assert.match(js, /err\.retryAfterSec\s*=/);
  assert.match(js, /err\?\.status === 429 \|\| err\?\.code === 'RATE_LIMITED'/);
  assert.ok(js.includes('/api/accounts/new-login'));
  assert.ok(js.includes('estimatedReset'));
  assert.doesNotMatch(js, /\b(alert|confirm|prompt)\s*\(/);
});

test('worker changes onboarding only with opt-in and applies the pause only during a real switch', async (t) => {
  const { env, paths, root } = makeSandbox(t);
  const target = savedAccount(paths, 'target@example.com');
  const storage = env.ANTIGRAVITY_APP_STORAGE_PATH;
  const prior = JSON.stringify({ 'agy.onboarding.lastLoginUsername': 'prior@example.com', zoomLevel: 2 });
  writeFileSync(storage, prior);
  // Exercise the normal worker branch against an empty Windows installation.
  // Every desktop and process-management executable resolves inside the fixture.
  const workerEnv = {
    ...env, SystemRoot: join(root, 'Windows'), ProgramFiles: join(root, 'Program Files'),
    APPDATA: join(root, 'Roaming'), LOCALAPPDATA: join(root, 'Local'),
  };
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    const run = async (syncOnboarding, dryRun = false) => {
      const { jobPath } = prepareSwitchJob(paths, {
        mode: 'switch', accountId: target.id, env: workerEnv, syncOnboarding, relaunchPauseMs: 10,
      });
      await runWorker(jobPath, { ...workerEnv, SWITCHER_DRY_RUN: dryRun ? '1' : '0' });
      const log = readFileSync(paths.logPath, 'utf8');
      rmSync(paths.logPath);
      return log;
    };
    const disabled = await run(false);
    assert.equal(readFileSync(storage, 'utf8'), prior);
    assert.match(disabled, /ONBOARDING_SYNC skipped=disabled/);
    assert.match(disabled, /NATURAL_PAUSE ms=10[\s\S]*RELAUNCH_SKIPPED_MISSING_BIN/);
    assert.doesNotMatch(await run(true, true), /NATURAL_PAUSE/);
    const enabled = await run(true);
    assert.match(enabled, /ONBOARDING_SYNC updated=1 reason=UPDATED/);
    assert.deepEqual(JSON.parse(readFileSync(storage, 'utf8')), {
      'agy.onboarding.lastLoginUsername': 'target@example.com', 'agy.onboarding.lastLoginIsGcpTos': 'false',
      zoomLevel: 2,
    });
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

test('tokenless inactive usage is local and live status takes precedence over a stale credential', async (t) => {
  const { env, paths } = makeSandbox(t);
  const active = savedAccount(paths, 'live@example.com');
  const backup = savedAccount(paths, 'old@example.com');
  const rpc = t.mock.fn(async (_env, method) => method === 'GetUserStatus'
    ? { userStatus: { email: 'live@example.com' } } : quotaSummary(0.73));
  const post = await startQuotaSidecar(t, env, { callLsRpc: rpc });
  const usage = id => post('/api/accounts/usage', { id, forceRefresh: true });
  assert.equal((await usage(backup.id)).source, 'none');
  assert.equal(rpc.mock.callCount(), 0);
  writeFileSync(paths.tokenPath, makeSampleToken('old@example.com'));
  const state = await post('/api/state');
  assert.equal(state.accounts.find(a => a.isActive).id, active.id);
  rpc.mock.resetCalls();
  assert.equal((await usage(backup.id)).source, 'none');
  assert.equal(rpc.mock.callCount(), 0);
  assert.equal((await usage(active.id)).source, 'live');
  assert.deepEqual(Object.keys(loadQuotaSnapshots(paths).accounts), [active.id]);
});
