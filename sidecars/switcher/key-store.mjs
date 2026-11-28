import { execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { detectRuntime, resolveWindowsDirs } from './platform.mjs';
import { assertNotSymlink, decodeWindowsCredentialBlob, ensureSecureDir, safeChmod } from './token-store.mjs';

export const VAULT_KEYRING_SERVICE = 'antigravity-account-switcher';
export const VAULT_KEYRING_ACCOUNT = 'vault-key';
export const WIN_VAULT_KEY_TARGET = 'antigravity-account-switcher:vault-key';

const KEY_HEX_RE = /^[0-9a-f]{64}$/i;
const WIPED_KEY_HEX = '0'.repeat(64);
const vaultKeyCache = new Map();

export function shouldUseVaultKeyring(paths, env = process.env, runtime = detectRuntime(env)) {
  if (paths?.useKeyring === false || env?.SWITCHER_KEY_STORE === 'file' || env?.SWITCHER_TOKEN_STORE === 'file') {
    return false;
  }
  if (runtime === 'win32' || runtime === 'darwin') return true;
  if (runtime === 'linux' || runtime === 'wsl') return Boolean(env?.DBUS_SESSION_BUS_ADDRESS);
  return false;
}

export function parseVaultKeyHex(text) {
  if (typeof text !== 'string' || !KEY_HEX_RE.test(text)) throw new Error('INVALID_KEY_FILE');
  return text.toLowerCase();
}

const WINDOWS_CREDENTIAL_PYTHON = `
import ctypes as c
from ctypes import wintypes as w

class Credential(c.Structure):
    _fields_ = [
        ('Flags', w.DWORD), ('Type', w.DWORD), ('TargetName', w.LPWSTR),
        ('Comment', w.LPWSTR), ('LastWritten', w.FILETIME),
        ('CredentialBlobSize', w.DWORD), ('CredentialBlob', c.c_void_p),
        ('Persist', w.DWORD), ('AttributeCount', w.DWORD), ('Attributes', c.c_void_p),
        ('TargetAlias', w.LPWSTR), ('UserName', w.LPWSTR),
    ]

api = c.WinDLL('advapi32', use_last_error=True)
target = '${WIN_VAULT_KEY_TARGET}'
`;

const WINDOWS_READ_PYTHON = WINDOWS_CREDENTIAL_PYTHON + `
import base64

PCredential = c.POINTER(Credential)
api.CredReadW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, c.POINTER(PCredential)]
api.CredReadW.restype = w.BOOL
api.CredFree.argtypes = [c.c_void_p]
api.CredFree.restype = None
ptr = PCredential()
if not api.CredReadW(target, 1, 0, c.byref(ptr)):
    if c.get_last_error() != 1168:
        raise SystemExit(1)
    print('CRED_NOT_FOUND')
else:
    try:
        cred = ptr.contents
        blob = c.string_at(cred.CredentialBlob, cred.CredentialBlobSize)
        print('CRED_B64:' + base64.b64encode(blob).decode('ascii'))
    finally:
        api.CredFree(ptr)
`;

const WINDOWS_WRITE_PYTHON = WINDOWS_CREDENTIAL_PYTHON + `
import sys

api.CredWriteW.argtypes = [c.POINTER(Credential), w.DWORD]
api.CredWriteW.restype = w.BOOL
secret = sys.stdin.readline().rstrip('\\r\\n').encode('utf-8')
blob = c.create_string_buffer(secret)
cred = Credential(0, 1, target, None, w.FILETIME(), len(secret), c.cast(blob, c.c_void_p),
                  2, 0, None, None, '${VAULT_KEYRING_ACCOUNT}')
if not api.CredWriteW(c.byref(cred), 0):
    raise SystemExit(1)
`;

const WINDOWS_CREDENTIAL_POWERSHELL = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class AntigravityVaultCredential {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
        public uint Flags, Type;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetName, Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias, UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr ptr);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool CredWriteW(ref Credential credential, uint flags);
    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern void CredFree(IntPtr ptr);

    private const string Target = "${WIN_VAULT_KEY_TARGET}";

    public static string Read() {
        IntPtr ptr;
        if (!CredReadW(Target, 1, 0, out ptr)) {
            int error = Marshal.GetLastWin32Error();
            if (error == 1168) return "CRED_NOT_FOUND";
            throw new Win32Exception(error);
        }
        try {
            var cred = (Credential)Marshal.PtrToStructure(ptr, typeof(Credential));
            byte[] blob = new byte[cred.CredentialBlobSize];
            if (blob.Length > 0) Marshal.Copy(cred.CredentialBlob, blob, 0, blob.Length);
            return "CRED_B64:" + Convert.ToBase64String(blob);
        } finally {
            CredFree(ptr);
        }
    }

    public static void Write(string secret) {
        byte[] bytes = Encoding.UTF8.GetBytes(secret);
        IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            var cred = new Credential {
                Type = 1, TargetName = Target, CredentialBlobSize = (uint)bytes.Length,
                CredentialBlob = blob, Persist = 2, UserName = "${VAULT_KEYRING_ACCOUNT}"
            };
            if (!CredWriteW(ref cred, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally {
            Marshal.FreeHGlobal(blob);
        }
    }
}
'@
`;

const MISSING_KEY = { ok: true, found: false, keyHex: '' };

function foundKey(keyHex, backend) {
  return KEY_HEX_RE.test(keyHex)
    ? { ok: true, found: true, keyHex, backend }
    : { ok: false, found: true, keyHex: '', backend };
}

function unavailableKey(backend) {
  return { ok: false, found: false, keyHex: '', backend };
}

function createWindowsBackend(env, run, remove) {
  function* attempts(python, powershell) {
    const psArgs = ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_CREDENTIAL_POWERSHELL + powershell];
    yield ['python', 'python', ['-c', python]];
    yield ['python', 'py', ['-3', '-c', python]];
    yield ['python', 'python3', ['-c', python]];
    yield ['pwsh', 'pwsh', psArgs];
    yield ['powershell', 'powershell.exe', psArgs];
  }

  return {
    read() {
      for (const [backend, bin, args] of attempts(WINDOWS_READ_PYTHON, '[AntigravityVaultCredential]::Read()')) {
        try {
          const output = String(run(bin, args) || '').replace(/\r/g, '');
          if (/^CRED_NOT_FOUND$/m.test(output)) return { ...MISSING_KEY, backend };
          const match = /^CRED_B64:((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/m.exec(output);
          if (match) return foundKey(decodeWindowsCredentialBlob(Buffer.from(match[1], 'base64')), backend);
        } catch {
          // Invocation errors can contain credentials from stdout or stderr.
        }
      }
      return unavailableKey('win32');
    },
    write(keyHex) {
      const input = parseVaultKeyHex(keyHex) + '\n';
      const psWrite = '[AntigravityVaultCredential]::Write([Console]::In.ReadLine())';
      for (const [, bin, args] of attempts(WINDOWS_WRITE_PYTHON, psWrite)) {
        try {
          run(bin, args, input);
          return true;
        } catch {
          // Try the next interpreter without exposing the invocation error.
        }
      }
      return false;
    },
    remove() {
      const { system32 } = resolveWindowsDirs(env, 'win32');
      return remove(join(system32, 'cmdkey.exe'), [`/delete:${WIN_VAULT_KEY_TARGET}`], { windowsHide: true });
    },
  };
}

export function createVaultKeyBackend(runtime, env = process.env, { execFn = execFileSync } = {}) {
  function run(bin, args, input) {
    return execFn(bin, args, {
      env, input, encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
  }
  function remove(bin, args, options) {
    try {
      execFn(bin, args, { env, timeout: 5000, stdio: 'ignore', ...options });
      return true;
    } catch {
      return false;
    }
  }

  if (runtime === 'win32') return createWindowsBackend(env, run, remove);
  const mac = runtime === 'darwin';
  if (!mac && ((runtime !== 'linux' && runtime !== 'wsl') || !env?.DBUS_SESSION_BUS_ADDRESS)) return null;

  const bin = mac ? '/usr/bin/security' : 'secret-tool';
  const backend = mac ? 'security' : 'secret-tool';
  const attributes = mac
    ? ['-s', VAULT_KEYRING_SERVICE, '-a', VAULT_KEYRING_ACCOUNT]
    : ['service', VAULT_KEYRING_SERVICE, 'username', VAULT_KEYRING_ACCOUNT];
  return {
    read() {
      const args = mac ? ['find-generic-password', ...attributes, '-w'] : ['lookup', ...attributes];
      try {
        let keyHex = String(run(bin, args) || '').trim();
        if (mac && /^[0-9a-f]{128}$/i.test(keyHex)) {
          keyHex = Buffer.from(keyHex, 'hex').toString('utf8');
        }
        return foundKey(keyHex, backend);
      } catch (err) {
        if (err?.status === (mac ? 44 : 1)) return { ...MISSING_KEY, backend };
        return unavailableKey(backend);
      }
    },
    write(keyHex) {
      const hex = parseVaultKeyHex(keyHex);
      try {
        if (mac) {
          run(bin, ['-i'], `add-generic-password -U ${attributes.join(' ')} -w "${hex}"\n`);
        } else {
          run(bin, ['store', `--label=${VAULT_KEYRING_SERVICE}`, ...attributes], hex);
        }
        return true;
      } catch {
        return false;
      }
    },
    remove() {
      return remove(bin, [mac ? 'delete-generic-password' : 'clear', ...attributes]);
    },
  };
}

export function clearVaultKeyCache() {
  vaultKeyCache.clear();
}

function cacheId(paths, useKeyring) {
  return `${paths.dataDir}|${useKeyring ? 'kr' : 'file'}`;
}

export function getCachedVaultKeyInfo(paths, env = process.env, opts = {}) {
  if (opts.keyBackend && opts.useCache !== true) return null;
  // Linux and WSL use the same policy. Skip the /proc/version probe on cache lookups.
  const runtime = opts.runtime || detectRuntime(env, { procVersion: '' });
  const entry = vaultKeyCache.get(cacheId(paths, shouldUseVaultKeyring(paths, env, runtime)));
  return entry ? { source: entry.source, backend: entry.backend } : null;
}

function readKeyFile(keyPath) {
  if (!assertNotSymlink(keyPath)) return null;
  const flag = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  try {
    const text = readFileSync(keyPath, { encoding: 'utf8', flag });
    return Buffer.from(parseVaultKeyHex(text.trim()), 'hex');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function createKeyFile(keyPath, key) {
  try {
    writeFileSync(keyPath, key.toString('hex') + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    safeChmod(keyPath, 0o600);
    return key;
  } catch (err) {
    if (err?.code === 'EEXIST') {
      const existing = readKeyFile(keyPath);
      if (existing) return existing;
    }
    throw err;
  }
}

function wipeKeyFile(keyPath, key) {
  try {
    if (!assertNotSymlink(keyPath)) return false;
    const fd = openSync(keyPath, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let stat;
    try {
      stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) return false;
      const fileHex = parseVaultKeyHex(readFileSync(fd, 'utf8').trim());
      if (!timingSafeEqual(Buffer.from(fileHex, 'hex'), key)) return false;
      const zeros = WIPED_KEY_HEX + '\n';
      if (writeSync(fd, zeros, 0, 'utf8') !== zeros.length) return false;
      ftruncateSync(fd, zeros.length);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const current = lstatSync(keyPath);
    if (current.dev !== stat.dev || current.ino !== stat.ino) return false;
    unlinkSync(keyPath);
    return true;
  } catch {
    return false;
  }
}

function readKeyring(backend) {
  try {
    const result = backend.read();
    if (result?.ok && result.found) return { ...result, keyHex: parseVaultKeyHex(result.keyHex) };
    return result;
  } catch {
    return null;
  }
}

function writeAndVerify(backend, keyHex) {
  try {
    if (backend.write(keyHex) === false) return null;
    const verify = readKeyring(backend);
    if (verify?.ok && verify.found && verify.keyHex === keyHex) return verify;
  } catch {
    // Keep the existing file intact if the keyring write fails.
  }
  return null;
}

export function resolveVaultKey(paths, env = process.env, opts = {}) {
  const runtime = opts.runtime || detectRuntime(env);
  const useKeyring = shouldUseVaultKeyring(paths, env, runtime);
  const useCache = !opts.keyBackend || opts.useCache === true;
  const id = cacheId(paths, useKeyring);
  const cached = useCache ? vaultKeyCache.get(id) : null;
  if (cached) return { ...cached, key: Buffer.from(cached.key) };

  function result(key, source, backend) {
    if (useCache) vaultKeyCache.set(id, { key: Buffer.from(key), source, backend });
    return { key, source, backend };
  }

  ensureSecureDir(paths.dataDir);
  const backend = useKeyring ? opts.keyBackend || createVaultKeyBackend(runtime, env, opts) : null;
  let res = backend ? readKeyring(backend) : null;
  const rawFileKey = readKeyFile(paths.keyPath);
  const isWipedTombstone = Boolean(rawFileKey && rawFileKey.toString('hex') === WIPED_KEY_HEX);
  const fileKey = isWipedTombstone ? null : rawFileKey;
  if (
    res?.ok && !res.found &&
    !fileKey &&
    assertNotSymlink(paths.vaultPath)
  ) {
    // Another process may have verified and started removing the legacy key since our lookup.
    res = readKeyring(backend);
  }
  const backendName = res?.backend || runtime;

  if (res?.ok && res.found) {
    const krKey = Buffer.from(res.keyHex, 'hex');
    if (isWipedTombstone) {
      wipeKeyFile(paths.keyPath, rawFileKey);
    } else if (fileKey) {
      if (timingSafeEqual(krKey, fileKey)) {
        if (wipeKeyFile(paths.keyPath, fileKey)) opts.onEvent?.('VAULT_KEY_CLEANED_DUPLICATE', backendName);
      } else {
        if (assertNotSymlink(paths.vaultPath) && opts.canDecrypt) {
          const krCanDecrypt = opts.canDecrypt(krKey);
          if (opts.canDecrypt(fileKey) && !krCanDecrypt) {
            opts.onEvent?.('VAULT_KEY_CONFLICT_FILE_KEPT', backendName);
            return result(fileKey, 'file', 'file');
          }
        }
        opts.onEvent?.('VAULT_KEY_CONFLICT_KEYRING_KEPT', backendName);
      }
    }
    return result(krKey, 'keyring', backendName);
  }

  const key = fileKey || randomBytes(32);
  if (res?.ok && !res.found) {
    const verify = writeAndVerify(backend, key.toString('hex'));
    if (verify) {
      const verifiedBackend = verify.backend || backendName;
      if (fileKey) {
        wipeKeyFile(paths.keyPath, fileKey);
        opts.onEvent?.('VAULT_KEY_MIGRATED', verifiedBackend);
      } else if (isWipedTombstone) {
        wipeKeyFile(paths.keyPath, rawFileKey);
      }
      return result(key, 'keyring', verifiedBackend);
    }
  }
  if (isWipedTombstone) wipeKeyFile(paths.keyPath, rawFileKey);
  return result(fileKey || createKeyFile(paths.keyPath, key), 'file', 'file');
}
