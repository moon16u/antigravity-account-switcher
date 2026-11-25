import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const GOOGLE_AUTH_PREFIX = 'https://accounts.google.com/o/oauth2/v2/auth?';
const MAX_APP_STORAGE_BYTES = 8 * 1024 * 1024;
const WSL_SYSTEM32 = '/mnt/c/Windows/System32';
const RELAUNCH_STRIP_ENV_KEYS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'ANTIGRAVITY_LS_ADDRESS',
  'ANTIGRAVITY_CSRF_TOKEN',
  'ANTIGRAVITY_SIDECAR_ID',
  'ANTIGRAVITY_SIDECAR_UI_TOKEN',
  'ANTIGRAVITY_SIDECAR_WEB_PORT',
  'ANTIGRAVITY_SIDECAR_GATEWAY_URL',
  'ANTIGRAVITY_EXECUTABLE_DATA_DIR',
  'ANTIGRAVITY_AGENTAPI_EXE',
  'ANTIGRAVITY_APP_DATA_DIR',
]);

export function buildRelaunchEnv(env = process.env) {
  const cleanEnv = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (value === undefined) continue;
    if (RELAUNCH_STRIP_ENV_KEYS.has(key.toUpperCase())) continue;
    cleanEnv[key] = value;
  }
  return cleanEnv;
}

function safeHomeCwd() {
  const home = homedir();
  return existsSync(home) ? home : tmpdir();
}

function isRegularNonSymlink(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  try {
    const st = lstatSync(filePath);
    return !st.isSymbolicLink() && st.isFile();
  } catch {
    return false;
  }
}

function isRegularDir(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return false;
  try {
    const st = lstatSync(dirPath);
    return !st.isSymbolicLink() && st.isDirectory();
  } catch {
    return false;
  }
}

function detachChild(bin, args, { windowsHide = false, env = process.env } = {}) {
  const child = spawn(bin, args, {
    detached: true,
    stdio: 'ignore',
    cwd: safeHomeCwd(),
    env,
    ...(windowsHide ? { windowsHide: true } : {}),
  });
  child.on('error', () => {});
  child.unref();
  return child;
}

/**
 * Detects runtime flavor: 'win32' | 'wsl' | 'darwin' | 'linux'.
 */
export function detectRuntime(env = process.env, { platform = process.platform, procVersion = null } = {}) {
  if (platform === 'win32') return 'win32';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') {
    if (env?.WSL_DISTRO_NAME || env?.WSL_INTEROP) {
      return 'wsl';
    }
    let ver = procVersion;
    if (ver === null) {
      try {
        ver = readFileSync('/proc/version', 'utf8');
      } catch {
        ver = '';
      }
    }
    if (/microsoft/i.test(String(ver || ''))) {
      return 'wsl';
    }
  }
  return 'linux';
}

export function winPathToWslPath(winPath) {
  const raw = String(winPath || '').trim();
  const m = /^([a-zA-Z]):(?:[\\/](.*))?$/.exec(raw);
  if (!m) return raw;
  const drive = m[1].toLowerCase();
  const rest = (m[2] || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
}

export function wslPathToWinPath(wslPath) {
  const raw = String(wslPath || '').trim();
  const m = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(raw);
  if (!m) return raw;
  const drive = m[1].toUpperCase();
  const rest = (m[2] || '').replace(/\//g, '\\');
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}

function normalizeWinOrWslOverride(rawPath) {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) return { wsl: '', win: '' };
  if (/^[a-zA-Z]:/.test(trimmed)) {
    return { wsl: winPathToWslPath(trimmed), win: trimmed };
  }
  return { wsl: trimmed, win: wslPathToWinPath(trimmed) };
}

/**
 * Resolves %APPDATA%, %LOCALAPPDATA%, and System32 paths dynamically on win32 or WSL.
 */
export function resolveWindowsDirs(env = process.env, runtime = detectRuntime(env)) {
  if (runtime === 'win32') {
    const userProfile =
      env?.USERPROFILE ||
      (env?.HOMEDRIVE && env?.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : '') ||
      homedir();
    const appData = env?.APPDATA || join(userProfile, 'AppData', 'Roaming');
    const localAppData = env?.LOCALAPPDATA || join(userProfile, 'AppData', 'Local');
    const winRoot = env?.SystemRoot || env?.WINDIR || 'C:\\Windows';
    const system32 = join(winRoot, 'System32');
    return {
      appData,
      localAppData,
      appDataWin: appData,
      localAppDataWin: localAppData,
      appDataWsl: '',
      localAppDataWsl: '',
      system32,
      system32Wsl: '',
    };
  }

  if (runtime !== 'wsl') {
    return {
      appData: '',
      localAppData: '',
      appDataWin: '',
      localAppDataWin: '',
      appDataWsl: '',
      localAppDataWsl: '',
      system32: '',
      system32Wsl: '',
    };
  }

  const ovApp = normalizeWinOrWslOverride(env?.ANTIGRAVITY_WIN_APPDATA);
  const ovLocal = normalizeWinOrWslOverride(env?.ANTIGRAVITY_WIN_LOCALAPPDATA);
  let appDataWsl = ovApp.wsl;
  let localAppDataWsl = ovLocal.wsl;

  if (!appDataWsl || !localAppDataWsl) {
    const pathEnv = String(env?.PATH || '');
    const m = /(?:^|:)(\/mnt\/[a-zA-Z]\/Users\/[^/:]+)\/AppData\//i.exec(pathEnv);
    if (m) {
      const userRootWsl = m[1];
      if (!appDataWsl) appDataWsl = `${userRootWsl}/AppData/Roaming`;
      if (!localAppDataWsl) localAppDataWsl = `${userRootWsl}/AppData/Local`;
    }
  }

  if ((!appDataWsl || !localAppDataWsl) && existsSync(`${WSL_SYSTEM32}/cmd.exe`)) {
    try {
      const out = execFileSync(`${WSL_SYSTEM32}/cmd.exe`, ['/c', 'echo', '%APPDATA%|%LOCALAPPDATA%'], {
        encoding: 'utf8',
        timeout: 3000,
      }).trim();
      const [rawApp, rawLocal] = out.split('|');
      if (!appDataWsl && rawApp && !rawApp.includes('%')) {
        appDataWsl = winPathToWslPath(rawApp.trim());
      }
      if (!localAppDataWsl && rawLocal && !rawLocal.includes('%')) {
        localAppDataWsl = winPathToWslPath(rawLocal.trim());
      }
    } catch {
      // Ignore cmd.exe fallback error when Windows interop is disabled
    }
  }

  return {
    appData: appDataWsl,
    localAppData: localAppDataWsl,
    appDataWsl,
    localAppDataWsl,
    appDataWin: ovApp.win || (appDataWsl ? wslPathToWinPath(appDataWsl) : ''),
    localAppDataWin: ovLocal.win || (localAppDataWsl ? wslPathToWinPath(localAppDataWsl) : ''),
    system32: WSL_SYSTEM32,
    system32Wsl: WSL_SYSTEM32,
  };
}

export function resolveAppStoragePath(env = process.env, runtime = detectRuntime(env)) {
  const override = String(env?.ANTIGRAVITY_APP_STORAGE_PATH || '').trim();
  if (override) return override;

  if (runtime === 'win32') {
    const dirs = resolveWindowsDirs(env, runtime);
    return dirs.appData ? join(dirs.appData, 'Antigravity', 'app_storage.json') : '';
  }
  if (runtime === 'wsl') {
    const dirs = resolveWindowsDirs(env, runtime);
    return dirs.appDataWsl ? `${dirs.appDataWsl}/Antigravity/app_storage.json` : '';
  }
  if (runtime === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Antigravity', 'app_storage.json');
  }
  const xdgConfig = env?.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdgConfig, 'Antigravity', 'app_storage.json');
}

export function readRunInBackgroundSetting(env = process.env, runtime = detectRuntime(env)) {
  const defaultVal = runtime === 'darwin';
  const storagePath = resolveAppStoragePath(env, runtime);
  if (!storagePath) return defaultVal;
  try {
    const st = lstatSync(storagePath);
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_APP_STORAGE_BYTES) {
      return defaultVal;
    }
    const obj = JSON.parse(readFileSync(storagePath, 'utf8'));
    if (obj && Object.prototype.hasOwnProperty.call(obj, 'runInBackground')) {
      return obj.runInBackground === 'true' || obj.runInBackground === true;
    }
    return defaultVal;
  } catch {
    return defaultVal;
  }
}

export function syncOnboardingLastLoginUsername(
  targetEmail,
  env = process.env,
  runtime = detectRuntime(env),
  { storagePath = '', maxBytes = MAX_APP_STORAGE_BYTES } = {}
) {
  const cleanEmail = typeof targetEmail === 'string' ? targetEmail.trim() : '';
  if (!cleanEmail) {
    return { updated: false, reason: 'EMPTY_EMAIL' };
  }

  const targetPath = storagePath || resolveAppStoragePath(env, runtime);
  if (!targetPath) {
    return { updated: false, reason: 'NO_STORAGE_PATH' };
  }

  try {
    const st = lstatSync(targetPath);
    if (st.isSymbolicLink() || !st.isFile() || st.size > maxBytes) {
      return { updated: false, reason: 'MISSING_OR_UNSAFE' };
    }
  } catch {
    return { updated: false, reason: 'MISSING_OR_UNSAFE' };
  }

  let obj;
  try {
    obj = JSON.parse(readFileSync(targetPath, 'utf8'));
  } catch {
    return { updated: false, reason: 'INVALID_JSON' };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { updated: false, reason: 'INVALID_JSON' };
  }

  const hasAgy = Object.prototype.hasOwnProperty.call(obj, 'agy.onboarding.lastLoginUsername');
  const hasJetski = Object.prototype.hasOwnProperty.call(obj, 'jetski.onboarding.lastLoginUsername');
  if (!hasAgy && !hasJetski) {
    return { updated: false, reason: 'NO_PRIOR_ACCEPTANCE' };
  }

  obj['agy.onboarding.lastLoginUsername'] = cleanEmail;
  obj['agy.onboarding.lastLoginIsGcpTos'] = 'false';
  delete obj['jetski.onboarding.lastLoginUsername'];
  delete obj['jetski.onboarding.lastLoginIsGcpTos'];

  const tmpPath = join(dirname(targetPath), `.tmp-onboarding-${randomUUID()}`);
  try {
    writeFileSync(tmpPath, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    renameSync(tmpPath, targetPath);
    return { updated: true, reason: 'UPDATED' };
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup error
    }
    return { updated: false, reason: 'WRITE_FAILED' };
  }
}

export function resolveLanguageServerCandidates(env = process.env, runtime = detectRuntime(env)) {
  const out = [];
  const seen = new Set();
  const pushValid = (p) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    if (isRegularNonSymlink(p)) {
      out.push(p);
    }
  };

  if (env?.ANTIGRAVITY_AGENTAPI_EXE) {
    pushValid(String(env.ANTIGRAVITY_AGENTAPI_EXE).trim());
  }

  if (runtime === 'wsl' || runtime === 'linux') {
    const serverBinRoot = join(homedir(), '.antigravity-server', 'bin');
    if (existsSync(serverBinRoot)) {
      try {
        const versions = readdirSync(serverBinRoot)
          .map((ver) => join(serverBinRoot, ver, 'language_server'))
          .filter((p) => isRegularNonSymlink(p))
          .sort((a, b) => {
            try {
              return statSync(b).mtimeMs - statSync(a).mtimeMs;
            } catch {
              return 0;
            }
          });
        for (const v of versions) pushValid(v);
      } catch {
        // Ignore directory listing errors
      }
    }
    pushValid('/usr/share/antigravity/resources/bin/language_server');
    pushValid('/opt/antigravity/resources/bin/language_server');
    if (runtime === 'wsl') {
      const dirs = resolveWindowsDirs(env, runtime);
      if (dirs.localAppDataWsl) {
        pushValid(`${dirs.localAppDataWsl}/Programs/Antigravity/resources/bin/language_server.exe`);
      }
      pushValid('/mnt/c/Program Files/Antigravity/resources/bin/language_server.exe');
    }
    return out;
  }

  if (runtime === 'win32') {
    const dirs = resolveWindowsDirs(env, runtime);
    if (dirs.localAppData) {
      pushValid(join(dirs.localAppData, 'Programs', 'Antigravity', 'resources', 'bin', 'language_server.exe'));
    }
    const pf = env?.ProgramFiles || 'C:\\Program Files';
    pushValid(join(pf, 'Antigravity', 'resources', 'bin', 'language_server.exe'));
    return out;
  }

  if (runtime === 'darwin') {
    pushValid('/Applications/Antigravity.app/Contents/Resources/bin/language_server');
    pushValid(join(homedir(), 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server'));
    return out;
  }

  return out;
}

export function openExternalBrowserUrl(authUrl, env = process.env, runtime = detectRuntime(env)) {
  if (typeof authUrl !== 'string' || !authUrl.startsWith(GOOGLE_AUTH_PREFIX)) {
    return { opened: false };
  }
  try {
    if (runtime === 'win32') {
      const dirs = resolveWindowsDirs(env, runtime);
      const rundll = join(dirs.system32, 'rundll32.exe');
      if (!existsSync(rundll)) return { opened: false };
      detachChild(rundll, ['url.dll,FileProtocolHandler', authUrl], { windowsHide: true, env });
      return { opened: true };
    }
    if (runtime === 'wsl') {
      const rundll = `${WSL_SYSTEM32}/rundll32.exe`;
      if (!existsSync(rundll)) return { opened: false };
      detachChild(rundll, ['url.dll,FileProtocolHandler', authUrl], { env });
      return { opened: true };
    }
    if (runtime === 'darwin') {
      if (!existsSync('/usr/bin/open')) return { opened: false };
      detachChild('/usr/bin/open', [authUrl], { env });
      return { opened: true };
    }
    detachChild('xdg-open', [authUrl], { env });
    return { opened: true };
  } catch {
    return { opened: false };
  }
}

export function spawnDetachedWorker(
  workerScript,
  jobPath,
  env = process.env,
  runtime = detectRuntime(env),
  { dataDir = '' } = {}
) {
  const childEnv = { ...env };
  const windowsHide = runtime === 'win32';
  const tailArgs = dataDir ? [jobPath, dataDir] : [jobPath];

  if (runtime === 'win32' && env?.SWITCHER_DRY_RUN !== '1') {
    const child = spawn(process.execPath, [workerScript, '--detach-worker', ...tailArgs], {
      detached: true,
      stdio: 'ignore',
      cwd: safeHomeCwd(),
      env: childEnv,
      windowsHide: true,
    });
    child.on('error', (err) => {
      console.error(`[switcher] detach-worker error: ${err?.message || 'unknown'}`);
    });
    child.unref();
    return;
  }

  if ((runtime === 'wsl' || runtime === 'linux') && existsSync('/usr/bin/systemd-run')) {
    try {
      const child = spawn('/usr/bin/systemd-run', ['--user', '--scope', '--quiet', process.execPath, workerScript, ...tailArgs], {
        detached: true,
        stdio: 'ignore',
        cwd: safeHomeCwd(),
        env: childEnv,
      });
      child.on('error', (err) => {
        console.error(`[switcher] systemd-run worker error: ${err?.message || 'unknown'}`);
      });
      child.unref();
      return;
    } catch {
      // Fallback to direct detached Node spawn
    }
  }

  const child = spawn(process.execPath, [workerScript, ...tailArgs], {
    detached: true,
    stdio: 'ignore',
    cwd: safeHomeCwd(),
    env: childEnv,
    ...(windowsHide ? { windowsHide: true } : {}),
  });
  child.on('error', (err) => {
    console.error(`[switcher] worker spawn error: ${err?.message || 'unknown'}`);
  });
  child.unref();
}

export function relaunchAntigravity(env = process.env, runtime = detectRuntime(env), { capturedLinuxExe = '' } = {}) {
  const dirs = resolveWindowsDirs(env, runtime);
  const childEnv = buildRelaunchEnv(env);
  const custom = String(env?.ANTIGRAVITY_SWITCHER_RELAUNCH_EXE || '').trim();

  if (custom && isRegularNonSymlink(custom)) {
    if ((runtime === 'win32' || runtime === 'wsl') && custom.toLowerCase().endsWith('.vbs')) {
      const wscript = runtime === 'win32' ? join(dirs.system32, 'wscript.exe') : `${WSL_SYSTEM32}/wscript.exe`;
      const arg = runtime === 'wsl' ? wslPathToWinPath(custom) : custom;
      if (existsSync(wscript)) {
        detachChild(wscript, [arg], { windowsHide: false, env: childEnv });
        return 'RELAUNCH_CUSTOM_VBS_OK';
      }
    }
    detachChild(custom, [], { windowsHide: false, env: childEnv });
    return 'RELAUNCH_CUSTOM_EXE_OK';
  }

  if (runtime === 'win32' || runtime === 'wsl') {
    const wscript = runtime === 'win32' ? join(dirs.system32, 'wscript.exe') : `${WSL_SYSTEM32}/wscript.exe`;
    const vbsPath =
      runtime === 'win32'
        ? dirs.appData
          ? join(dirs.appData, 'Antigravity', 'launch-env-proxy.vbs')
          : ''
        : dirs.appDataWsl
          ? `${dirs.appDataWsl}/Antigravity/launch-env-proxy.vbs`
          : '';
    if (vbsPath && isRegularNonSymlink(vbsPath) && existsSync(wscript)) {
      const vbsWinArg = runtime === 'wsl' ? wslPathToWinPath(vbsPath) : vbsPath;
      detachChild(wscript, [vbsWinArg], { windowsHide: false, env: childEnv });
      return 'RELAUNCH_VBS_OK';
    }

    const exeCandidates = [];
    if (runtime === 'win32') {
      if (dirs.localAppData) {
        exeCandidates.push(join(dirs.localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'));
      }
      exeCandidates.push(join(env?.ProgramFiles || 'C:\\Program Files', 'Antigravity', 'Antigravity.exe'));
      if (process.execPath && basename(process.execPath).toLowerCase() === 'antigravity.exe') {
        const lowerSet = new Set(exeCandidates.map((p) => p.toLowerCase()));
        if (!lowerSet.has(process.execPath.toLowerCase())) {
          exeCandidates.push(process.execPath);
        }
      }
    } else {
      if (dirs.localAppDataWsl) {
        exeCandidates.push(`${dirs.localAppDataWsl}/Programs/Antigravity/Antigravity.exe`);
      }
      exeCandidates.push('/mnt/c/Program Files/Antigravity/Antigravity.exe');
    }

    for (const exe of exeCandidates) {
      if (isRegularNonSymlink(exe)) {
        detachChild(exe, [], { windowsHide: false, env: childEnv });
        return 'RELAUNCH_EXE_OK';
      }
    }
    return 'RELAUNCH_SKIPPED_MISSING_BIN';
  }

  if (runtime === 'darwin') {
    const agentExe = String(env?.ANTIGRAVITY_AGENTAPI_EXE || '').trim();
    const appMatch = /^(.+\.app)\/Contents\//.exec(agentExe);
    let target = '';
    if (appMatch && isRegularDir(appMatch[1])) {
      target = appMatch[1];
    } else if (isRegularDir('/Applications/Antigravity.app')) {
      target = '/Applications/Antigravity.app';
    } else if (isRegularDir(join(homedir(), 'Applications', 'Antigravity.app'))) {
      target = join(homedir(), 'Applications', 'Antigravity.app');
    } else {
      target = 'Antigravity';
    }
    if (!existsSync('/usr/bin/open')) return 'RELAUNCH_SKIPPED_MISSING_BIN';
    detachChild('/usr/bin/open', ['-a', target], { env: childEnv });
    return 'RELAUNCH_MACOS_OK';
  }

  const linuxCandidates = [
    capturedLinuxExe,
    '/usr/bin/antigravity',
    '/usr/share/antigravity/antigravity',
    '/opt/antigravity/antigravity',
  ].filter(Boolean);
  for (const cand of linuxCandidates) {
    try {
      if (existsSync(cand) && statSync(cand).isFile()) {
        const resolved = realpathSync(cand);
        detachChild(resolved, [], { env: childEnv });
        return 'RELAUNCH_LINUX_OK';
      }
    } catch {
      // Try next binary
    }
  }
  return 'RELAUNCH_SKIPPED_MISSING_BIN';
}
