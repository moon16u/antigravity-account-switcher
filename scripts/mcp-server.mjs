import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { callLsRpc, detectActiveWork } from '../sidecars/switcher/active-work.mjs';
import { createCloudCodeService } from '../sidecars/switcher/cloudcode.mjs';
import { resolveWindowsDirs, spawnDetachedWorker } from '../sidecars/switcher/platform.mjs';
import {
  discoverLiveHub,
  evaluateQuotaAlert,
  loadGuardSettings,
  pickBestBackupAccount,
  readQuotaAlertSnapshot,
} from '../sidecars/switcher/quota-guard.mjs';
import {
  appendSwitchLog,
  listPublicAccounts,
  maskEmail,
  normalizeEmail,
  prepareSwitchJob,
  readActiveToken,
  resolvePaths,
  sanitizeActiveState,
  UUID_RE,
} from '../sidecars/switcher/vault.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(__dirname, '..', 'sidecars', 'switcher', 'switcher-worker.mjs');
const MAX_RPC_BUFFER_BYTES = 2 * 1024 * 1024;
const SERVER_VERSION = '0.3.0';

export const MCP_TOOLS = Object.freeze([
  {
    name: 'get_switcher_status',
    description:
      'Get sanitized active Antigravity account status, saved account count, quota guard settings, and latest low-quota snapshot.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'list_accounts',
    description:
      'List all saved Antigravity accounts with masked emails, labels, subscription tiers, and active status (never returns tokens).',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_quota',
    description:
      'Fetch real-time Gemini & 3P quota summary for the active account, a specific saved account, or all saved accounts, plus threshold alert evaluation and best healthy backup candidate.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: {
          type: 'string',
          description: 'Optional saved account UUID. Omit to query the active account (or all when includeAll is true).',
        },
        includeAll: {
          type: 'boolean',
          description: 'Set true to fetch quota summaries across all saved accounts and pick the best backup.',
        },
        forceRefresh: {
          type: 'boolean',
          description: 'Set true to bypass the 30s quota cache.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'switch_account',
    description:
      'Safely switch the active Antigravity account and restart the desktop app after a short delay (default 3s). Checks active conversations/tasks/terminals first, excluding the caller conversationId when provided.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: {
          type: 'string',
          description: 'Target saved account UUID. Optional when pickBest is true.',
        },
        pickBest: {
          type: 'boolean',
          description: 'When true and accountId is omitted, automatically picks the backup account with the highest remaining Gemini quota above threshold.',
        },
        conversationId: {
          type: 'string',
          description: 'Current Antigravity conversationId so active-work detection excludes this conversation and optional auto-resume can wake it after restart.',
        },
        reason: {
          type: 'string',
          description: 'Optional short reason recorded in the sanitized switch audit log.',
        },
        resumeMessage: {
          type: 'string',
          description: 'Optional prompt sent to conversationId after restart when autoResumeEnabled is turned on.',
        },
        force: {
          type: 'boolean',
          description: 'Force switch even if other active tasks or terminals are running (only use after explicit user confirmation).',
        },
      },
      additionalProperties: false,
    },
  },
]);

function toolResult(payload, isError = false) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

export function createMcpHandlers(options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  const paths = resolvePaths(env, options.pathOverrides);
  const discoverHubFn = options.discoverLiveHub || discoverLiveHub;
  const detectActiveWorkFn = options.detectActiveWork || detectActiveWork;
  const spawnWorker =
    options.spawnWorker ||
    ((jobPath, dataDir = paths.dataDir, workerEnv = env) =>
      spawnDetachedWorker(WORKER_SCRIPT, jobPath, workerEnv, undefined, { dataDir }));

  async function resolveLiveContext() {
    const liveHub = await discoverHubFn(env, { appDataDir: paths.appDataDir }).catch(() => null);
    const lsConnected = Boolean(liveHub);
    const lsEnv = liveHub
      ? {
          ...env,
          ANTIGRAVITY_LS_ADDRESS: liveHub.lsAddress,
          ANTIGRAVITY_CSRF_TOKEN: liveHub.csrfToken,
          ...(liveHub.lsVersion ? { ANTIGRAVITY_LS_VERSION: liveHub.lsVersion } : {}),
        }
      : { ...env };
    const lsEmail = normalizeEmail(liveHub?.userStatus?.email || '');
    const lsTierName = typeof liveHub?.userStatus?.userTier?.name === 'string' ? liveHub.userStatus.userTier.name : '';
    const active = readActiveToken(paths, lsEnv);
    const effectiveActiveEmail = normalizeEmail((lsConnected ? lsEmail : '') || active.email);
    const accounts = listPublicAccounts(paths, effectiveActiveEmail, {
      revealEmails: false,
      activeTierName: lsConnected ? lsTierName : '',
    });
    const activeAccount = accounts.find((a) => a.isActive) || null;
    const cloudCode =
      options.cloudCodeService ||
      createCloudCodeService({
        paths,
        env: lsEnv,
        callLsRpcFn: options.callLsRpc || callLsRpc,
        ...(options.oauthOptions?.loadClients ? { loadClients: options.oauthOptions.loadClients } : {}),
        ...(options.oauthOptions?.requestFn ? { requestFn: options.oauthOptions.requestFn } : {}),
        ...(options.cloudCodeOptions || {}),
      });

    return {
      liveHub,
      lsConnected,
      lsEnv,
      lsEmail,
      lsTierName,
      active,
      effectiveActiveEmail,
      accounts,
      activeAccount,
      cloudCode,
    };
  }

  async function handleToolCall(name, rawArgs = {}) {
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};

    if (name === 'get_switcher_status') {
      const ctx = await resolveLiveContext();
      return toolResult({
        ok: true,
        lsConnected: ctx.lsConnected,
        active: sanitizeActiveState(
          ctx.active,
          { lsConnected: ctx.lsConnected, email: ctx.lsEmail, tierName: ctx.lsTierName },
          { revealEmail: false }
        ),
        activeAccountId: ctx.activeAccount?.id || '',
        accountCount: ctx.accounts.length,
        settings: loadGuardSettings(paths),
        quotaAlert: readQuotaAlertSnapshot(paths),
      });
    }

    if (name === 'list_accounts') {
      const ctx = await resolveLiveContext();
      return toolResult({
        ok: true,
        lsConnected: ctx.lsConnected,
        accounts: ctx.accounts,
      });
    }

    if (name === 'get_quota') {
      const ctx = await resolveLiveContext();
      const settings = loadGuardSettings(paths);
      const forceRefresh = Boolean(args.forceRefresh);
      const includeAll = Boolean(args.includeAll);
      const requestedId = typeof args.accountId === 'string' ? args.accountId.trim() : '';

      if (requestedId && !UUID_RE.test(requestedId)) {
        return toolResult({ ok: false, code: 'INVALID_ACCOUNT_ID', message: 'Invalid accountId UUID.' }, true);
      }

      let targets = [];
      if (includeAll) {
        targets = ctx.accounts;
      } else if (requestedId) {
        const match = ctx.accounts.find((a) => a.id === requestedId);
        if (!match) {
          return toolResult({ ok: false, code: 'ACCOUNT_NOT_FOUND', message: 'Account not found in vault.' }, true);
        }
        targets = [match];
      } else if (ctx.activeAccount) {
        targets = [ctx.activeAccount];
      } else {
        return toolResult(
          {
            ok: false,
            code: 'NO_SAVED_ACTIVE_ACCOUNT',
            message: 'No saved active account found in vault; pass includeAll: true or save the current account first.',
          },
          true
        );
      }

      const usageById = new Map();
      const results = [];
      for (const acc of targets) {
        try {
          const res = await ctx.cloudCode.fetchAccountUsage({
            id: acc.id,
            activeEmail: ctx.effectiveActiveEmail,
            lsConnected: ctx.lsConnected,
            forceRefresh,
          });
          usageById.set(acc.id, res.usage);
          results.push({
            id: acc.id,
            maskedEmail: acc.maskedEmail,
            label: acc.label,
            tierName: res.tierName || acc.tierName || '',
            isActive: acc.isActive,
            alert: evaluateQuotaAlert(res.usage, settings),
            usage: res.usage,
          });
        } catch (err) {
          results.push({
            id: acc.id,
            maskedEmail: acc.maskedEmail,
            label: acc.label,
            tierName: acc.tierName || '',
            isActive: acc.isActive,
            error: err?.message || 'USAGE_FETCH_FAILED',
          });
        }
      }

      const bestCandidate = includeAll
        ? pickBestBackupAccount(ctx.accounts, usageById, {
            activeAccountId: ctx.activeAccount?.id || '',
            activeEmail: ctx.effectiveActiveEmail,
            thresholdPercent: settings.thresholdPercent,
          })
        : null;

      return toolResult({
        ok: true,
        thresholdPercent: settings.thresholdPercent,
        accounts: results,
        ...(includeAll ? { bestCandidate } : {}),
      });
    }

    if (name === 'switch_account') {
      const ctx = await resolveLiveContext();
      const settings = loadGuardSettings(paths);
      const cid = typeof args.conversationId === 'string' ? args.conversationId.trim() : '';
      const force = Boolean(args.force);
      let targetAccountId = typeof args.accountId === 'string' ? args.accountId.trim() : '';

      if (targetAccountId && !UUID_RE.test(targetAccountId)) {
        return toolResult({ ok: false, code: 'INVALID_ACCOUNT_ID', message: 'Invalid accountId UUID.' }, true);
      }

      if (!targetAccountId) {
        if (!args.pickBest) {
          return toolResult(
            {
              ok: false,
              code: 'MISSING_ACCOUNT_ID',
              message: 'Provide accountId or set pickBest: true to select the healthiest backup account.',
            },
            true
          );
        }
        const candidates = ctx.accounts.filter((a) => !a.isActive);
        if (candidates.length === 0) {
          return toolResult(
            { ok: false, code: 'NO_BACKUP_ACCOUNT', message: 'No saved backup accounts available.' },
            true
          );
        }
        const usageById = new Map();
        await Promise.allSettled(
          candidates.map(async (acc) => {
            const res = await ctx.cloudCode.fetchAccountUsage({
              id: acc.id,
              activeEmail: ctx.effectiveActiveEmail,
              lsConnected: ctx.lsConnected,
              forceRefresh: false,
            });
            if (res?.usage) {
              usageById.set(acc.id, res.usage);
            }
          })
        );
        const best = pickBestBackupAccount(ctx.accounts, usageById, {
          activeAccountId: ctx.activeAccount?.id || '',
          activeEmail: ctx.effectiveActiveEmail,
          thresholdPercent: settings.thresholdPercent,
        });
        if (!best) {
          return toolResult(
            {
              ok: false,
              code: 'NO_HEALTHY_BACKUP_ACCOUNT',
              message: `No backup account has remaining Gemini quota above ${settings.thresholdPercent}%.`,
            },
            true
          );
        }
        targetAccountId = best.id;
      }

      if (!ctx.accounts.some((a) => a.id === targetAccountId)) {
        return toolResult({ ok: false, code: 'ACCOUNT_NOT_FOUND', message: 'Target account not found.' }, true);
      }

      if (!force) {
        const activeWork = await detectActiveWorkFn(ctx.lsEnv, {
          excludeConversationIds: cid ? [cid] : [],
        });
        if (activeWork?.busy) {
          return toolResult(
            {
              ok: false,
              code: 'ACTIVE_WORK_RUNNING',
              message: 'Other active conversations, background tasks, or terminals are running; switch paused.',
              activeWork,
            },
            true
          );
        }
      } else {
        try {
          appendSwitchLog(paths, 'FORCE_SWITCH_REQUESTED mode=switch source=mcp');
        } catch {
          // Best-effort audit log
        }
      }

      const safeReason =
        typeof args.reason === 'string'
          ? args.reason.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80)
          : 'agent-requested';
      try {
        appendSwitchLog(paths, `MCP_SWITCH_REQUESTED target=${targetAccountId} reason=${safeReason || 'agent'}`);
      } catch {
        // Best-effort audit log
      }

      const winDirs = resolveWindowsDirs(ctx.lsEnv);
      const jobContext = {
        ...(winDirs.appData ? { appData: winDirs.appData } : {}),
        ...(winDirs.localAppData ? { localAppData: winDirs.localAppData } : {}),
        ...(ctx.lsEnv.ANTIGRAVITY_SWITCHER_RELAUNCH_EXE
          ? { relaunchExe: String(ctx.lsEnv.ANTIGRAVITY_SWITCHER_RELAUNCH_EXE).trim() }
          : {}),
        ...(ctx.lsEnv.ANTIGRAVITY_APP_STORAGE_PATH
          ? { appStoragePath: String(ctx.lsEnv.ANTIGRAVITY_APP_STORAGE_PATH).trim() }
          : {}),
        ...(ctx.lsEnv.ANTIGRAVITY_GEMINI_DIR ? { geminiDir: String(ctx.lsEnv.ANTIGRAVITY_GEMINI_DIR).trim() } : {}),
      };

      const delayMs = settings.switchDelaySec * 1000;
      const resume =
        settings.autoResumeEnabled && cid
          ? {
              conversationId: cid,
              message:
                typeof args.resumeMessage === 'string' && args.resumeMessage.trim()
                  ? args.resumeMessage.trim()
                  : '账号已切换完成，请继续刚才未完成的任务。',
              agentApiExe: String(ctx.lsEnv.ANTIGRAVITY_AGENTAPI_EXE || '').trim(),
            }
          : null;

      const job = prepareSwitchJob(paths, {
        mode: 'switch',
        accountId: targetAccountId,
        fallbackEmail: ctx.lsEmail,
        env: ctx.lsEnv,
        context: jobContext,
        delayMs,
        resume,
      });

      await spawnWorker(job.jobPath, paths.dataDir, ctx.lsEnv);

      return toolResult({
        ok: true,
        switching: true,
        targetAccountId,
        targetMaskedEmail: job.targetMaskedEmail || maskEmail(ctx.accounts.find((a) => a.id === targetAccountId)?.maskedEmail || ''),
        delaySec: settings.switchDelaySec,
        autoResumeScheduled: Boolean(resume),
        message: `已调度切换到 ${job.targetMaskedEmail}，将在 ${settings.switchDelaySec} 秒后关闭并重启 Antigravity。`,
      });
    }

    return toolResult({ ok: false, code: 'UNKNOWN_TOOL', message: `Unknown tool: ${name}` }, true);
  }

  async function handleJsonRpc(msg) {
    if (!msg || typeof msg !== 'object') {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      };
    }

    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined && msg.id !== null;
    const method = typeof msg.method === 'string' ? msg.method : '';

    if (!hasId) {
      return null;
    }

    if (method === 'initialize') {
      const clientProto = typeof msg?.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2024-11-05';
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: clientProto,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'antigravity-account-switcher',
            version: SERVER_VERSION,
          },
        },
      };
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id: msg.id, result: {} };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: MCP_TOOLS },
      };
    }

    if (method === 'tools/call') {
      try {
        const toolName = typeof msg?.params?.name === 'string' ? msg.params.name : '';
        const toolArgs = msg?.params?.arguments || {};
        const result = await handleToolCall(toolName, toolArgs);
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result,
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: toolResult({ ok: false, error: err?.message || 'INTERNAL_ERROR' }, true),
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }

  return {
    paths,
    handleToolCall,
    handleJsonRpc,
  };
}

export function parseJsonRpcBuffer(buffer) {
  let buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ''), 'utf8');
  const messages = [];
  let framing = 'line';

  while (buf.length > 0) {
    // Skip leading whitespace/newlines
    let start = 0;
    while (start < buf.length && (buf[start] === 0x0d || buf[start] === 0x0a || buf[start] === 0x20 || buf[start] === 0x09)) {
      start += 1;
    }
    if (start > 0) {
      buf = buf.subarray(start);
    }
    if (buf.length === 0) break;

    const headAscii = buf.subarray(0, Math.min(buf.length, 32)).toString('ascii');
    if (/^content-length\s*:/i.test(headAscii)) {
      framing = 'content-length';
      let headerEnd = buf.indexOf('\r\n\r\n');
      let sepLen = 4;
      if (headerEnd < 0) {
        headerEnd = buf.indexOf('\n\n');
        sepLen = 2;
      }
      if (headerEnd < 0) {
        break;
      }
      const headerText = buf.subarray(0, headerEnd).toString('utf8');
      const m = /content-length\s*:\s*(\d+)/i.exec(headerText);
      const len = m ? Number(m[1]) : -1;
      if (!Number.isSafeInteger(len) || len < 0 || len > MAX_RPC_BUFFER_BYTES) {
        buf = buf.subarray(headerEnd + sepLen);
        continue;
      }
      const bodyStart = headerEnd + sepLen;
      if (buf.length < bodyStart + len) {
        break;
      }
      const bodyStr = buf.subarray(bodyStart, bodyStart + len).toString('utf8');
      buf = buf.subarray(bodyStart + len);
      try {
        messages.push({ msg: JSON.parse(bodyStr), framing: 'content-length' });
      } catch {
        // Ignore malformed JSON body
      }
      continue;
    }

    const nlIdx = buf.indexOf('\n');
    if (nlIdx < 0) {
      break;
    }
    const line = buf.subarray(0, nlIdx).toString('utf8').trim();
    buf = buf.subarray(nlIdx + 1);
    if (!line) continue;
    try {
      messages.push({ msg: JSON.parse(line), framing: 'line' });
    } catch {
      // Ignore malformed JSON line
    }
  }

  return { messages, rest: buf, framing };
}

export function startStdioServer(options = {}) {
  const { handleJsonRpc } = createMcpHandlers(options);
  const input = options.stdin || process.stdin;
  const output = options.stdout || process.stdout;
  let pending = Buffer.alloc(0);
  let queue = Promise.resolve();

  function writeFrame(payload, framing) {
    const json = JSON.stringify(payload);
    if (framing === 'content-length') {
      const byteLen = Buffer.byteLength(json, 'utf8');
      output.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
    } else {
      output.write(`${json}\n`);
    }
  }

  input.on('data', (chunk) => {
    const nextBuf = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (nextBuf.length > MAX_RPC_BUFFER_BYTES) {
      pending = Buffer.alloc(0);
      return;
    }
    const parsed = parseJsonRpcBuffer(nextBuf);
    pending = parsed.rest;

    for (const item of parsed.messages) {
      queue = queue.then(async () => {
        const response = await handleJsonRpc(item.msg);
        if (response) {
          writeFrame(response, item.framing);
        }
      });
    }
  });

  input.resume?.();
  return {
    stop: () => {
      input.pause?.();
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
  startStdioServer();
}
