import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// This hook must stay dependency-free (Node builtins only): it runs on every
// invocation and must start in well under 15ms with no resident memory.
const MAX_JSON_BYTES = 64 * 1024;
const SNAPSHOT_STALE_MS = 15 * 60 * 1000;
const DEFAULT_TRIGGER_MIN_INTERVAL_MS = 60_000;
const MAX_STATE_CONVERSATIONS = 50;
const EMPTY_RESPONSE = Object.freeze({ injectSteps: [] });
const POST_INVOCATION_RESPONSE = Object.freeze({});

function isRegularNonSymlinkFile(filePath) {
  try {
    const st = lstatSync(filePath);
    return !st.isSymbolicLink() && st.isFile() && st.size <= MAX_JSON_BYTES;
  } catch {
    return false;
  }
}

function readSafeJson(filePath) {
  if (!isRegularNonSymlinkFile(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function assertInsideDir(baseDir, targetPath) {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(targetPath);
  const prefix = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
  if (!resolvedTarget.startsWith(prefix)) {
    throw new Error('PATH_OUTSIDE_BOUNDARY');
  }
  return resolvedTarget;
}

function atomicWriteJson(targetPath, obj) {
  const st = (() => {
    try {
      return lstatSync(targetPath);
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  })();
  if (st && (st.isSymbolicLink() || !st.isFile())) {
    return false;
  }

  const parent = dirname(targetPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentSt = lstatSync(parent);
  if (parentSt.isSymbolicLink() || !parentSt.isDirectory()) {
    return false;
  }

  const rand = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpPath = assertInsideDir(parent, join(parent, `.tmp-${rand}`));
  try {
    writeFileSync(tmpPath, JSON.stringify(obj, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(tmpPath, targetPath);
    return true;
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore temp cleanup failure
    }
    return false;
  }
}

export function resolveHookDataDir(env = process.env) {
  if (env?.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return resolve(env.ANTIGRAVITY_EXECUTABLE_DATA_DIR);
  }
  const geminiDir = resolve(env?.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini'));
  const appDataDir = resolve(env?.ANTIGRAVITY_APP_DATA_DIR || join(geminiDir, 'antigravity'));
  const sidecarDataDir = join(appDataDir, 'sidecar_data', 'antigravity-account-switcher', 'switcher', 'data');
  try {
    const st = lstatSync(sidecarDataDir);
    if (!st.isSymbolicLink() && st.isDirectory()) {
      return resolve(sidecarDataDir);
    }
  } catch {
    // Sidecar data dir absent; fall back below
  }
  return resolve(env?.PLUGIN_DATA || join(appDataDir, 'plugin_data', 'antigravity-account-switcher'));
}

function readHookSettings(settingsPath) {
  const raw = readSafeJson(settingsPath) || {};
  const autoSwitchEnabled = Boolean(raw.autoSwitchEnabled);
  const autoResumeEnabled = autoSwitchEnabled && Boolean(raw.autoResumeEnabled);
  const rawThreshold = Number(raw.thresholdPercent);
  return {
    alertEnabled: raw.alertEnabled === undefined ? true : Boolean(raw.alertEnabled),
    autoSwitchEnabled,
    autoResumeEnabled,
    thresholdPercent: Number.isFinite(rawThreshold)
      ? Math.min(50, Math.max(1, Math.round(rawThreshold)))
      : 10,
  };
}

function normalizeAlertLevel(snapshot) {
  const raw = typeof snapshot?.level === 'string' ? snapshot.level.trim().toLowerCase() : '';
  if (raw === 'soft' || raw === 'hard' || raw === 'ok') return raw;
  // Backwards compatibility: a triggered legacy snapshot without a level is a
  // hard alert, not a soft one.
  return snapshot?.triggered ? 'hard' : 'ok';
}

function firstFiniteNumber(values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function formatRemainingParts(snapshot) {
  const parts = [];
  const buckets = Array.isArray(snapshot.triggeredBuckets) ? snapshot.triggeredBuckets : [];
  if (buckets.includes('gemini-weekly') && typeof snapshot.weeklyPercent === 'number') {
    parts.push(`周额度剩余 ${snapshot.weeklyPercent}%`);
  }
  if (buckets.includes('gemini-5h') && typeof snapshot.fiveHourPercent === 'number') {
    parts.push(`5小时额度剩余 ${snapshot.fiveHourPercent}%`);
  }
  if (parts.length === 0) {
    if (typeof snapshot.weeklyPercent === 'number') {
      parts.push(`周额度剩余 ${snapshot.weeklyPercent}%`);
    }
    if (typeof snapshot.fiveHourPercent === 'number') {
      parts.push(`5小时额度剩余 ${snapshot.fiveHourPercent}%`);
    }
  }
  if (parts.length === 0) {
    parts.push('Gemini 额度已降至预警阈值以下');
  }
  return parts;
}

function formatCandidateText(candidate, level) {
  if (!candidate || typeof candidate !== 'object' || !candidate.id) return '';
  const candName = candidate.label
    ? `${candidate.label} / ${candidate.maskedEmail || ''}`.trim()
    : candidate.maskedEmail || candidate.id;
  const quotaParts = [];
  if (typeof candidate.weeklyPercent === 'number') quotaParts.push(`周 ${candidate.weeklyPercent}%`);
  if (typeof candidate.fiveHourPercent === 'number') quotaParts.push(`5h ${candidate.fiveHourPercent}%`);

  const noteParts = [];
  if (candidate.estimatedReset || candidate.estimatedAnyReset) {
    noteParts.push('额度可能已按重置时间回升，基于本地快照估算');
  } else if (candidate.source === 'snapshot' || candidate.capturedAt) {
    noteParts.push('基于本地快照');
  }
  const note = noteParts.length ? `（${noteParts.join('；')}）` : '';
  const prefix = level === 'soft' ? '；备用候选' : '；可用满血备用号';
  return `${prefix}: ${candName}${quotaParts.length ? ` (${quotaParts.join(', ')})` : ''} [id=${candidate.id}]${note}`;
}

function formatAlertMessage(snapshot, settings, conversationId, level) {
  const remaining = formatRemainingParts(snapshot);
  const acctText = snapshot.activeMaskedEmail ? `（当前账号: ${snapshot.activeMaskedEmail}）` : '';
  const candidateText = formatCandidateText(snapshot.bestCandidate, level);
  const cidPart = conversationId ? `；当前会话 conversationId="${conversationId}"` : '';

  if (level === 'soft') {
    const softThreshold =
      firstFiniteNumber([
        snapshot.softThresholdPercent,
        snapshot.softThreshold,
        snapshot.sessionThresholds?.softThreshold,
        snapshot.thresholdPercent,
        settings.thresholdPercent,
      ]) ?? settings.thresholdPercent;
    return `[Account Switcher 软性收尾预警] ${remaining.join('、')}${acctText}；软性收尾阈值 ${softThreshold}%${candidateText}${cidPart}。当前账号额度已进入收尾预警区，请优先完成当前最小可验证子步骤并保持工作区干净，避免开启新的大型重构或长链路操作，准备在合适断点切换账号。`;
  }

  const hardFloor =
    firstFiniteNumber([
      snapshot.hardFloorPercent,
      snapshot.hardFloor,
      snapshot.sessionThresholds?.hardFloor,
      snapshot.thresholdPercent,
      settings.thresholdPercent,
    ]) ?? settings.thresholdPercent;
  const actionText = settings.autoSwitchEnabled
    ? `已开启「Agent 自主切号」${settings.autoResumeEnabled ? '与「切号后自动续跑」' : ''}：请先安全完成当前原子写入/步骤，然后调用 MCP 工具 antigravity-account-switcher_switcher/switch_account（传入 pickBest: true${conversationId ? `, conversationId: "${conversationId}"` : ''}）切换备用号（若返回有其他活跃对话或终端在运行，切勿擅自传 force: true，请先询问用户确认）。`
    : `当前未开启「Agent 自主切号」（已禁止 Agent 通过 MCP 切号）：请在回复中告知用户上述低额度状态${snapshot.bestCandidate ? '及推荐备用号' : ''}，提醒用户自行在右侧 Account Switcher 面板手动切换账号，或按需在「高级设置」中开启「Agent 自主切号」。`;

  return `[Account Switcher 低额度预警] ${remaining.join('、')}${acctText}；硬性阈值 ${hardFloor}%${candidateText}${cidPart}。${actionText}`;
}

function handlePostInvocation(input, env, { nowMs, triggerMinIntervalMs }) {
  const dataDir = resolveHookDataDir(env);
  const settingsPath = assertInsideDir(dataDir, join(dataDir, 'settings.json'));
  const settings = readHookSettings(settingsPath);
  if (!settings.alertEnabled) {
    return POST_INVOCATION_RESPONSE;
  }

  const triggerPath = assertInsideDir(dataDir, join(dataDir, 'quota-refresh-trigger.json'));
  const trigger = readSafeJson(triggerPath);
  const requestedMs = trigger ? Date.parse(String(trigger.requestedAt || '')) : NaN;
  const minIntervalMs =
    typeof triggerMinIntervalMs === 'number' && Number.isFinite(triggerMinIntervalMs) && triggerMinIntervalMs >= 0
      ? triggerMinIntervalMs
      : DEFAULT_TRIGGER_MIN_INTERVAL_MS;

  if (Number.isFinite(requestedMs) && nowMs - requestedMs < minIntervalMs) {
    return POST_INVOCATION_RESPONSE;
  }

  const cid = typeof input?.conversationId === 'string' ? input.conversationId.trim() : '';
  atomicWriteJson(triggerPath, {
    v: 1,
    event: 'PostInvocation',
    conversationId: cid,
    requestedAt: new Date(nowMs).toISOString(),
  });
  // PostInvocation never injects steps and never performs network/LS RPC calls.
  return POST_INVOCATION_RESPONSE;
}

function handlePreInvocation(input, env, { nowMs }) {
  const dataDir = resolveHookDataDir(env);
  const settingsPath = assertInsideDir(dataDir, join(dataDir, 'settings.json'));
  const snapshotPath = assertInsideDir(dataDir, join(dataDir, 'quota-alert.json'));
  const hookStatePath = assertInsideDir(dataDir, join(dataDir, 'hook-alert-state.json'));

  const settings = readHookSettings(settingsPath);
  if (!settings.alertEnabled) {
    return EMPTY_RESPONSE;
  }

  const snapshot = readSafeJson(snapshotPath);
  if (!snapshot || snapshot.v !== 1) {
    return EMPTY_RESPONSE;
  }
  const updatedMs = Date.parse(String(snapshot.updatedAt || ''));
  if (!Number.isFinite(updatedMs) || nowMs - updatedMs > SNAPSHOT_STALE_MS) {
    return EMPTY_RESPONSE;
  }

  const cid = typeof input?.conversationId === 'string' ? input.conversationId.trim() : '';
  const state = readSafeJson(hookStatePath);
  const conversations =
    state?.v === 1 && state.conversations && typeof state.conversations === 'object' && !Array.isArray(state.conversations)
      ? { ...state.conversations }
      : {};

  const level = normalizeAlertLevel(snapshot);
  if (!snapshot.triggered || level === 'ok') {
    if (cid && Object.prototype.hasOwnProperty.call(conversations, cid)) {
      delete conversations[cid];
      atomicWriteJson(hookStatePath, { v: 1, conversations });
    }
    return EMPTY_RESPONSE;
  }

  const triggeredIds = Array.isArray(snapshot.triggeredBuckets)
    ? [...snapshot.triggeredBuckets].filter((b) => typeof b === 'string').sort().join(',')
    : '';
  const acctKey = String(snapshot.activeAccountId || snapshot.activeMaskedEmail || 'active');
  // Level is part of the signature so a conversation alerted at 'soft' alerts
  // again when it later drops to 'hard', while same-level duplicates stay quiet.
  const sig = `${acctKey}|${level}|${triggeredIds}|${settings.autoSwitchEnabled ? 1 : 0}|${settings.autoResumeEnabled ? 1 : 0}`;

  if (cid && conversations[cid]?.sig === sig) {
    return EMPTY_RESPONSE;
  }

  if (cid) {
    conversations[cid] = { sig, alertedAt: new Date(nowMs).toISOString() };
    const entries = Object.entries(conversations);
    if (entries.length > MAX_STATE_CONVERSATIONS) {
      entries.sort((a, b) => Date.parse(String(b[1]?.alertedAt || '')) - Date.parse(String(a[1]?.alertedAt || '')));
      const trimmed = Object.fromEntries(entries.slice(0, MAX_STATE_CONVERSATIONS));
      atomicWriteJson(hookStatePath, { v: 1, conversations: trimmed });
    } else {
      atomicWriteJson(hookStatePath, { v: 1, conversations });
    }
  }

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: formatAlertMessage(snapshot, settings, cid, level),
          metadata: { source: 'antigravity-account-switcher/quota-guard', level },
        },
      },
    ],
  };
}

export function evaluateHookInput(
  input = {},
  env = process.env,
  { nowMs = Date.now(), triggerMinIntervalMs = DEFAULT_TRIGGER_MIN_INTERVAL_MS } = {}
) {
  const currentMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const eventName = typeof input?.hookEventName === 'string' ? input.hookEventName.trim() : '';
  try {
    if (eventName === 'PostInvocation') {
      return handlePostInvocation(input, env, { nowMs: currentMs, triggerMinIntervalMs });
    }
    return handlePreInvocation(input, env, { nowMs: currentMs });
  } catch {
    return eventName === 'PostInvocation' ? POST_INVOCATION_RESPONSE : EMPTY_RESPONSE;
  }
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

async function readStdinUtf8() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

if (isEntryScript()) {
  readStdinUtf8()
    .then((raw) => {
      const input = raw && raw.trim() ? JSON.parse(raw) : {};
      const out = evaluateHookInput(input, process.env);
      process.stdout.write(JSON.stringify(out) + '\n');
    })
    .catch(() => {
      process.stdout.write(JSON.stringify(EMPTY_RESPONSE) + '\n');
    });
}
