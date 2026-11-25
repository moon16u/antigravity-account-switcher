import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { basename } from 'node:path';
import { detectRuntime } from './platform.mjs';

const MAX_RPC_BODY_BYTES = 512 * 1024;
const MAX_ACTIVE_ITEMS = 12;
const ALLOWED_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const GEMINI_INFRA_PATH_RE =
  /[\\/]\.gemini[\\/](?:config[\\/](?:plugins|sidecars)|antigravity[\\/](?:builtin|plugin_data|sidecar_data|lib))(?:[\\/]|$)/i;

function truncateLabel(text, maxLen = 80) {
  const clean = String(text || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  if (!clean) return '';
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, Math.max(1, maxLen - 1))}…`;
}

export function isInfrastructureProcess(cmdline, { cwd = '' } = {}) {
  const cmd = String(cmdline || '');
  const procCwd = String(cwd || '');
  if (!cmd) return true;

  // Exclude Antigravity plugins, sidecars, and plugin daemons (built-in, ~/.gemini, or workspace plugins.json)
  if (
    GEMINI_INFRA_PATH_RE.test(cmd) ||
    (procCwd && GEMINI_INFRA_PATH_RE.test(procCwd)) ||
    /[\\/]sidecar_sdk[\\/]register_loader\.js/i.test(cmd) ||
    /[\\/]sidecars[\\/][^\\/\s]+[\\/]main\.mjs(?:\s|$)/i.test(cmd) ||
    /[\\/]scripts[\\/](?:mcp-server|quota-hook)\.mjs(?:\s|$)/i.test(cmd) ||
    /(?:^|\s|\/|\\)node(?:\.exe)?\s+(?:--[^\s]+\s+)*main\.mjs(?:\s|$)/i.test(cmd) ||
    /(?:^|\s)context-provider(?:\s|$)/i.test(cmd)
  ) {
    return true;
  }

  // Exclude permanent MCP server and CLI bridge child trees spawned by language_server
  if (
    cmd.includes('@modelcontextprotocol') ||
    cmd.includes('mcp-remote') ||
    cmd.includes('cua-driver') ||
    /(?:^|[\s/\\_-])mcp[-_]?server(?:[\s/\\_-]|$)/i.test(cmd) ||
    /(?:^|[\s/\\])(?:fastmcp|supergateway|mcp-proxy)(?:\s|$)/i.test(cmd) ||
    /(?:^|\s)--transport(?:=|\s+)stdio(?:\s|$)/i.test(cmd)
  ) {
    return true;
  }
  const hasRuntimeOrExe =
    /(?:^|\s|\/|\\)(?:npm|npx|node|bun|bunx|deno|uv|uvx|python3?|pipx)(?:\.exe)?(?:\s|$)|\.exe(?:\s|$)/i.test(cmd);
  if (
    hasRuntimeOrExe &&
    (/(?:^|\s)(?:mcp|stdio)(?:\s|$)/i.test(cmd) || /(?:^|[\s/@\\])[^\s]*-mcp(?:[\s@]|$)/i.test(cmd))
  ) {
    return true;
  }

  return false;
}

/**
 * Queries a local LanguageServerService unary JSON RPC over loopback HTTP/HTTPS.
 */
export async function callLsRpc(env = process.env, method = '', { timeoutMs = 1500, body = {} } = {}) {
  const addr = String(env?.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = String(env?.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!addr || !csrf || addr === 'test.invalid' || !/^[A-Za-z0-9_]+$/.test(method)) {
    return null;
  }

  let baseUrl;
  try {
    baseUrl = new URL(addr.startsWith('http://') || addr.startsWith('https://') ? addr : `http://${addr}`);
  } catch {
    return null;
  }
  if (!ALLOWED_LOOPBACK_HOSTS.has(baseUrl.hostname.toLowerCase())) {
    return null;
  }

  const transport = baseUrl.protocol === 'https:' ? https : http;
  const payload = JSON.stringify(body && typeof body === 'object' ? body : {});

  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolvePromise(val);
    };

    const req = transport.request(
      {
        hostname: baseUrl.hostname.replace(/^\[|\]$/g, ''),
        port: baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80),
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf,
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX_RPC_BODY_BYTES) {
            req.destroy();
            finish(null);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            finish(null);
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(parsed && typeof parsed === 'object' ? parsed : null);
          } catch {
            finish(null);
          }
        });
        res.on('error', () => finish(null));
      }
    );

    req.on('timeout', () => {
      req.destroy();
      finish(null);
    });
    req.on('error', () => finish(null));
    req.end(payload);
  });
}

/**
 * Filters /proc entries down to active user/agent child processes under WSL language_server.
 */
export function findUserChildProcesses(procEntries = [], { lsPids = [], ownPid = process.pid } = {}) {
  const lsSet = lsPids instanceof Set ? lsPids : new Set(lsPids);
  if (lsSet.size === 0) return [];

  const items = [];
  for (const entry of procEntries) {
    if (!entry || !lsSet.has(entry.ppid) || entry.pid === ownPid) continue;
    const cmdline = Array.isArray(entry.argv) ? entry.argv.join(' ') : String(entry.cmdline || '');
    if (isInfrastructureProcess(cmdline, { cwd: entry.cwd || '' })) continue;

    const argv0 = Array.isArray(entry.argv)
      ? entry.argv[0] || ''
      : String(entry.cmdline || '').trim().split(/\s+/)[0] || '';
    // Keep only executable basename + PID so CLI arguments cannot leak credentials.
    const shortName = truncateLabel(argv0 ? basename(argv0) : 'process', 48) || 'process';
    items.push({
      kind: 'process',
      pid: entry.pid,
      label: truncateLabel(`${shortName} (PID ${entry.pid})`, 80),
    });
  }
  return items;
}

export function scanWslProcForUserChildren(ownPid = process.pid) {
  const myUid = typeof process.getuid === 'function' ? process.getuid() : -1;
  let dirEntries;
  try {
    dirEntries = readdirSync('/proc');
  } catch {
    return [];
  }

  const procEntries = [];
  const lsPids = new Set();

  for (const name of dirEntries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;

    try {
      if (myUid >= 0 && statSync(`/proc/${pid}`).uid !== myUid) continue;
      const statRaw = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rparen = statRaw.lastIndexOf(')');
      if (rparen < 0) continue;
      const rest = statRaw.slice(rparen + 1).trim().split(/\s+/);
      const ppid = Number(rest[1]);
      if (!Number.isSafeInteger(ppid)) continue;

      const rawCmd = readFileSync(`/proc/${pid}/cmdline`);
      const argv = rawCmd.toString('utf8').split('\0').filter(Boolean);
      const cmdline = argv.join(' ');
      if (!cmdline) continue;

      const argv0 = argv[0] || '';
      if (argv0.includes('/.antigravity-server/bin/') && argv0.endsWith('/language_server')) {
        lsPids.add(pid);
      }
      let cwd = '';
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        // Ignore unreadable or vanished cwd symlink
      }
      procEntries.push({ pid, ppid, argv, cmdline, cwd });
    } catch {
      // Ignore transient processes that exited mid-scan
    }
  }

  return findUserChildProcesses(procEntries, { lsPids, ownPid });
}

export function parsePsOutput(text, ownPid = process.pid) {
  const lines = String(text || '').split(/\r?\n/);
  const procEntries = [];
  const lsPids = new Set();

  for (const rawLine of lines) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(rawLine);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const cmdline = m[3];
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;

    if (
      /\bResources\/bin\/language_server\b/.test(cmdline) ||
      /\/\.antigravity-server\/bin\/.*\/language_server(?:\s|$)/.test(cmdline) ||
      /(?:^|\/)language_server(?:\s|$)/.test(cmdline)
    ) {
      lsPids.add(pid);
    }
    procEntries.push({ pid, ppid, cmdline });
  }

  return findUserChildProcesses(procEntries, { lsPids, ownPid });
}

export function scanDarwinPsForUserChildren(ownPid = process.pid) {
  try {
    const out = execFileSync('/bin/ps', ['-eo', 'pid=,ppid=,args='], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return parsePsOutput(out, ownPid);
  } catch {
    return [];
  }
}

/**
 * Extracts active cascades, background tasks, and terminals from LS RPC payloads.
 */
export function extractActiveItemsFromLs({
  trajectories,
  backgroundTasks,
  terminals,
  excludeConversationIds = [],
} = {}) {
  const items = [];
  const excludeSet = new Set(
    (Array.isArray(excludeConversationIds) ? excludeConversationIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  );

  const summaries = trajectories?.trajectorySummaries;
  if (summaries && typeof summaries === 'object') {
    for (const [cid, entry] of Object.entries(summaries)) {
      if (!entry || typeof entry !== 'object') continue;
      if (excludeSet.has(cid)) continue;
      if (entry.status === 'CASCADE_RUN_STATUS_RUNNING' || entry.status === 'CASCADE_RUN_STATUS_BUSY') {
        items.push({
          kind: 'cascade',
          conversationId: cid,
          label: truncateLabel(entry.summary || '进行中的对话', 80),
        });
      }
    }
  }

  const taskList = backgroundTasks?.tasks || backgroundTasks?.backgroundTasks || backgroundTasks?.background_tasks;
  if (Array.isArray(taskList)) {
    for (const task of taskList) {
      if (!task || typeof task !== 'object') continue;
      const st = typeof task.status === 'string' ? task.status.toUpperCase() : '';
      if (
        st.includes('COMPLETED') ||
        st.includes('DONE') ||
        st.includes('FAILED') ||
        st.includes('CANCEL') ||
        st.includes('STOPPED')
      ) {
        continue;
      }
      items.push({
        kind: 'task',
        label: truncateLabel(task.summary || task.description || task.title || task.name || '后台任务', 80),
      });
    }
  }

  const termList = terminals?.terminals;
  if (Array.isArray(termList)) {
    for (const term of termList) {
      if (!term || typeof term !== 'object') continue;
      const st = typeof term.status === 'string' ? term.status.toUpperCase() : '';
      if (term.exited === true || term.closed === true || term.isAlive === false || st.includes('CLOSED') || st.includes('EXITED')) {
        continue;
      }
      items.push({
        kind: 'terminal',
        label: truncateLabel(term.name || term.title || '活跃终端', 80),
      });
    }
  }

  return items;
}

/**
 * Checks LS RPCs and platform child processes for active work before restarting Antigravity.
 */
export async function detectActiveWork(
  env = process.env,
  { ownPid = process.pid, rpcFn = callLsRpc, procScanFn, excludeConversationIds = [] } = {}
) {
  let scanner = procScanFn;
  if (!scanner) {
    const runtime = detectRuntime(env);
    if (runtime === 'darwin') scanner = scanDarwinPsForUserChildren;
    else if (runtime === 'wsl' || runtime === 'linux') scanner = scanWslProcForUserChildren;
    else scanner = () => [];
  }

  const [trajectories, backgroundTasks, terminals] = await Promise.all([
    Promise.resolve(rpcFn(env, 'GetAllCascadeTrajectories')).catch(() => null),
    Promise.resolve(rpcFn(env, 'ListBackgroundTasks')).catch(() => null),
    Promise.resolve(rpcFn(env, 'ListTerminals')).catch(() => null),
  ]);

  let procItems = [];
  try {
    const scanned = scanner(ownPid);
    if (Array.isArray(scanned)) procItems = scanned;
  } catch {
    procItems = [];
  }

  const items = [
    ...extractActiveItemsFromLs({ trajectories, backgroundTasks, terminals, excludeConversationIds }),
    ...procItems,
  ];
  return {
    busy: items.length > 0,
    count: items.length,
    items: items.slice(0, MAX_ACTIVE_ITEMS),
    truncated: items.length > MAX_ACTIVE_ITEMS,
  };
}
