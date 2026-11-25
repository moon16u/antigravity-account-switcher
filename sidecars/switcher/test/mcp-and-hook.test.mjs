import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
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
import { extractActiveItemsFromLs, isInfrastructureProcess } from '../active-work.mjs';
import { createApp } from '../main.mjs';
import { syncOnboardingLastLoginUsername } from '../platform.mjs';
import {
  DEFAULT_GUARD_SETTINGS,
  discoverLiveHub,
  evaluateQuotaAlert,
  loadGuardSettings,
  normalizeGuardSettings,
  pickBestBackupAccount,
  readQuotaAlertSnapshot,
  saveGuardSettings,
  writeQuotaAlertSnapshot,
} from '../quota-guard.mjs';
import {
  resolveAgentApiCommand,
  resumeConversationAfterRelaunch,
  waitForConversationIdleBeforeStop,
} from '../switcher-worker.mjs';
import { decryptPayload, getOrCreateKey, importAccount, loadVault, prepareSwitchJob, resolvePaths } from '../vault.mjs';
import { createMcpHandlers, parseJsonRpcBuffer } from '../../../scripts/mcp-server.mjs';
import { evaluateHookInput } from '../../../scripts/quota-hook.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const MCP_SERVER_PATH = join(REPO_ROOT, 'scripts', 'mcp-server.mjs');
const QUOTA_HOOK_PATH = join(REPO_ROOT, 'scripts', 'quota-hook.mjs');

function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'ag-switcher-mcp-test-'));
  const geminiDir = join(root, '.gemini');
  const dataDir = join(root, 'data');
  mkdirSync(geminiDir, { recursive: true, mode: 0o700 });
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
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

function makeSampleToken(email, refresh = '1//refresh-test', access = 'ya29.access-test') {
  return JSON.stringify({
    token: {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expiry: '2099-01-01T00:00:00Z',
    },
    auth_method: 'consumer',
    id_token_email: email,
  });
}

function createFakeSidecarSdk() {
  class Response {
    constructor(body, opts = {}) {
      this.body = body;
      this.status = opts.status || 200;
      this.contentType = opts.contentType || 'application/json';
      this.headers = opts.headers || {};
    }
  }
  class SidecarApp {
    #pages = new Map();
    #apis = new Map();
    #server = null;
    #port = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0);
    #token = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';

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
        }
        const methodMap = this.#apis.get(url.pathname);
        if (methodMap?.has(req.method)) {
          const chunks = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', async () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const data = raw ? JSON.parse(raw) : {};
            const result = await methodMap.get(req.method)(data);
            if (result instanceof Response) {
              res.writeHead(result.status || 200, {
                'Content-Type': result.contentType,
                ...result.headers,
              });
              res.end(result.body);
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
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

test('resolvePaths prioritizes sidecar_data over PLUGIN_DATA when present', (t) => {
  const { root, geminiDir } = makeSandbox(t);
  const pluginDataFallback = join(root, 'plugin-data-fallback');
  const baseEnv = {
    ANTIGRAVITY_GEMINI_DIR: geminiDir,
    PLUGIN_DATA: pluginDataFallback,
  };

  assert.equal(resolvePaths(baseEnv).dataDir, pluginDataFallback);

  const sidecarDataDir = join(geminiDir, 'antigravity', 'sidecar_data', 'antigravity-account-switcher', 'switcher', 'data');
  mkdirSync(sidecarDataDir, { recursive: true, mode: 0o700 });
  const sharedPaths = resolvePaths(baseEnv);
  assert.equal(sharedPaths.dataDir, sidecarDataDir);
  assert.equal(sharedPaths.settingsPath, join(sidecarDataDir, 'settings.json'));
  assert.equal(sharedPaths.quotaAlertPath, join(sidecarDataDir, 'quota-alert.json'));
  assert.equal(sharedPaths.hookStatePath, join(sidecarDataDir, 'hook-alert-state.json'));
});

test('quota-guard settings normalization, alert thresholds, and best-backup selection', (t) => {
  const { paths } = makeSandbox(t);

  assert.deepEqual(loadGuardSettings(paths), DEFAULT_GUARD_SETTINGS);
  const polluted = JSON.parse('{"thresholdPercent":999,"switchDelaySec":0,"autoSwitchEnabled":true,"__proto__":{"polluted":true}}');
  const normalized = normalizeGuardSettings(polluted);
  assert.equal(normalized.thresholdPercent, 50);
  assert.equal(normalized.switchDelaySec, 1);
  assert.equal(normalized.autoSwitchEnabled, true);
  assert.equal(({}).polluted, undefined);

  const saved = saveGuardSettings(paths, { thresholdPercent: 10, autoSwitchEnabled: true, autoResumeEnabled: true });
  assert.equal(saved.thresholdPercent, 10);
  assert.equal(loadGuardSettings(paths).autoResumeEnabled, true);

  // Trigger on weekly <= 10%
  const weeklyAlert = evaluateQuotaAlert(
    {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.095 },
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.85 },
          ],
        },
      ],
    },
    saved
  );
  assert.equal(weeklyAlert.triggered, true);
  assert.deepEqual(weeklyAlert.triggeredBuckets, ['gemini-weekly']);
  assert.equal(weeklyAlert.weeklyPercent, 9.5);

  // Trigger on 5h <= 10% even if weekly is healthy
  const fiveHourAlert = evaluateQuotaAlert(
    {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.72 },
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.1 },
          ],
        },
      ],
    },
    saved
  );
  assert.equal(fiveHourAlert.triggered, true);
  assert.deepEqual(fiveHourAlert.triggeredBuckets, ['gemini-5h']);

  // Respect watch5h=false
  const muted5h = evaluateQuotaAlert(
    {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.72 },
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.05 },
          ],
        },
      ],
    },
    { ...saved, watch5h: false }
  );
  assert.equal(muted5h.triggered, false);

  // Best candidate selection ignores active & depleted backups
  const accounts = [
    { id: 'id-active', email: 'a@example.com', maskedEmail: 'a***@example.com', isActive: true, label: 'Main' },
    { id: 'id-depleted', email: 'b@example.com', maskedEmail: 'b***@example.com', isActive: false, label: 'Depleted' },
    { id: 'id-ok', email: 'c@example.com', maskedEmail: 'c***@example.com', isActive: false, label: 'Backup1' },
    { id: 'id-best', email: 'd@example.com', maskedEmail: 'd***@example.com', isActive: false, label: 'Backup2' },
  ];
  const usageById = new Map([
    [
      'id-depleted',
      {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-weekly', remainingFraction: 0.9 },
              { bucketId: 'gemini-5h', remainingFraction: 0.05 },
            ],
          },
        ],
      },
    ],
    [
      'id-ok',
      {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-weekly', remainingFraction: 0.6 },
              { bucketId: 'gemini-5h', remainingFraction: 0.9 },
            ],
          },
        ],
      },
    ],
    [
      'id-best',
      {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-weekly', remainingFraction: 0.85 },
              { bucketId: 'gemini-5h', remainingFraction: 0.82 },
            ],
          },
        ],
      },
    ],
  ]);

  const best = pickBestBackupAccount(accounts, usageById, { activeAccountId: 'id-active', thresholdPercent: 10 });
  assert.equal(best?.id, 'id-best');
  assert.equal(best?.weeklyPercent, 85);
  assert.equal(best?.fiveHourPercent, 82);
  assert.equal('email' in best, false);
});

test('discoverLiveHub skips dead/excluded PIDs and validates live hub RPC', async (t) => {
  const { paths, env } = makeSandbox(t);
  const daemonDir = join(paths.appDataDir, 'daemon');
  mkdirSync(daemonDir, { recursive: true });

  writeFileSync(
    join(daemonDir, 'hub_11111.json'),
    JSON.stringify({ pid: 9001, httpPort: 11111, csrfToken: 'dead-csrf', lsVersion: '2.34.0' })
  );
  writeFileSync(
    join(daemonDir, 'hub_22222.json'),
    JSON.stringify({ pid: 9002, httpPort: 22222, csrfToken: 'old-csrf', lsVersion: '2.34.0' })
  );
  writeFileSync(
    join(daemonDir, 'hub_33333.json'),
    JSON.stringify({ pid: 9003, httpPort: 33333, csrfToken: 'live-csrf', lsVersion: '2.35.0' })
  );

  const probedPorts = [];
  const found = await discoverLiveHub(env, {
    appDataDir: paths.appDataDir,
    excludePids: [9002],
    isPidAliveFn: (pid) => pid !== 9001,
    rpcFn: async (probeEnv, method) => {
      probedPorts.push({ addr: probeEnv.ANTIGRAVITY_LS_ADDRESS, method });
      if (probeEnv.ANTIGRAVITY_CSRF_TOKEN === 'live-csrf') {
        return { userStatus: { email: 'live@example.com' } };
      }
      return null;
    },
  });

  assert.equal(found?.pid, 9003);
  assert.equal(found?.lsAddress, 'http://127.0.0.1:33333');
  assert.equal(found?.csrfToken, 'live-csrf');
  assert.equal(probedPorts.length, 1);
});

test('active-work excludes caller conversationId and ignores MCP/hook scripts', () => {
  const items = extractActiveItemsFromLs({
    trajectories: {
      trajectorySummaries: {
        'conv-self': { status: 'CASCADE_RUN_STATUS_RUNNING', summary: 'Self chat' },
        'conv-other': { status: 'CASCADE_RUN_STATUS_BUSY', summary: 'Other chat' },
      },
    },
    excludeConversationIds: ['conv-self'],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].conversationId, 'conv-other');

  assert.equal(isInfrastructureProcess('node /some/dir/scripts/mcp-server.mjs'), true);
  assert.equal(isInfrastructureProcess('node ./scripts/quota-hook.mjs'), true);
  assert.equal(isInfrastructureProcess('python3 train_model.py'), false);
});

test('switcher-worker prepareSwitchJob delay/resume and post-relaunch agentapi wakeup', async (t) => {
  const { paths, env, root } = makeSandbox(t);
  const targetAcc = importAccount(paths, {
    credentialText: makeSampleToken('standby@example.com', '1//refresh-standby'),
    label: 'Standby',
  });

  const job = prepareSwitchJob(paths, {
    mode: 'switch',
    accountId: targetAcc.id,
    env,
    delayMs: 3000,
    resume: {
      conversationId: 'conv_1234567890',
      message: 'Resume work',
      agentApiExe: '/tmp/fake-agentapi',
    },
  });
  assert.ok(existsSync(job.jobPath));

  const fakeAgentApi = join(root, 'agentapi');
  const fakeLs = join(root, 'language_server');
  writeFileSync(fakeAgentApi, '#!/bin/sh\nexit 0\n');
  writeFileSync(fakeLs, 'binary');
  assert.deepEqual(resolveAgentApiCommand({ agentApiExe: fakeAgentApi }, env, 'linux'), {
    bin: fakeAgentApi,
    prefixArgs: [],
  });
  assert.deepEqual(resolveAgentApiCommand({}, env, 'linux', { lsCandidates: [fakeLs] }), {
    bin: fakeLs,
    prefixArgs: ['agentapi'],
  });

  let pollCount = 0;
  const execCalls = [];
  const res = await resumeConversationAfterRelaunch(
    paths,
    { conversationId: 'conv_1234567890', message: 'Continue task', agentApiExe: fakeAgentApi },
    { ...env, ELECTRON_RUN_AS_NODE: '1' },
    {
      previousHubPids: new Set([101]),
      runtime: 'linux',
      timeoutMs: 2000,
      pollIntervalMs: 5,
      postHubReadyDelayMs: 0,
      delayFn: async () => {},
      discoverFn: async (_probeEnv, opts) => {
        pollCount += 1;
        assert.equal(opts.excludePids.has(101), true);
        if (pollCount < 2) return null;
        return { lsAddress: 'http://127.0.0.1:45678', csrfToken: 'new-csrf', pid: 202 };
      },
      execFn: (bin, args, opts) => {
        execCalls.push({ bin, args, env: opts.env });
      },
    }
  );

  assert.equal(res.ok, true);
  assert.equal(res.pid, 202);
  assert.equal(execCalls.length, 1);
  assert.deepEqual(execCalls[0].args, ['send-message', 'conv_1234567890', 'Continue task']);
  assert.equal(execCalls[0].env.ANTIGRAVITY_LS_ADDRESS, 'http://127.0.0.1:45678');
  assert.equal(execCalls[0].env.ANTIGRAVITY_CSRF_TOKEN, 'new-csrf');
  assert.equal(execCalls[0].env.ELECTRON_RUN_AS_NODE, undefined);
});

test('Sidecar /api/settings/update, quota snapshot refresh, and UI CSP invariants', async (t) => {
  const { paths, env } = makeSandbox(t);
  const activeAcc = importAccount(paths, {
    credentialText: makeSampleToken('active@example.com', '1//refresh-active'),
    label: 'Active',
  });
  const backupAcc = importAccount(paths, {
    credentialText: makeSampleToken('backup@example.com', '1//refresh-backup'),
    label: 'Backup',
  });

  const srv = await createApp({
    sidecarSdk: createFakeSidecarSdk(),
    env,
    port: 0,
    uiToken: 'guard-ui-token',
    quotaPollIntervalMs: 0,
    getUserStatus: async () => ({ lsConnected: true, email: 'active@example.com', tierName: 'Google AI Pro' }),
    cloudCodeService: {
      fetchAccountUsage: async ({ id }) => {
        if (id === activeAcc.id) {
          return {
            id,
            tierName: 'Google AI Pro',
            usage: {
              groups: [
                {
                  displayName: 'Gemini Models',
                  buckets: [
                    { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.08 },
                    { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.75 },
                  ],
                },
              ],
            },
          };
        }
        return {
          id: backupAcc.id,
          tierName: 'Google AI Ultra',
          usage: {
            groups: [
              {
                displayName: 'Gemini Models',
                buckets: [
                  { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.95 },
                  { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.99 },
                ],
              },
            ],
          },
        };
      },
    },
  });

  const httpServer = await srv.start();
  t.after(async () => {
    await srv.close();
  });

  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  const updateRes = await fetch(`${baseUrl}/api/settings/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': 'guard-ui-token' },
    body: JSON.stringify({
      alertEnabled: true,
      thresholdPercent: 10,
      autoSwitchEnabled: true,
      autoResumeEnabled: true,
    }),
  });
  assert.equal(updateRes.status, 200);
  const updateJson = await updateRes.json();
  assert.equal(updateJson.settings.autoSwitchEnabled, true);
  assert.equal(updateJson.quotaAlert.triggered, true);
  assert.equal(updateJson.quotaAlert.bestCandidate.id, backupAcc.id);
  assert.equal(JSON.stringify(updateJson.quotaAlert).includes('1//'), false);
  assert.equal(JSON.stringify(updateJson.quotaAlert).includes('backup@example.com'), false);

  if (process.platform !== 'win32') {
    assert.equal(lstatSync(paths.settingsPath).mode & 0o777, 0o600);
    assert.equal(lstatSync(paths.quotaAlertPath).mode & 0o777, 0o600);
  }

  // UI strict CSP checks
  const html = readFileSync(join(REPO_ROOT, 'sidecars', 'switcher', 'public', 'index.html'), 'utf8');
  const appJs = readFileSync(join(REPO_ROOT, 'sidecars', 'switcher', 'public', 'app.js'), 'utf8');
  assert.equal(html.includes('guard-settings-form'), true);
  assert.equal(/\bstyle\s*=/.test(html), false);
  assert.equal(/\bon\w+\s*=/.test(html), false);
  assert.equal(appJs.includes('innerHTML'), false);
  assert.equal(/\b(alert|confirm|prompt)\s*\(/.test(appJs), false);
});

test('MCP server handles stdio JSON-RPC, active-work exclusion, pickBest, and zero token leaks', async (t) => {
  const { paths, env, dataDir } = makeSandbox(t);
  const activeAcc = importAccount(paths, {
    credentialText: makeSampleToken('active@example.com', '1//secret-active-rt'),
    label: 'Active',
  });
  const backupAcc = importAccount(paths, {
    credentialText: makeSampleToken('backup@example.com', '1//secret-backup-rt'),
    label: 'Backup',
  });

  const spawnedJobs = [];
  let activeTrajectories = {
    'conv-self': { status: 'CASCADE_RUN_STATUS_RUNNING', summary: 'Self conversation' },
    'conv-other': { status: 'CASCADE_RUN_STATUS_RUNNING', summary: 'Other user conversation' },
  };

  const mcp = createMcpHandlers({
    env,
    discoverLiveHub: async () => ({
      lsAddress: 'http://127.0.0.1:41234',
      csrfToken: 'test-csrf',
      pid: 1234,
      userStatus: { email: 'active@example.com', userTier: { name: 'Google AI Pro' } },
    }),
    detectActiveWork: async (_lsEnv, opts) => {
      const items = extractActiveItemsFromLs({
        trajectories: { trajectorySummaries: activeTrajectories },
        excludeConversationIds: opts?.excludeConversationIds || [],
      });
      return { busy: items.length > 0, count: items.length, items, truncated: false };
    },
    cloudCodeService: {
      fetchAccountUsage: async ({ id }) => ({
        id,
        tierName: 'Google AI Pro',
        usage: {
          groups: [
            {
              displayName: 'Gemini Models',
              buckets:
                id === activeAcc.id
                  ? [
                      { bucketId: 'gemini-weekly', remainingFraction: 0.05 },
                      { bucketId: 'gemini-5h', remainingFraction: 0.5 },
                    ]
                  : [
                      { bucketId: 'gemini-weekly', remainingFraction: 0.9 },
                      { bucketId: 'gemini-5h', remainingFraction: 0.92 },
                    ],
            },
          ],
        },
      }),
    },
    spawnWorker: async (jobPath) => {
      spawnedJobs.push(jobPath);
    },
  });

  saveGuardSettings(paths, { autoSwitchEnabled: true, autoResumeEnabled: true, switchDelaySec: 3 });

  // 1. list_accounts & get_quota never leak tokens
  const listRes = await mcp.handleJsonRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'list_accounts', arguments: {} },
  });
  const listText = listRes.result.content[0].text;
  assert.equal(listText.includes('1//'), false);
  assert.equal(listText.includes('active@example.com'), false);

  const quotaRes = await mcp.handleJsonRpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'get_quota', arguments: { includeAll: true } },
  });
  const quotaPayload = JSON.parse(quotaRes.result.content[0].text);
  assert.equal(quotaPayload.bestCandidate.id, backupAcc.id);

  // 2. Blocked when conv-other is active
  const blockedRes = await mcp.handleJsonRpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'switch_account',
      arguments: { pickBest: true, conversationId: 'conv-self', reason: 'low quota' },
    },
  });
  assert.equal(blockedRes.result.isError, true);
  assert.equal(JSON.parse(blockedRes.result.content[0].text).code, 'ACTIVE_WORK_RUNNING');
  assert.equal(spawnedJobs.length, 0);

  // 3. Succeeds once only conv-self is running
  activeTrajectories = {
    'conv-self': { status: 'CASCADE_RUN_STATUS_RUNNING', summary: 'Self conversation' },
  };
  const okRes = await mcp.handleJsonRpc({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'switch_account',
      arguments: { pickBest: true, conversationId: 'conv-self', reason: 'low quota' },
    },
  });
  assert.equal(okRes.result.isError, undefined);
  const okPayload = JSON.parse(okRes.result.content[0].text);
  assert.equal(okPayload.ok, true);
  assert.equal(okPayload.targetAccountId, backupAcc.id);
  assert.equal(okPayload.autoResumeScheduled, true);
  assert.equal(okPayload.message.includes('将在本轮回复完成后（最多 10 秒）自动关闭并重启 Antigravity'), true);
  assert.equal(spawnedJobs.length, 1);

  const encryptedJob = JSON.parse(readFileSync(spawnedJobs[0], 'utf8'));
  const decryptedJob = decryptPayload(encryptedJob, getOrCreateKey(paths));
  assert.deepEqual(decryptedJob.waitConversationIdle, {
    conversationId: 'conv-self',
    minDelayMs: 1500,
    maxWaitMs: 10000,
    fallbackDelayMs: 3000,
  });

  // Real subprocess stdio JSON-RPC test (newline + Content-Length framing)
  const child = spawn(process.execPath, [MCP_SERVER_PATH], {
    env: { ...process.env, ANTIGRAVITY_GEMINI_DIR: env.ANTIGRAVITY_GEMINI_DIR, ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill();
  });

  const responses = [];
  let buf = Buffer.alloc(0);
  const waitResponses = (count) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${count} MCP responses`)), 5000);
      const check = () => {
        if (responses.length >= count) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const parsed = parseJsonRpcBuffer(buf);
        buf = parsed.rest;
        for (const item of parsed.messages) responses.push(item.msg);
        check();
      });
      check();
    });

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: {} }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} }) + '\n');
  const statusReq = JSON.stringify({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'get_switcher_status', arguments: {} },
  });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(statusReq)}\r\n\r\n${statusReq}`);

  await waitResponses(3);
  child.stdin.end();
  assert.equal(responses[0].id, 10);
  assert.equal(responses[1].id, 11);
  assert.equal(responses[1].result.tools.length, 4);
  assert.equal(responses[2].id, 12);
  const statusJson = JSON.parse(responses[2].result.content[0].text);
  assert.equal(statusJson.accountCount, 2);
});

test('quota-hook injects once per conversation, deduplicates, clears on recovery, and fails open', async (t) => {
  const { paths, env } = makeSandbox(t);
  saveGuardSettings(paths, {
    alertEnabled: true,
    autoSwitchEnabled: true,
    autoResumeEnabled: false,
    thresholdPercent: 10,
  });

  writeQuotaAlertSnapshot(paths, {
    activeAccountId: 'acc-1',
    activeMaskedEmail: 'a***@example.com',
    triggered: true,
    triggeredBuckets: ['gemini-weekly'],
    weeklyPercent: 9,
    fiveHourPercent: 80,
    thresholdPercent: 10,
    settings: loadGuardSettings(paths),
    bestCandidate: {
      id: 'acc-2',
      maskedEmail: 'b***@example.com',
      label: 'Backup',
      tierName: 'Google AI Ultra',
      weeklyPercent: 95,
      fiveHourPercent: 100,
    },
  });

  // 1. Real subprocess execution with low-quota snapshot -> injects once
  const runHook = (stdinText) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [QUOTA_HOOK_PATH], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out, err }));
      child.stdin.end(stdinText);
    });

  const startedAt = Date.now();
  const firstRun = await runHook(JSON.stringify({ conversationId: 'conv-hook-1', invocationNum: 2 }));
  const elapsedMs = Date.now() - startedAt;
  assert.equal(firstRun.code, 0);
  assert.ok(elapsedMs < 5000, `Hook took unexpectedly long: ${elapsedMs}ms`);
  const firstJson = JSON.parse(firstRun.out);
  assert.equal(firstJson.injectSteps.length, 1);
  const injectedText = firstJson.injectSteps[0].systemMessage.systemMessage;
  assert.equal(injectedText.includes('周额度剩余 9%'), true);
  assert.equal(injectedText.includes('conv-hook-1'), true);
  assert.equal(injectedText.includes('switch_account'), true);
  assert.equal(injectedText.includes('Backup / b***@example.com'), true);

  // 2. Second invocation in same conversation deduplicates cleanly
  const secondRun = await runHook(JSON.stringify({ conversationId: 'conv-hook-1', invocationNum: 3 }));
  assert.equal(secondRun.code, 0);
  assert.deepEqual(JSON.parse(secondRun.out), { injectSteps: [] });

  // 3. Different conversation still gets alerted
  const otherConv = evaluateHookInput({ conversationId: 'conv-hook-2' }, env);
  assert.equal(otherConv.injectSteps.length, 1);

  // 4. Recovery clears conversation dedup state so future drop can alert again
  writeQuotaAlertSnapshot(paths, {
    activeAccountId: 'acc-2',
    activeMaskedEmail: 'b***@example.com',
    triggered: false,
    triggeredBuckets: [],
    weeklyPercent: 95,
    fiveHourPercent: 100,
    thresholdPercent: 10,
    settings: loadGuardSettings(paths),
  });
  assert.deepEqual(evaluateHookInput({ conversationId: 'conv-hook-1' }, env), { injectSteps: [] });

  // 5. Malformed stdin fails open with exit 0 and empty injectSteps
  const badRun = await runHook('{not-valid-json');
  assert.equal(badRun.code, 0);
  assert.deepEqual(JSON.parse(badRun.out), { injectSteps: [] });

  // 6. Symlinked snapshot is rejected fail-open on Unix
  if (process.platform !== 'win32') {
    rmSync(paths.quotaAlertPath, { force: true });
    symlinkSync(paths.settingsPath, paths.quotaAlertPath);
    assert.deepEqual(evaluateHookInput({ conversationId: 'conv-hook-3' }, env), { injectSteps: [] });
  }
});

test('syncOnboardingLastLoginUsername updates existing onboarding keys safely and rejects missing/unsafe/unaccepted targets', (t) => {
  const { root } = makeSandbox(t);

  // a) Updates agy.onboarding.lastLoginUsername, sets lastLoginIsGcpTos='false', removes jetski.onboarding.*, preserves other keys
  const storageA = join(root, 'app_storage_a.json');
  writeFileSync(
    storageA,
    JSON.stringify(
      {
        runInBackground: true,
        zoomLevel: 1.25,
        'agy.onboarding.lastLoginUsername': 'old@example.com',
        'agy.onboarding.lastLoginIsGcpTos': 'true',
        'jetski.onboarding.lastLoginUsername': 'legacy@example.com',
        'jetski.onboarding.lastLoginIsGcpTos': 'true',
      },
      null,
      2
    )
  );
  const resA = syncOnboardingLastLoginUsername('  new@example.com  ', {}, 'linux', { storagePath: storageA });
  assert.deepEqual(resA, { updated: true, reason: 'UPDATED' });
  const parsedA = JSON.parse(readFileSync(storageA, 'utf8'));
  assert.equal(parsedA['agy.onboarding.lastLoginUsername'], 'new@example.com');
  assert.equal(parsedA['agy.onboarding.lastLoginIsGcpTos'], 'false');
  assert.equal('jetski.onboarding.lastLoginUsername' in parsedA, false);
  assert.equal('jetski.onboarding.lastLoginIsGcpTos' in parsedA, false);
  assert.equal(parsedA.runInBackground, true);
  assert.equal(parsedA.zoomLevel, 1.25);

  // Also works when only legacy jetski.onboarding.lastLoginUsername exists
  const storageLegacy = join(root, 'app_storage_legacy.json');
  writeFileSync(
    storageLegacy,
    JSON.stringify({
      runInBackground: false,
      'jetski.onboarding.lastLoginUsername': 'legacy@example.com',
      'jetski.onboarding.lastLoginIsGcpTos': 'true',
    })
  );
  assert.deepEqual(
    syncOnboardingLastLoginUsername('migrated@example.com', {}, 'linux', { storagePath: storageLegacy }),
    { updated: true, reason: 'UPDATED' }
  );
  const parsedLegacy = JSON.parse(readFileSync(storageLegacy, 'utf8'));
  assert.equal(parsedLegacy['agy.onboarding.lastLoginUsername'], 'migrated@example.com');
  assert.equal(parsedLegacy['agy.onboarding.lastLoginIsGcpTos'], 'false');
  assert.equal('jetski.onboarding.lastLoginUsername' in parsedLegacy, false);
  assert.equal('jetski.onboarding.lastLoginIsGcpTos' in parsedLegacy, false);
  assert.equal(parsedLegacy.runInBackground, false);

  // b) Missing prior lastLoginUsername returns NO_PRIOR_ACCEPTANCE and leaves file untouched
  const storageB = join(root, 'app_storage_b.json');
  const rawB = '{"runInBackground":true,"zoomLevel":0}';
  writeFileSync(storageB, rawB);
  const resB = syncOnboardingLastLoginUsername('new@example.com', {}, 'linux', { storagePath: storageB });
  assert.deepEqual(resB, { updated: false, reason: 'NO_PRIOR_ACCEPTANCE' });
  assert.equal(readFileSync(storageB, 'utf8'), rawB);

  // c) Corrupted JSON, array JSON, empty email, and missing file return safely without throwing
  const storageCorrupt = join(root, 'app_storage_corrupt.json');
  writeFileSync(storageCorrupt, '{broken-json');
  assert.deepEqual(
    syncOnboardingLastLoginUsername('new@example.com', {}, 'linux', { storagePath: storageCorrupt }),
    { updated: false, reason: 'INVALID_JSON' }
  );
  assert.equal(readFileSync(storageCorrupt, 'utf8'), '{broken-json');

  const storageArray = join(root, 'app_storage_array.json');
  writeFileSync(storageArray, '[]');
  assert.deepEqual(
    syncOnboardingLastLoginUsername('new@example.com', {}, 'linux', { storagePath: storageArray }),
    { updated: false, reason: 'INVALID_JSON' }
  );

  assert.deepEqual(
    syncOnboardingLastLoginUsername('new@example.com', {}, 'linux', { storagePath: join(root, 'missing.json') }),
    { updated: false, reason: 'MISSING_OR_UNSAFE' }
  );
  assert.deepEqual(
    syncOnboardingLastLoginUsername('   ', {}, 'linux', { storagePath: storageA }),
    { updated: false, reason: 'EMPTY_EMAIL' }
  );

  // d) Non-win32 symlink target returns MISSING_OR_UNSAFE and leaves target untouched
  if (process.platform !== 'win32') {
    const symlinkTarget = join(root, 'real_app_storage.json');
    const symlinkPath = join(root, 'symlink_app_storage.json');
    const targetRaw = JSON.stringify({ 'agy.onboarding.lastLoginUsername': 'keep@example.com' });
    writeFileSync(symlinkTarget, targetRaw);
    symlinkSync(symlinkTarget, symlinkPath);
    const resSym = syncOnboardingLastLoginUsername('evil@example.com', {}, 'linux', { storagePath: symlinkPath });
    assert.deepEqual(resSym, { updated: false, reason: 'MISSING_OR_UNSAFE' });
    assert.equal(readFileSync(symlinkTarget, 'utf8'), targetRaw);
  }
});

test('waitForConversationIdleBeforeStop settles early on IDLE, falls back on RPC unavailable, and clamps job config', async (t) => {
  const { paths, env } = makeSandbox(t);
  const acc = importAccount(paths, {
    credentialText: makeSampleToken('idlecheck@example.com', '1//refresh-idle'),
    label: 'IdleCheck',
  });

  // 1. prepareSwitchJob validates & clamps waitConversationIdle bounds
  const clampedJob = prepareSwitchJob(paths, {
    mode: 'switch',
    accountId: acc.id,
    env,
    waitConversationIdle: {
      conversationId: 'conv_clamp_1234',
      minDelayMs: -50,
      maxWaitMs: 99999,
      fallbackDelayMs: 25000,
    },
  });
  const decrypted = decryptPayload(JSON.parse(readFileSync(clampedJob.jobPath, 'utf8')), getOrCreateKey(paths));
  assert.deepEqual(decrypted.waitConversationIdle, {
    conversationId: 'conv_clamp_1234',
    minDelayMs: 0,
    maxWaitMs: 20000,
    fallbackDelayMs: 15000,
  });

  // 2. Invalid conversationId exits immediately
  const invalidRes = await waitForConversationIdleBeforeStop(paths, { conversationId: 'bad' }, env);
  assert.deepEqual(invalidRes, { settled: false, reason: 'INVALID_CONVERSATION_ID', waitedMs: 0 });

  // 3. Polls twice RUNNING, settles on 3rd call IDLE
  let rpcCount = 0;
  const delays = [];
  const idleRes = await waitForConversationIdleBeforeStop(
    paths,
    { conversationId: 'conv_idle_1234', minDelayMs: 1200, maxWaitMs: 10000, fallbackDelayMs: 3000 },
    env,
    {
      pollIntervalMs: 400,
      delayFn: async (ms) => {
        delays.push(ms);
      },
      rpcFn: async () => {
        rpcCount += 1;
        if (rpcCount < 3) {
          return { trajectorySummaries: { conv_idle_1234: { status: 'CASCADE_RUN_STATUS_RUNNING' } } };
        }
        return { trajectorySummaries: { conv_idle_1234: { status: 'CASCADE_RUN_STATUS_IDLE' } } };
      },
    }
  );
  assert.equal(idleRes.settled, true);
  assert.equal(idleRes.reason, 'IDLE');
  assert.equal(rpcCount, 3);
  assert.deepEqual(delays, [1200, 400, 400]);
  const logText = readFileSync(paths.logPath, 'utf8');
  assert.equal(logText.includes('TURN_IDLE_BEFORE_STOP cid=conv_idle_1234'), true);

  // 4. RPC unavailable falls back safely without throwing
  const rpcFailDelays = [];
  const unavailableRes = await waitForConversationIdleBeforeStop(
    paths,
    { conversationId: 'conv_rpc_down_1', minDelayMs: 1500, maxWaitMs: 10000, fallbackDelayMs: 3000 },
    env,
    {
      delayFn: async (ms) => {
        rpcFailDelays.push(ms);
      },
      rpcFn: async () => null,
    }
  );
  assert.equal(unavailableRes.settled, false);
  assert.equal(unavailableRes.reason, 'RPC_UNAVAILABLE');
  assert.equal(rpcFailDelays[0], 1500);
  assert.equal(rpcFailDelays.length, 2);
});

test('resumeConversationAfterRelaunch waits postHubReadyDelayMs after hub discovery before sending message', async (t) => {
  const { paths, env, root } = makeSandbox(t);
  const fakeAgentApi = join(root, 'agentapi');
  writeFileSync(fakeAgentApi, '#!/bin/sh\nexit 0\n');

  const events = [];
  let pollCount = 0;
  const res = await resumeConversationAfterRelaunch(
    paths,
    { conversationId: 'conv_wait_mcp_1', message: 'Continue after MCP ready', agentApiExe: fakeAgentApi },
    env,
    {
      runtime: 'linux',
      timeoutMs: 2000,
      pollIntervalMs: 50,
      postHubReadyDelayMs: 2750,
      delayFn: async (ms) => {
        events.push(`delay:${ms}`);
      },
      discoverFn: async () => {
        pollCount += 1;
        events.push(`discover:${pollCount}`);
        if (pollCount < 2) return null;
        return { lsAddress: 'http://127.0.0.1:45679', csrfToken: 'mcp-ready-csrf', pid: 303 };
      },
      execFn: (_bin, args) => {
        events.push(`exec:${args[0]}`);
      },
    }
  );

  assert.equal(res.ok, true);
  assert.equal(res.pid, 303);
  assert.deepEqual(events, ['discover:1', 'delay:50', 'discover:2', 'delay:2750', 'exec:send-message']);
  const logText = readFileSync(paths.logPath, 'utf8');
  assert.equal(logText.includes('AUTO_RESUME_WAIT_MCP ms=2750'), true);
});
