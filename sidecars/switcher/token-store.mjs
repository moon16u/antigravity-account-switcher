import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { detectRuntime, resolveWindowsDirs } from './platform.mjs';

export const KEYRING_SERVICE = 'gemini';
export const KEYRING_USER = 'antigravity';
export const WIN_CRED_TARGET = `${KEYRING_SERVICE}:${KEYRING_USER}`;
export const WIN_CRED_TARGET_LEGACY = `LegacyGeneric:target=${WIN_CRED_TARGET}`;
export const MAX_CREDENTIAL_BYTES = 32 * 1024;

export function assertInsideDir(baseDir, targetPath) {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(targetPath);
  const prefix = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
  if (!resolvedTarget.startsWith(prefix)) {
    throw new Error('PATH_OUTSIDE_BOUNDARY');
  }
  return resolvedTarget;
}

export function assertNotSymlink(filePath) {
  let st;
  try {
    st = lstatSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error('UNSAFE_FILE_TYPE');
  }
  return true;
}

export function safeChmod(targetPath, mode) {
  if (process.platform === 'win32') return;
  chmodSync(targetPath, mode);
}

export function ensureSecureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const st = lstatSync(dirPath);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error('UNSAFE_DIR_TYPE');
  }
  safeChmod(dirPath, 0o700);
}

export function atomicWriteFile(targetPath, content, mode = 0o600) {
  assertNotSymlink(targetPath);
  const parent = dirname(targetPath);
  ensureSecureDir(parent);
  const tmpPath = assertInsideDir(parent, join(parent, `.tmp-${randomUUID()}`));
  try {
    writeFileSync(tmpPath, content, { encoding: 'utf8', mode, flag: 'wx' });
    safeChmod(tmpPath, mode);
    renameSync(tmpPath, targetPath);
    safeChmod(targetPath, mode);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup error on failed atomic write
    }
    throw err;
  }
}

export function shouldUseOsKeyring(paths, env = process.env, runtime = detectRuntime(env)) {
  if (paths?.useKeyring === false) return false;
  if (env?.SWITCHER_TOKEN_STORE === 'file') return false;
  if (runtime === 'wsl' || runtime === 'win32') return false;
  if (runtime === 'darwin') return true;
  if (runtime === 'linux') return Boolean(env?.DBUS_SESSION_BUS_ADDRESS);
  return false;
}

export function shouldClearWindowsKeyring(paths, env = process.env, runtime = detectRuntime(env)) {
  if (runtime !== 'win32') return false;
  if (paths?.useKeyring === false) return false;
  if (env?.SWITCHER_TOKEN_STORE === 'file') return false;
  return true;
}

export function clearWindowsKeyringEntry(env = process.env, { execFn = execFileSync } = {}) {
  const dirs = resolveWindowsDirs(env, 'win32');
  const sys32 = dirs.system32 || 'C:\\Windows\\System32';
  const cmdkeyExe = join(sys32, 'cmdkey.exe');
  if (execFn === execFileSync && !existsSync(cmdkeyExe)) {
    return false;
  }
  for (const target of [WIN_CRED_TARGET_LEGACY, WIN_CRED_TARGET]) {
    try {
      execFn(cmdkeyExe, [`/delete:${target}`], {
        stdio: 'ignore',
        timeout: 5000,
        windowsHide: true,
      });
      return true;
    } catch {
      // Try next target syntax if not found
    }
  }
  return false;
}

export function decodeMacKeychainSecret(rawText) {
  let text = String(rawText || '').trim();
  if (!text) return '';
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0 && !text.startsWith('{')) {
    try {
      const decoded = Buffer.from(text, 'hex').toString('utf8').trim();
      if (decoded) {
        text = decoded;
      }
    } catch {
      // Keep original text if hex decode fails
    }
  }
  const b64Prefix = 'go-keyring-base64:';
  if (text.startsWith(b64Prefix)) {
    try {
      return Buffer.from(text.slice(b64Prefix.length), 'base64').toString('utf8');
    } catch {
      return '';
    }
  }
  return text;
}

function createOsKeyringBackend(runtime) {
  if (runtime === 'darwin') {
    const securityBin = '/usr/bin/security';
    return {
      read() {
        if (!existsSync(securityBin)) return '';
        try {
          const out = execFileSync(
            securityBin,
            ['find-generic-password', '-s', KEYRING_SERVICE, '-a', KEYRING_USER, '-w'],
            { encoding: 'utf8', timeout: 5000 }
          );
          return decodeMacKeychainSecret(out);
        } catch (err) {
          // status 44 = errSecItemNotFound
          if (err && err.status === 44) return '';
          throw err;
        }
      },
      write(secret) {
        if (!existsSync(securityBin)) {
          throw new Error('KEYRING_BACKEND_UNAVAILABLE');
        }
        if (/[\r\n\0]/.test(secret)) {
          throw new Error('INVALID_KEYRING_SECRET');
        }
        const escaped = secret.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        execFileSync(securityBin, ['-i'], {
          input: `add-generic-password -U -s ${KEYRING_SERVICE} -a ${KEYRING_USER} -w "${escaped}"\n`,
          encoding: 'utf8',
          timeout: 5000,
        });
      },
      remove() {
        if (!existsSync(securityBin)) return false;
        try {
          execFileSync(securityBin, ['delete-generic-password', '-s', KEYRING_SERVICE, '-a', KEYRING_USER], {
            stdio: 'ignore',
            timeout: 5000,
          });
          return true;
        } catch (err) {
          if (err && err.status === 44) return false;
          throw err;
        }
      },
    };
  }

  if (runtime === 'linux') {
    return {
      read() {
        try {
          return execFileSync('secret-tool', ['lookup', 'service', KEYRING_SERVICE, 'username', KEYRING_USER], {
            encoding: 'utf8',
            timeout: 5000,
          });
        } catch (err) {
          if (err && (err.status === 1 || err.code === 'ENOENT')) return '';
          throw err;
        }
      },
      write(secret) {
        execFileSync(
          'secret-tool',
          ['store', `--label=${KEYRING_SERVICE}`, 'service', KEYRING_SERVICE, 'username', KEYRING_USER],
          { input: secret, encoding: 'utf8', timeout: 5000 }
        );
      },
      remove() {
        execFileSync('secret-tool', ['clear', 'service', KEYRING_SERVICE, 'username', KEYRING_USER], {
          stdio: 'ignore',
          timeout: 5000,
        });
        return true;
      },
    };
  }

  return null;
}

export function readActiveTokenRaw(paths, env = process.env, opts = {}) {
  const runtime = opts.runtime || detectRuntime(env);
  const useKeyring = shouldUseOsKeyring(paths, env, runtime);
  const backend = opts.keyringBackend || (useKeyring ? createOsKeyringBackend(runtime) : null);

  if (useKeyring && backend) {
    try {
      const val = backend.read();
      const raw = typeof val === 'string' ? val.trim() : '';
      if (raw) {
        if (Buffer.byteLength(raw, 'utf8') > MAX_CREDENTIAL_BYTES) {
          return { present: true, raw: '', source: 'keyring', oversize: true };
        }
        return { present: true, raw, source: 'keyring' };
      }
    } catch {
      // Keyring unavailable or errored -> fall back to file storage
    }
  }

  if (!assertNotSymlink(paths.tokenPath)) {
    return { present: false, raw: '', source: 'none' };
  }
  const st = lstatSync(paths.tokenPath);
  if (st.size > MAX_CREDENTIAL_BYTES) {
    return { present: true, raw: '', source: 'file', oversize: true };
  }
  const raw = readFileSync(paths.tokenPath, 'utf8');
  return { present: true, raw, source: 'file' };
}

export function writeActiveTokenRaw(paths, rawJson, env = process.env, opts = {}) {
  const runtime = opts.runtime || detectRuntime(env);

  if (shouldClearWindowsKeyring(paths, env, runtime)) {
    const keyringCleared = Boolean(
      typeof opts.winKeyringClear === 'function' ? opts.winKeyringClear() : clearWindowsKeyringEntry(env)
    );
    atomicWriteFile(paths.tokenPath, rawJson, 0o600);
    return { target: 'file', keyringCleared };
  }

  const useKeyring = shouldUseOsKeyring(paths, env, runtime);
  const backend = opts.keyringBackend || (useKeyring ? createOsKeyringBackend(runtime) : null);

  if (useKeyring && backend) {
    try {
      backend.write(rawJson);
      try {
        if (assertNotSymlink(paths.tokenPath)) {
          unlinkSync(paths.tokenPath);
        }
      } catch {
        // Ignore stale file cleanup failure after successful keyring write
      }
      return { target: 'keyring', keyringCleared: false };
    } catch {
      let keyringCleared = false;
      try {
        keyringCleared = Boolean(backend.remove());
      } catch {
        // Best-effort clear stale keyring entry before falling back to file
      }
      atomicWriteFile(paths.tokenPath, rawJson, 0o600);
      return { target: 'file', keyringCleared };
    }
  }

  atomicWriteFile(paths.tokenPath, rawJson, 0o600);
  return { target: 'file', keyringCleared: false };
}

export function removeActiveTokenRaw(paths, env = process.env, opts = {}) {
  const runtime = opts.runtime || detectRuntime(env);
  let keyringRemoved = false;

  if (shouldClearWindowsKeyring(paths, env, runtime)) {
    keyringRemoved = Boolean(
      typeof opts.winKeyringClear === 'function' ? opts.winKeyringClear() : clearWindowsKeyringEntry(env)
    );
  } else {
    const useKeyring = shouldUseOsKeyring(paths, env, runtime);
    const backend = opts.keyringBackend || (useKeyring ? createOsKeyringBackend(runtime) : null);
    if (useKeyring && backend) {
      try {
        keyringRemoved = Boolean(backend.remove());
      } catch {
        keyringRemoved = false;
      }
    }
  }

  let fileRemoved = false;
  if (assertNotSymlink(paths.tokenPath)) {
    unlinkSync(paths.tokenPath);
    fileRemoved = true;
  }

  return { keyringRemoved, fileRemoved };
}
