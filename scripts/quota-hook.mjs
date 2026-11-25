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

const MAX_JSON_BYTES = 64 * 1024;
const SNAPSHOT_STALE_MS = 15 * 60 * 1000;
const MAX_STATE_CONVERSATIONS = 50;
const EMPTY_RESPONSE = Object.freeze({ injectSteps: [] });

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

function formatAlertMessage(snapshot, settings, conversationId) {
  const parts = [];
  const buckets = Array.isArray(snapshot.triggeredBuckets) ? snapshot.triggeredBuckets : [];
  if (buckets.includes('gemini-weekly') && typeof snapshot.weeklyPercent === 'number') {
    parts.push(`周额度剩余 ${snapshot.weeklyPercent}%`);
  }
  if (buckets.includes('gemini-5h') && typeof snapshot.fiveHourPercent === 'number') {
    parts.push(`5小时额度剩余 ${snapshot.fiveHourPercent}%`);
  }
  if (parts.length === 0) {
    parts.push(`Gemini 额度已降至阈值 (${snapshot.thresholdPercent ?? 10}%) 以下`);
  }

  const acctText = snapshot.activeMaskedEmail ? `（当前账号: ${snapshot.activeMaskedEmail}）` : '';
  const cand = snapshot.bestCandidate;
  let backupText = '';
  if (cand && cand.id) {
    const candName = cand.label ? `${cand.label} / ${cand.maskedEmail}` : cand.maskedEmail;
    const qParts = [];
    if (typeof cand.weeklyPercent === 'number') qParts.push(`周 ${cand.weeklyPercent}%`);
    if (typeof cand.fiveHourPercent === 'number') qParts.push(`5h ${cand.fiveHourPercent}%`);
    backupText = `；可用满血备用号: ${candName}${qParts.length ? ` (${qParts.join(', ')})` : ''} [id=${cand.id}]`;
  }

  const cidPart = conversationId ? `；当前会话 conversationId="${conversationId}"` : '';
  const actionText = settings.autoSwitchEnabled
    ? `已开启「低额度自动切号」${settings.autoResumeEnabled ? '与「重启自动唤醒续跑」' : ''}：请先安全收尾当前正在写的步骤，然后调用 MCP 工具 antigravity-account-switcher_switcher/switch_account（传入 pickBest: true${conversationId ? `, conversationId: "${conversationId}"` : ''}）切换备用号（若返回有其他活跃对话或终端在运行，切勿擅自传 force: true，请先询问用户）。`
    : `当前为提醒模式：请在回复中告知用户上述低额度状态${cand ? '及推荐备用号' : ''}，并询问是否现在调用 switch_account 切号重启${conversationId ? `（切号时传入 conversationId: "${conversationId}" 以排除当前会话）` : ''}。`;

  return `[Account Switcher 低额度预警] ${parts.join('、')}${acctText}${backupText}${cidPart}。${actionText}`;
}

export function evaluateHookInput(input = {}, env = process.env, { nowMs = Date.now() } = {}) {
  try {
    const dataDir = resolveHookDataDir(env);
    const settingsPath = assertInsideDir(dataDir, join(dataDir, 'settings.json'));
    const snapshotPath = assertInsideDir(dataDir, join(dataDir, 'quota-alert.json'));
    const hookStatePath = assertInsideDir(dataDir, join(dataDir, 'hook-alert-state.json'));

    const rawSettings = readSafeJson(settingsPath) || {};
    const settings = {
      alertEnabled: rawSettings.alertEnabled === undefined ? true : Boolean(rawSettings.alertEnabled),
      autoSwitchEnabled: Boolean(rawSettings.autoSwitchEnabled),
      autoResumeEnabled: Boolean(rawSettings.autoResumeEnabled),
    };
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

    if (!snapshot.triggered) {
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
    const sig = `${acctKey}|${triggeredIds}|${settings.autoSwitchEnabled ? 1 : 0}|${settings.autoResumeEnabled ? 1 : 0}`;

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
            systemMessage: formatAlertMessage(snapshot, settings, cid),
            metadata: { source: 'antigravity-account-switcher/quota-guard' },
          },
        },
      ],
    };
  } catch {
    return EMPTY_RESPONSE;
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
