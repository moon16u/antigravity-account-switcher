import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { callLsRpc, detectActiveWork } from '../sidecars/switcher/active-work.mjs';
import { resolveWindowsDirs, spawnDetachedWorker } from '../sidecars/switcher/platform.mjs';
import {
  computeNaturalPauseMs,
  computeSessionThresholds,
  discoverLiveHub,
  evaluateQuotaAlert,
  loadGuardSettings,
  pickBestBackupAccount,
  readQuotaAlertSnapshot,
} from '../sidecars/switcher/quota-guard.mjs';
import { createQuotaService } from '../sidecars/switcher/quota-snapshots.mjs';
import {
  appendSwitchLog,
  CONVERSATION_ID_RE,
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
const SERVER_VERSION = '0.6.0';
const FIXED_RESUME_MESSAGE = '账号已切换完成，请继续刚才未完成的任务。';

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
      'Query real-time Gemini & 3P quota for the active account through the live local language_server RPC, and read local cached snapshots with reset-time projection for inactive accounts (zero remote/internal API calls). Returns threshold alert evaluation and, with includeAll, the healthiest local backup candidate.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: {
          type: 'string',
          description: 'Optional saved account UUID. Omit to query the active account (or all when includeAll is true).',
        },
        includeAll: {
          type: 'boolean',
          description: 'Set true to read quota summaries across all saved accounts and pick the best backup.',
        },
        forceRefresh: {
          type: 'boolean',
          description: 'Set true to bypass the 30s live quota cache for the active account.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'switch_account',
    description:
      'Requires Agent Autonomous Switch (autoSwitchEnabled) in Advanced Settings. It is off by default and returns AGENT_SWITCH_DISABLED when off. Switches the active Antigravity account and restarts the desktop app after a short delay (default 3s). Checks active conversations/tasks/terminals first, excluding the caller conversationId when provided. With pickBest: true, picks the healthiest backup from local quota snapshots/reset projection (never remote internal APIs) and respects guard settings, including opt-in onboarding sync and natural pause.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: {
          type: 'string',
          description: 'Target saved account UUID. Optional when pickBest is true.',
        },
        pickBest: {
          type: 'boolean',
          description:
            'When true and accountId is omitted, automatically picks the healthiest backup from local quota snapshots and reset-time projection, falling back to the least-recently-used unsnapshotted backup.',
        },
        conversationId: {
          type: 'string',
          description: 'Current Antigravity conversationId so active-work detection excludes this conversation and optional auto-resume can wake it after restart.',
        },
        reason: {
          type: 'string',
          description: 'Optional short reason recorded in the sanitized switch audit log.',
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

function attachUsageMeta(candidate, usageById) {
  if (!candidate) return null;
  const meta = usageById instanceof Map ? usageById.get(candidate.id) : null;
  if (!meta) return candidate;
  return {
    ...candidate,
    source: meta.source || 'none',
    capturedAt: meta.capturedAt ?? null,
    isStale: Boolean(meta.isStale),
    estimatedAnyReset: Boolean(meta.estimatedAnyReset),
    hasSnapshot: Boolean(meta.hasSnapshot),
  };
}

export function createMcpHandlers(options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  const paths = resolvePaths(env, options.pathOverrides);
  const discoverHubFn = options.discoverLiveHub || discoverLiveHub;
  const detectActiveWorkFn = options.detectActiveWork || detectActiveWork;
  let quotaContextKey = '';
  let quotaService = options.quotaService;
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
    const contextKey = JSON.stringify([liveHub?.lsAddress, liveHub?.csrfToken, liveHub?.pid, effectiveActiveEmail]);
    if (!options.quotaService && contextKey !== quotaContextKey) {
      quotaService?.invalidateCache();
      quotaContextKey = contextKey;
      quotaService = createQuotaService({
        paths,
        env: lsEnv,
        callLsRpcFn: options.callLsRpc || callLsRpc,
        ...(options.quotaServiceOptions || {}),
      });
    }

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
      quotaService,
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

      const sessionThresholds = computeSessionThresholds(settings.thresholdPercent, {
        dynamicEnabled: settings.dynamicThresholdEnabled !== false,
      });

      const usageById = new Map();
      const results = [];
      for (const acc of targets) {
        try {
          const res =
            (await ctx.quotaService.getAccountUsage({
              id: acc.id,
              activeAccountId: ctx.activeAccount?.id || '',
              activeEmail: ctx.effectiveActiveEmail,
              lsConnected: ctx.lsConnected,
              tierName: acc.tierName,
              forceRefresh,
              syncSource: 'mcp',
            })) || {};
          const usage = res.usage ?? null;
          usageById.set(acc.id, { ...res, usage });
          results.push({
            id: acc.id,
            maskedEmail: acc.maskedEmail,
            label: acc.label,
            tierName: res.tierName || acc.tierName || '',
            isActive: acc.isActive,
            alert: usage ? evaluateQuotaAlert(usage, settings, { sessionThresholds }) : null,
            usage,
            source: res.source || 'none',
            capturedAt: res.capturedAt ?? null,
            isStale: Boolean(res.isStale),
            estimatedAnyReset: Boolean(res.estimatedAnyReset),
            hasSnapshot: Boolean(res.hasSnapshot),
          });
        } catch (err) {
          results.push({
            id: acc.id,
            maskedEmail: acc.maskedEmail,
            label: acc.label,
            tierName: acc.tierName || '',
            isActive: acc.isActive,
            error: err?.message || 'USAGE_FETCH_FAILED',
            alert: null,
            usage: null,
            source: 'none',
            capturedAt: null,
            isStale: false,
            estimatedAnyReset: false,
            hasSnapshot: false,
          });
        }
      }

      const bestCandidate = includeAll
        ? attachUsageMeta(
            pickBestBackupAccount(ctx.accounts, usageById, {
              activeAccountId: ctx.activeAccount?.id || '',
              activeEmail: ctx.effectiveActiveEmail,
              thresholdPercent: settings.thresholdPercent,
            }),
            usageById
          )
        : null;

      return toolResult({
        ok: true,
        thresholdPercent: settings.thresholdPercent,
        sessionThresholds,
        accounts: results,
        ...(includeAll ? { bestCandidate } : {}),
      });
    }

    if (name === 'switch_account') {
      const settings = loadGuardSettings(paths);
      if (!settings.autoSwitchEnabled) {
        return toolResult(
          {
            ok: false,
            code: 'AGENT_SWITCH_DISABLED',
            message:
              'Agent Autonomous Switch is disabled in Advanced Settings. Ask the user to switch accounts manually in the sidebar or enable "Agent Autonomous Switch" first.',
          },
          true
        );
      }
      const ctx = await resolveLiveContext();
      const cid = typeof args.conversationId === 'string' ? args.conversationId.trim() : '';
      const force = Boolean(args.force);
      let targetAccountId = typeof args.accountId === 'string' ? args.accountId.trim() : '';
      let selectionSource = '';
      let selectionReason = '';

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
        const activeAccountId = ctx.activeAccount?.id || '';
        const candidates = ctx.accounts.filter((a) => !a.isActive && (!activeAccountId || a.id !== activeAccountId));
        if (candidates.length === 0) {
          return toolResult(
            { ok: false, code: 'NO_BACKUP_ACCOUNT', message: 'No saved backup accounts available.' },
            true
          );
        }

        // Local-only selection: read cached/projected snapshots. This path never
        // issues remote HTTP or OAuth token-refresh calls.
        const usageById = ctx.quotaService.buildProjectedUsageMap(ctx.accounts, {
          activeAccountId,
        });
        const best = pickBestBackupAccount(ctx.accounts, usageById, {
          activeAccountId,
          activeEmail: ctx.effectiveActiveEmail,
          thresholdPercent: settings.thresholdPercent,
        });

        if (best) {
          targetAccountId = best.id;
          selectionSource = 'snapshot';
        } else {
          // No snapshotted backup is healthy yet. Rather than failing first-time
          // users, fall back to the least-recently-used backup without a usable
          // snapshot. Only fail when every backup has a snapshot below threshold.
          const unsnapshotted = candidates.filter((acc) => {
            const meta = usageById instanceof Map ? usageById.get(acc.id) : usageById?.[acc.id];
            return !meta || !meta.usage || meta.source === 'none';
          });
          if (unsnapshotted.length === 0) {
            return toolResult(
              {
                ok: false,
                code: 'NO_HEALTHY_BACKUP_ACCOUNT',
                message: `No backup account has remaining Gemini quota above ${settings.thresholdPercent}%.`,
              },
              true
            );
          }
          unsnapshotted.sort((a, b) => {
            const aMs = Date.parse(String(a.lastUsedAt || '')) || 0;
            const bMs = Date.parse(String(b.lastUsedAt || '')) || 0;
            return aMs - bMs;
          });
          targetAccountId = unsnapshotted[0].id;
          selectionSource = 'unsnapshotted-fallback';
          selectionReason =
            'No snapshotted backup has quota above threshold; selected the least-recently-used backup without a local snapshot.';
        }
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
      const validCid = CONVERSATION_ID_RE.test(cid) ? cid : '';
      const resume =
        settings.autoResumeEnabled && validCid
          ? {
              conversationId: validCid,
              message: FIXED_RESUME_MESSAGE,
              agentApiExe: String(ctx.lsEnv.ANTIGRAVITY_AGENTAPI_EXE || '').trim(),
            }
          : null;
      const waitConversationIdle = validCid
        ? {
            conversationId: validCid,
            minDelayMs: Math.min(1500, delayMs),
            maxWaitMs: Math.max(10_000, delayMs),
            fallbackDelayMs: delayMs,
          }
        : null;

      // Snapshot the outgoing account's live quota before its token is replaced.
      // Best-effort: a failed snapshot must never block the switch itself.
      try {
        await ctx.quotaService.capturePreSwitchSnapshot({
          accountId: ctx.activeAccount?.id || '',
          tierName: ctx.lsTierName,
        });
      } catch {
        // Ignore snapshot capture failures
      }

      const job = prepareSwitchJob(paths, {
        mode: 'switch',
        accountId: targetAccountId,
        fallbackEmail: ctx.lsEmail,
        env: ctx.lsEnv,
        context: jobContext,
        delayMs,
        resume,
        waitConversationIdle,
        syncOnboarding: Boolean(settings.skipOnboardingPrompt),
        relaunchPauseMs: computeNaturalPauseMs({ enabled: settings.naturalPauseEnabled }),
      });

      await spawnWorker(job.jobPath, paths.dataDir, ctx.lsEnv);
      ctx.quotaService.invalidateCache?.();

      return toolResult({
        ok: true,
        switching: true,
        targetAccountId,
        targetMaskedEmail: job.targetMaskedEmail || maskEmail(ctx.accounts.find((a) => a.id === targetAccountId)?.maskedEmail || ''),
        ...(selectionSource ? { selectionSource } : {}),
        ...(selectionReason ? { selectionReason } : {}),
        delaySec: settings.switchDelaySec,
        autoResumeScheduled: Boolean(resume),
        message: waitConversationIdle
          ? `已调度切换到 ${job.targetMaskedEmail}，将在本轮回复完成后（最多 ${Math.round(waitConversationIdle.maxWaitMs / 1000)} 秒）自动关闭并重启 Antigravity。`
          : `已调度切换到 ${job.targetMaskedEmail}，将在 ${settings.switchDelaySec} 秒后关闭并重启 Antigravity。`,
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
