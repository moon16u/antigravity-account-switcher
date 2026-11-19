import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  detectRuntime,
  readRunInBackgroundSetting,
  relaunchAntigravity,
  resolveWindowsDirs,
} from './platform.mjs';
import { removeActiveTokenRaw, writeActiveTokenRaw } from './token-store.mjs';
import {
  appendSwitchLog,
  assertInsideDir,
  assertNotSymlink,
  decryptPayload,
  getOrCreateKey,
  maskEmail,
  parseAndValidateTokenRaw,
  resolvePaths,
} from './vault.mjs';

export { readRunInBackgroundSetting };

const JOB_NAME_RE = /^job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.enc\.json$/i;

function splitCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

export function parseWindowsTasklistCsv(rawBuf, { excludePids = [] } = {}) {
  const buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(String(rawBuf || ''), 'latin1');
  const lines = buf.toString('latin1').split(/\r?\n/).filter(Boolean);
  const excludeSet = new Set(
    (Array.isArray(excludePids) ? excludePids : [])
      .map((n) => Number(n))
      .filter((n) => Number.isSafeInteger(n) && n > 0)
  );
  let totalCount = 0;
  const pids = [];
  const visibleWindowPids = [];

  for (const line of lines) {
    const fields = splitCsvLine(line);
    if (fields.length < 9 || fields[0].toLowerCase() !== 'antigravity.exe') {
      continue;
    }
    const pid = Number(fields[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || excludeSet.has(pid)) {
      continue;
    }
    totalCount += 1;
    pids.push(pid);

    const titleLatin1 = fields[fields.length - 1];
    const titleTrimmed = titleLatin1.trim();
    const titleBuf = Buffer.from(titleLatin1, 'latin1');
    const isGbkPlaceholder =
      titleBuf.length === 4 &&
      titleBuf[0] === 0xd4 &&
      titleBuf[1] === 0xdd &&
      titleBuf[2] === 0xc8 &&
      titleBuf[3] === 0xb1;
    const isUtf8Placeholder = titleBuf.toString('utf8').trim() === '暂缺';
    const isHeadless =
      !titleTrimmed ||
      titleTrimmed === 'N/A' ||
      titleTrimmed === 'OleMainThreadWndName' ||
      isGbkPlaceholder ||
      isUtf8Placeholder;

    if (!isHeadless) {
      visibleWindowPids.push(pid);
    }
  }

  return { totalCount, pids, visibleWindowPids };
}

export function buildWindowsForceKillArgBatches(pids, { selfPid = process.pid, chunkSize = 25 } = {}) {
  const unique = [];
  const seen = new Set();
  const size = Number.isSafeInteger(chunkSize) && chunkSize > 0 ? chunkSize : 25;
  for (const rawPid of Array.isArray(pids) ? pids : []) {
    const pid = Number(rawPid);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === selfPid || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    unique.push(pid);
  }
  const batches = [];
  for (let i = 0; i < unique.length; i += size) {
    const args = ['/F'];
    for (const pid of unique.slice(i, i + size)) {
      args.push('/PID', String(pid));
    }
    batches.push(args);
  }
  return batches;
}

function forceKillWindowsPids(taskkillExe, pids) {
  const batches = buildWindowsForceKillArgBatches(pids);
  for (const args of batches) {
    try {
      execFileSync(taskkillExe, args, {
        stdio: 'ignore',
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
      // Ignore if process already exited
    }
  }
}

function inspectWindowsAntigravity(tasklistExe, excludePids = []) {
  if (!tasklistExe || !existsSync(tasklistExe)) {
    return { totalCount: 0, pids: [], visibleWindowPids: [] };
  }
  try {
    const rawBuf = execFileSync(tasklistExe, ['/FI', 'IMAGENAME eq Antigravity.exe', '/V', '/FO', 'CSV', '/NH'], {
      timeout: 5000,
      windowsHide: true,
    });
    return parseWindowsTasklistCsv(rawBuf, { excludePids });
  } catch {
    return { totalCount: 0, pids: [], visibleWindowPids: [] };
  }
}

function findWindowsLanguageServerCount(tasklistExe) {
  if (!tasklistExe || !existsSync(tasklistExe)) return 0;
  try {
    const rawBuf = execFileSync(tasklistExe, ['/FI', 'IMAGENAME eq language_server.exe', '/NH'], {
      timeout: 5000,
      windowsHide: true,
    });
    const text = rawBuf.toString('latin1');
    return text.split(/\r?\n/).filter((line) => /language_server\.exe/i.test(line)).length;
  } catch {
    return 0;
  }
}

function scanLinuxProc(matcher) {
  const myUid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const results = [];
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return results;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue;
    try {
      if (myUid >= 0 && statSync(`/proc/${pid}`).uid !== myUid) continue;
      const rawCmd = readFileSync(`/proc/${pid}/cmdline`);
      const argv0 = rawCmd.toString('utf8').split('\0')[0] || '';
      if (argv0 && matcher(argv0, pid)) {
        results.push({ pid, argv0 });
      }
    } catch {
      // Process may have already exited
    }
  }
  return results;
}

function findLinuxLanguageServerPids() {
  return scanLinuxProc(
    (argv0) =>
      (argv0.includes('/.antigravity-server/bin/') || argv0.includes('/resources/bin/')) &&
      basename(argv0) === 'language_server'
  ).map((r) => r.pid);
}

function findLinuxAntigravityDesktopInfo() {
  const hits = scanLinuxProc((argv0) => {
    const base = basename(argv0).toLowerCase();
    return base === 'antigravity' || base === 'antigravity.bin';
  });
  let capturedLinuxExe = '';
  for (const hit of hits) {
    try {
      const target = readlinkSync(`/proc/${hit.pid}/exe`);
      if (target && existsSync(target)) {
        capturedLinuxExe = target;
        break;
      }
    } catch {
      // Ignore vanished proc exe link
    }
  }
  return { pids: hits.map((r) => r.pid), capturedLinuxExe };
}

function findDarwinAntigravityPids() {
  const guiPids = [];
  const lsPids = [];
  try {
    const out = execFileSync('/bin/ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 2000 });
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const cmd = m[2];
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue;
      if (/\bResources\/bin\/language_server\b/.test(cmd) || /(?:^|\/)language_server(?:\s|$)/.test(cmd)) {
        lsPids.push(pid);
      } else if (cmd.includes('/Antigravity.app/Contents/MacOS/')) {
        guiPids.push(pid);
      }
    }
  } catch {
    // Ignore ps failure
  }
  return { guiPids, lsPids };
}

function sendSigtermToPids(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ESRCH if already exited
    }
  }
}

async function pollUntil(checkFn, maxMs, intervalMs) {
  const deadline = Date.now() + maxMs;
  let value = checkFn();
  while (Date.now() < deadline && !value.done) {
    await delay(intervalMs);
    value = checkFn();
  }
  return value.state;
}

export function resolveWindowsTaskExecutables(env = process.env, runtime = detectRuntime(env)) {
  const dirs = resolveWindowsDirs(env, runtime);
  const sys32 = dirs.system32 || (runtime === 'win32' ? 'C:\\Windows\\System32' : '/mnt/c/Windows/System32');
  const tasklistExe = runtime === 'win32' ? join(sys32, 'tasklist.exe') : `${sys32}/tasklist.exe`;
  const taskkillExe = runtime === 'win32' ? join(sys32, 'taskkill.exe') : `${sys32}/taskkill.exe`;
  return { sys32, tasklistExe, taskkillExe };
}

export async function stopWindowsOrWslAntigravity(paths, env, runtime) {
  const { tasklistExe, taskkillExe } = resolveWindowsTaskExecutables(env, runtime);
  const excludePids = runtime === 'win32' ? [process.pid] : [];

  const runInBackground = readRunInBackgroundSetting(env, runtime);
  let winState = inspectWindowsAntigravity(tasklistExe, excludePids);
  let lsSigtermSent = false;

  const countLsRemaining = () =>
    runtime === 'win32' ? findWindowsLanguageServerCount(tasklistExe) : findLinuxLanguageServerPids().length;

  if (winState.totalCount > 0 && existsSync(taskkillExe)) {
    if (winState.visibleWindowPids.length > 0) {
      for (const pid of winState.visibleWindowPids) {
        try {
          execFileSync(taskkillExe, ['/PID', String(pid)], { stdio: 'ignore', timeout: 5000, windowsHide: true });
        } catch {
          // Ignore if already closed
        }
      }

      if (runInBackground) {
        winState = await pollUntil(
          () => {
            const st = inspectWindowsAntigravity(tasklistExe, excludePids);
            return { done: st.visibleWindowPids.length === 0 || st.totalCount === 0, state: st };
          },
          2000,
          150
        );
        appendSwitchLog(paths, `WIN_CLOSED_TRAY_MODE remaining=${winState.totalCount}`);
      } else {
        winState = await pollUntil(
          () => {
            const st = inspectWindowsAntigravity(tasklistExe, excludePids);
            return { done: st.totalCount === 0, state: st };
          },
          5000,
          150
        );
        if (winState.totalCount === 0) {
          appendSwitchLog(paths, 'WIN_GRACEFUL_QUIT_OK');
        }
      }
    }

    if (winState.totalCount > 0) {
      if (runtime === 'wsl') {
        const earlyLs = findLinuxLanguageServerPids();
        if (earlyLs.length > 0) {
          sendSigtermToPids(earlyLs);
          lsSigtermSent = true;
          appendSwitchLog(paths, `LS_SIGTERM count=${earlyLs.length}`);
        }
      }

      appendSwitchLog(paths, runInBackground ? 'TASKKILL_TRAY_QUIT' : 'TASKKILL_FORCE');
      if (runtime === 'win32') {
        forceKillWindowsPids(taskkillExe, winState.pids);
        let stragglerKillPasses = 0;
        await pollUntil(
          () => {
            const st = inspectWindowsAntigravity(tasklistExe, excludePids);
            if (st.totalCount > 0 && st.pids.length > 0 && stragglerKillPasses < 2) {
              stragglerKillPasses += 1;
              forceKillWindowsPids(taskkillExe, st.pids);
            }
            return { done: st.totalCount === 0, state: st };
          },
          2000,
          150
        );
      } else {
        try {
          execFileSync(taskkillExe, ['/IM', 'Antigravity.exe', '/T', '/F'], {
            stdio: 'ignore',
            timeout: 5000,
            windowsHide: true,
          });
        } catch {
          // Ignore if already exited
        }
        await pollUntil(
          () => {
            const st = inspectWindowsAntigravity(tasklistExe, excludePids);
            return { done: st.totalCount === 0, state: st };
          },
          2000,
          150
        );
      }
    }
  }

  let lsRemaining = await pollUntil(
    () => {
      const cnt = countLsRemaining();
      return { done: cnt === 0, state: cnt };
    },
    350,
    100
  );

  if (lsRemaining > 0 && runtime === 'wsl') {
    const pids = findLinuxLanguageServerPids();
    if (!lsSigtermSent && pids.length > 0) {
      appendSwitchLog(paths, `LS_SIGTERM count=${pids.length}`);
    }
    sendSigtermToPids(pids);
    lsRemaining = await pollUntil(
      () => {
        const cnt = findLinuxLanguageServerPids().length;
        return { done: cnt === 0, state: cnt };
      },
      4000,
      100
    );
  } else if (lsRemaining > 0 && runtime === 'win32') {
    lsRemaining = await pollUntil(
      () => {
        const cnt = findWindowsLanguageServerCount(tasklistExe);
        return { done: cnt === 0, state: cnt };
      },
      4000,
      150
    );
    if (lsRemaining > 0 && existsSync(taskkillExe)) {
      appendSwitchLog(paths, 'WIN_LS_FORCE_CLEAN');
      try {
        execFileSync(taskkillExe, ['/IM', 'language_server.exe', '/F'], {
          stdio: 'ignore',
          timeout: 5000,
          windowsHide: true,
        });
      } catch {
        // Ignore
      }
      lsRemaining = await pollUntil(
        () => {
          const cnt = findWindowsLanguageServerCount(tasklistExe);
          return { done: cnt === 0, state: cnt };
        },
        2000,
        150
      );
    }
  }

  appendSwitchLog(paths, `LS_WAIT_DONE remaining=${lsRemaining}`);
  if (lsRemaining > 0) {
    throw new Error('LS_STILL_RUNNING');
  }
  return {};
}

async function stopDarwinAntigravity(paths) {
  if (existsSync('/usr/bin/osascript')) {
    try {
      execFileSync('/usr/bin/osascript', ['-e', 'tell application "Antigravity" to quit'], {
        stdio: 'ignore',
        timeout: 3000,
      });
    } catch {
      // Ignore if app already closed
    }
  }

  let state = await pollUntil(
    () => {
      const cur = findDarwinAntigravityPids();
      return { done: cur.guiPids.length === 0 && cur.lsPids.length === 0, state: cur };
    },
    5000,
    150
  );

  if (state.guiPids.length > 0 || state.lsPids.length > 0) {
    appendSwitchLog(paths, `MACOS_SIGTERM gui=${state.guiPids.length} ls=${state.lsPids.length}`);
    sendSigtermToPids([...state.guiPids, ...state.lsPids]);
    state = await pollUntil(
      () => {
        const cur = findDarwinAntigravityPids();
        return { done: cur.guiPids.length === 0 && cur.lsPids.length === 0, state: cur };
      },
      2500,
      150
    );
  }

  appendSwitchLog(paths, `LS_WAIT_DONE remaining=${state.lsPids.length}`);
  if (state.lsPids.length > 0) {
    throw new Error('LS_STILL_RUNNING');
  }
  return {};
}

async function stopLinuxAntigravity(paths) {
  const desktop = findLinuxAntigravityDesktopInfo();
  const lsPids = findLinuxLanguageServerPids();
  const initialTargets = [...desktop.pids, ...lsPids];
  if (initialTargets.length > 0) {
    appendSwitchLog(paths, `LINUX_SIGTERM gui=${desktop.pids.length} ls=${lsPids.length}`);
    sendSigtermToPids(initialTargets);
  }

  const remainingLs = await pollUntil(
    () => {
      const remDesktop = findLinuxAntigravityDesktopInfo();
      const remLs = findLinuxLanguageServerPids();
      return { done: remDesktop.pids.length === 0 && remLs.length === 0, state: remLs.length };
    },
    5000,
    150
  );

  appendSwitchLog(paths, `LS_WAIT_DONE remaining=${remainingLs}`);
  if (remainingLs > 0) {
    throw new Error('LS_STILL_RUNNING');
  }
  return { capturedLinuxExe: desktop.capturedLinuxExe };
}

async function stopAntigravityAndWait(paths, env = process.env, runtime = detectRuntime(env)) {
  await delay(150);
  if (runtime === 'darwin') return stopDarwinAntigravity(paths);
  if (runtime === 'linux') return stopLinuxAntigravity(paths);
  return stopWindowsOrWslAntigravity(paths, env, runtime);
}

export async function runWorker(jobArg, env = process.env, dataDirArg = '') {
  if (typeof jobArg !== 'string' || !jobArg) {
    throw new Error('MISSING_JOB_PATH');
  }
  let paths;
  if (typeof dataDirArg === 'string' && dataDirArg && !env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    assertInsideDir(dataDirArg, jobArg);
    paths = resolvePaths(env, { dataDir: dataDirArg });
  } else {
    paths = resolvePaths(env);
  }
  const resolvedJob = assertInsideDir(paths.jobsDir, jobArg);
  const name = basename(resolvedJob);
  if (!JOB_NAME_RE.test(name)) {
    throw new Error('INVALID_JOB_NAME');
  }
  if (!assertNotSymlink(resolvedJob)) {
    throw new Error('JOB_NOT_FOUND');
  }

  const key = getOrCreateKey(paths);
  let job;
  try {
    const envelope = JSON.parse(readFileSync(resolvedJob, 'utf8'));
    job = decryptPayload(envelope, key);
  } finally {
    try {
      unlinkSync(resolvedJob);
    } catch {
      // Best-effort single-use cleanup
    }
  }

  if (!job || (job.mode !== 'switch' && job.mode !== 'new-login')) {
    throw new Error('INVALID_JOB_PAYLOAD');
  }

  const effectiveEnv = { ...env };
  const ctx = job.context && typeof job.context === 'object' ? job.context : {};
  if (!effectiveEnv.APPDATA && typeof ctx.appData === 'string' && ctx.appData) {
    effectiveEnv.APPDATA = ctx.appData;
  }
  if (!effectiveEnv.LOCALAPPDATA && typeof ctx.localAppData === 'string' && ctx.localAppData) {
    effectiveEnv.LOCALAPPDATA = ctx.localAppData;
  }
  if (
    !effectiveEnv.ANTIGRAVITY_SWITCHER_RELAUNCH_EXE &&
    typeof ctx.relaunchExe === 'string' &&
    ctx.relaunchExe
  ) {
    effectiveEnv.ANTIGRAVITY_SWITCHER_RELAUNCH_EXE = ctx.relaunchExe;
  }
  if (
    !effectiveEnv.ANTIGRAVITY_APP_STORAGE_PATH &&
    typeof ctx.appStoragePath === 'string' &&
    ctx.appStoragePath
  ) {
    effectiveEnv.ANTIGRAVITY_APP_STORAGE_PATH = ctx.appStoragePath;
  }
  if (!effectiveEnv.ANTIGRAVITY_GEMINI_DIR && typeof ctx.geminiDir === 'string' && ctx.geminiDir) {
    effectiveEnv.ANTIGRAVITY_GEMINI_DIR = ctx.geminiDir;
    paths = resolvePaths(effectiveEnv, { dataDir: paths.dataDir });
  }

  let validatedTokenRaw = '';
  if (job.mode === 'switch') {
    const parsed = parseAndValidateTokenRaw(job.tokenRaw, { fallbackEmail: job.targetEmail || '' });
    validatedTokenRaw = parsed.rawJson;
  }

  const targetMasked = maskEmail(job.targetEmail || '') || '-';
  const dryRun = effectiveEnv.SWITCHER_DRY_RUN === '1';
  const runtime = detectRuntime(effectiveEnv);
  appendSwitchLog(paths, `START mode=${job.mode} target=${targetMasked} runtime=${runtime}${dryRun ? ' DRY_RUN' : ''}`);

  try {
    let stopInfo = {};
    if (!dryRun) {
      stopInfo = (await stopAntigravityAndWait(paths, effectiveEnv, runtime)) || {};
    }

    if (job.mode === 'switch') {
      const written = writeActiveTokenRaw(paths, validatedTokenRaw, effectiveEnv);
      appendSwitchLog(
        paths,
        `TOKEN_WRITTEN target=${targetMasked} store=${written.target} keyringCleared=${written.keyringCleared ? 1 : 0}${dryRun ? ' DRY_RUN' : ''}`
      );
    } else {
      const removed = removeActiveTokenRaw(paths, effectiveEnv);
      appendSwitchLog(
        paths,
        `TOKEN_REMOVED_FOR_NEW_LOGIN keyring=${removed.keyringRemoved ? 1 : 0} file=${removed.fileRemoved ? 1 : 0}${dryRun ? ' DRY_RUN' : ''}`
      );
    }

    if (!dryRun) {
      const relaunchCode = relaunchAntigravity(effectiveEnv, runtime, stopInfo);
      appendSwitchLog(paths, relaunchCode);
    }
    appendSwitchLog(paths, `DONE mode=${job.mode}${dryRun ? ' DRY_RUN' : ''}`);
  } catch (err) {
    appendSwitchLog(paths, `ERROR mode=${job.mode} code=${err?.message || 'UNKNOWN'}`);
    throw err;
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

if (isEntryScript()) {
  if (process.argv[2] === '--detach-worker') {
    const jobPath = process.argv[3] || '';
    const dataDirArg = process.argv[4] || '';
    if (!jobPath) {
      console.error('[switcher-worker] failed: MISSING_JOB_PATH');
      process.exit(1);
    }
    const home = homedir();
    const safeCwd = existsSync(home) ? home : tmpdir();
    const childArgs = [fileURLToPath(import.meta.url), jobPath, ...(dataDirArg ? [dataDirArg] : [])];
    const grandchild = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: 'ignore',
      cwd: safeCwd,
      env: process.env,
      windowsHide: true,
    });
    grandchild.on('error', (err) => {
      console.error(`[switcher-worker] detach failed: ${err?.message || 'unknown'}`);
      process.exitCode = 1;
    });
    grandchild.unref();
  } else {
    runWorker(process.argv[2], process.env, process.argv[3] || '').catch((err) => {
      console.error(`[switcher-worker] failed: ${err?.message || 'unknown'}`);
      process.exitCode = 1;
    });
  }
}
