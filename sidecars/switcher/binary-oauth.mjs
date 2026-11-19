const CLIENT_ID_RE = /\d{8,}-[A-Za-z0-9_-]{10,}\.apps\.googleusercontent\.com/g;
const CLIENT_SECRET_RE = /GOCSPX-[A-Za-z0-9_-]{15,}/g;
const ID_EXACT_RE = /^\d{8,}-[A-Za-z0-9_-]{10,}\.apps\.googleusercontent\.com$/;
const SECRET_EXACT_RE = /^GOCSPX-[A-Za-z0-9_-]{17,}$/;

const MOV_QWORD_MEM_PATTERNS = Object.freeze([
  {
    size: 12,
    match: (b, p) => (b[p] === 0x48 || b[p] === 0x49) && b[p + 1] === 0xc7 && b[p + 2] === 0x84 && b[p + 3] === 0x24,
  },
  {
    size: 9,
    match: (b, p) => (b[p] === 0x48 || b[p] === 0x49) && b[p + 1] === 0xc7 && b[p + 2] === 0x44 && b[p + 3] === 0x24,
  },
  {
    size: 11,
    match: (b, p) =>
      (b[p] === 0x48 || b[p] === 0x49) && b[p + 1] === 0xc7 && (b[p + 2] & 0xf8) === 0x80 && (b[p + 2] & 0x07) !== 4,
  },
  {
    size: 8,
    match: (b, p) =>
      (b[p] === 0x48 || b[p] === 0x49) && b[p + 1] === 0xc7 && (b[p + 2] & 0xf8) === 0x40 && (b[p + 2] & 0x07) !== 4,
  },
  {
    size: 7,
    match: (b, p) =>
      (b[p] === 0x48 || b[p] === 0x49) &&
      b[p + 1] === 0xc7 &&
      (b[p + 2] & 0xf8) === 0x00 &&
      (b[p + 2] & 0x07) !== 4 &&
      (b[p + 2] & 0x07) !== 5,
  },
]);

const MOV_R32_PATTERN = Object.freeze({
  size: 5,
  match: (b, p) => b[p] >= 0xb8 && b[p] <= 0xbf,
});

function lengthBoundsForKind(kind) {
  return kind === 'secret' ? { minLen: 24, maxLen: 64 } : { minLen: 40, maxLen: 128 };
}

function matchImm32Pattern(buf, p, pattern, minLen, maxLen) {
  if (p < 0 || p + pattern.size > buf.length || !pattern.match(buf, p)) {
    return null;
  }
  const len = buf.readUInt32LE(p + pattern.size - 4);
  return len >= minLen && len <= maxLen ? len : null;
}

function decodeGoX64StringLength(textBuf, leaOffset, kind) {
  const { minLen, maxLen } = lengthBoundsForKind(kind);

  for (const pat of MOV_QWORD_MEM_PATTERNS) {
    const val = matchImm32Pattern(textBuf, leaOffset - pat.size, pat, minLen, maxLen);
    if (val !== null) return val;
  }
  const immBefore = matchImm32Pattern(textBuf, leaOffset - MOV_R32_PATTERN.size, MOV_R32_PATTERN, minLen, maxLen);
  if (immBefore !== null) return immBefore;

  const fwdStart = leaOffset + 7;
  const fwdEnd = Math.min(textBuf.length - 5, leaOffset + 24);
  for (let p = fwdStart; p <= fwdEnd; p += 1) {
    for (const pat of MOV_QWORD_MEM_PATTERNS) {
      const val = matchImm32Pattern(textBuf, p, pat, minLen, maxLen);
      if (val !== null) return val;
    }
  }
  for (let p = fwdStart; p <= fwdEnd; p += 1) {
    const val = matchImm32Pattern(textBuf, p, MOV_R32_PATTERN, minLen, maxLen);
    if (val !== null) return val;
  }
  return null;
}

function decodeGoArm64StringLength(textBuf, adrpOffset, addOffset, kind) {
  const { minLen, maxLen } = lengthBoundsForKind(kind);
  const start = Math.max(0, adrpOffset - 16);
  const end = Math.min(textBuf.length - 4, addOffset + 24);
  for (let p = start; p <= end; p += 4) {
    const insn = textBuf.readUInt32LE(p);
    if ((insn & 0x7fe00000) >>> 0 === 0x52800000) {
      const imm16 = (insn >>> 5) & 0xffff;
      if (imm16 >= minLen && imm16 <= maxLen) {
        return imm16;
      }
    }
  }
  return null;
}

function buildVaTargets(roText, roVa) {
  const baseVa = BigInt(roVa);
  const vaTargets = new Map();
  for (const m of roText.matchAll(CLIENT_ID_RE)) {
    vaTargets.set(baseVa + BigInt(m.index), { kind: 'id', roOffset: m.index, maxMatch: m[0] });
  }
  for (const m of roText.matchAll(CLIENT_SECRET_RE)) {
    vaTargets.set(baseVa + BigInt(m.index), { kind: 'secret', roOffset: m.index, maxMatch: m[0] });
  }
  return vaTargets;
}

function resolveRefValue(hit, roText, decodedLen) {
  if (decodedLen !== null && hit.roOffset + decodedLen <= roText.length) {
    const candidate = roText.slice(hit.roOffset, hit.roOffset + decodedLen);
    const validator = hit.kind === 'secret' ? SECRET_EXACT_RE : ID_EXACT_RE;
    if (validator.test(candidate)) {
      return { value: candidate, exactLen: true };
    }
  }
  if (hit.kind === 'secret') {
    const fallback = hit.maxMatch.length >= 35 ? hit.maxMatch.slice(0, 35) : hit.maxMatch;
    return { value: fallback, exactLen: false };
  }
  return { value: hit.maxMatch, exactLen: false };
}

function pairAndSortClients(refs) {
  const idRefs = refs.filter((r) => r.kind === 'id');
  const secretRefs = refs.filter((r) => r.kind === 'secret');
  const byId = new Map();

  for (const idRef of idRefs) {
    let bestSecret = null;
    let bestDist = Infinity;
    for (const secRef of secretRefs) {
      const dist = Math.abs(secRef.pc - idRef.pc);
      if (dist > 0x400) continue;
      if (
        !bestSecret ||
        (secRef.exactLen && !bestSecret.exactLen) ||
        (secRef.exactLen === bestSecret.exactLen && dist < bestDist)
      ) {
        bestDist = dist;
        bestSecret = secRef;
      }
    }
    if (bestSecret) {
      const score = (idRef.exactLen ? 1 : 0) + (bestSecret.exactLen ? 2 : 0);
      const existing = byId.get(idRef.value);
      if (!existing || score > existing.score) {
        byId.set(idRef.value, { id: idRef.value, secret: bestSecret.value, score });
      }
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => {
      const aPri = a.id.startsWith('1071006060591-') ? 0 : 1;
      const bPri = b.id.startsWith('1071006060591-') ? 0 : 1;
      if (aPri !== bPri) return aPri - bPri;
      return b.score - a.score;
    })
    .map(({ id, secret }) => ({ id, secret }));
}

export function extractX64OAuthClients({ textBuf, textVa, roText, roVa }) {
  const vaTargets = buildVaTargets(roText, roVa);
  if (vaTargets.size === 0) return [];

  const baseTextVa = BigInt(textVa);
  const refs = [];
  for (let i = 0; i <= textBuf.length - 7; i += 1) {
    const b0 = textBuf[i];
    if ((b0 === 0x48 || b0 === 0x4c) && textBuf[i + 1] === 0x8d && (textBuf[i + 2] & 0xc7) === 0x05) {
      const disp = textBuf.readInt32LE(i + 3);
      const targetVa = baseTextVa + BigInt(i + 7) + BigInt(disp);
      const hit = vaTargets.get(targetVa);
      if (!hit) continue;

      const decodedLen = decodeGoX64StringLength(textBuf, i, hit.kind);
      const { value, exactLen } = resolveRefValue(hit, roText, decodedLen);
      refs.push({ pc: i, kind: hit.kind, value, exactLen });
    }
  }

  return pairAndSortClients(refs);
}

export function extractArm64OAuthClients({ textBuf, textVa, roText, roVa }) {
  const vaTargets = buildVaTargets(roText, roVa);
  if (vaTargets.size === 0) return [];

  const baseTextVa = BigInt(textVa);
  const refs = [];
  for (let i = 0; i <= textBuf.length - 8; i += 4) {
    const insn = textBuf.readUInt32LE(i);
    if ((insn & 0x9f000000) >>> 0 !== 0x90000000) continue;

    const rd = insn & 0x1f;
    const immlo = (insn >>> 29) & 0x3;
    const immhi = (insn >>> 5) & 0x7ffff;
    const rawImm21 = (immhi << 2) | immlo;
    const imm21 = rawImm21 & 0x100000 ? BigInt(rawImm21 - 0x200000) : BigInt(rawImm21);
    const pcVa = baseTextVa + BigInt(i);
    const pageVa = (pcVa & ~0xfffn) + (imm21 << 12n);

    for (let k = 1; k <= 4; k += 1) {
      const j = i + k * 4;
      if (j > textBuf.length - 4) break;
      const next = textBuf.readUInt32LE(j);
      if ((next & 0x9f000000) >>> 0 === 0x90000000 && (next & 0x1f) === rd) {
        break;
      }
      if ((next & 0xff800000) >>> 0 !== 0x91000000) continue;
      const rn = (next >>> 5) & 0x1f;
      if (rn !== rd) continue;

      const shift = ((next >>> 22) & 1) ? 12n : 0n;
      const imm12 = BigInt((next >>> 10) & 0xfff) << shift;
      const targetVa = pageVa + imm12;
      const hit = vaTargets.get(targetVa);
      if (!hit) continue;

      const decodedLen = decodeGoArm64StringLength(textBuf, i, j, hit.kind);
      const { value, exactLen } = resolveRefValue(hit, roText, decodedLen);
      refs.push({ pc: i, kind: hit.kind, value, exactLen });
      break;
    }
  }

  return pairAndSortClients(refs);
}

function readNullTerminatedAscii(buf, start, maxLen) {
  const slice = buf.subarray(start, Math.min(buf.length, start + maxLen));
  const zero = slice.indexOf(0);
  return slice.subarray(0, zero >= 0 ? zero : slice.length).toString('ascii');
}

export function extractElfOAuthClients(binaryBuf) {
  if (!Buffer.isBuffer(binaryBuf) || binaryBuf.length < 64) {
    return [];
  }
  if (
    binaryBuf[0] !== 0x7f ||
    binaryBuf[1] !== 0x45 ||
    binaryBuf[2] !== 0x4c ||
    binaryBuf[3] !== 0x46 ||
    binaryBuf[4] !== 2 ||
    binaryBuf[5] !== 1
  ) {
    return [];
  }

  const eMachine = binaryBuf.readUInt16LE(18);
  const eShoff = Number(binaryBuf.readBigUInt64LE(40));
  const eShentsize = binaryBuf.readUInt16LE(58);
  const eShnum = binaryBuf.readUInt16LE(60);
  const eShstrndx = binaryBuf.readUInt16LE(62);
  if (
    eShentsize < 64 ||
    eShnum <= 0 ||
    eShstrndx >= eShnum ||
    eShoff + eShnum * eShentsize > binaryBuf.length
  ) {
    return [];
  }

  const shstrMetaOff = eShoff + eShstrndx * eShentsize;
  const shstrOff = Number(binaryBuf.readBigUInt64LE(shstrMetaOff + 24));
  const shstrSz = Number(binaryBuf.readBigUInt64LE(shstrMetaOff + 32));
  if (shstrOff + shstrSz > binaryBuf.length) {
    return [];
  }
  const shstr = binaryBuf.subarray(shstrOff, shstrOff + shstrSz);

  let textSec = null;
  let rodataSec = null;
  for (let i = 0; i < eShnum; i += 1) {
    const off = eShoff + i * eShentsize;
    const shName = binaryBuf.readUInt32LE(off);
    const shAddr = binaryBuf.readBigUInt64LE(off + 16);
    const shOffset = Number(binaryBuf.readBigUInt64LE(off + 24));
    const shSize = Number(binaryBuf.readBigUInt64LE(off + 32));
    const nameEnd = shstr.indexOf(0, shName);
    const name = shstr.subarray(shName, nameEnd >= 0 ? nameEnd : shstr.length).toString('ascii');
    if (name === '.text') textSec = { addr: shAddr, off: shOffset, size: shSize };
    if (name === '.rodata') rodataSec = { addr: shAddr, off: shOffset, size: shSize };
  }

  if (
    !textSec ||
    !rodataSec ||
    textSec.off + textSec.size > binaryBuf.length ||
    rodataSec.off + rodataSec.size > binaryBuf.length
  ) {
    return [];
  }

  const args = {
    textBuf: binaryBuf.subarray(textSec.off, textSec.off + textSec.size),
    textVa: textSec.addr,
    roText: binaryBuf.subarray(rodataSec.off, rodataSec.off + rodataSec.size).toString('latin1'),
    roVa: rodataSec.addr,
  };
  if (eMachine === 0xb7) return extractArm64OAuthClients(args);
  if (eMachine === 0x3e) return extractX64OAuthClients(args);
  return [];
}

export function extractPeOAuthClients(binaryBuf) {
  if (!Buffer.isBuffer(binaryBuf) || binaryBuf.length < 0x40) {
    return [];
  }
  if (binaryBuf[0] !== 0x4d || binaryBuf[1] !== 0x5a) {
    return [];
  }
  const peOff = binaryBuf.readUInt32LE(0x3c);
  if (peOff + 24 > binaryBuf.length) return [];
  if (
    binaryBuf[peOff] !== 0x50 ||
    binaryBuf[peOff + 1] !== 0x45 ||
    binaryBuf[peOff + 2] !== 0 ||
    binaryBuf[peOff + 3] !== 0
  ) {
    return [];
  }

  const machine = binaryBuf.readUInt16LE(peOff + 4);
  const numSecs = binaryBuf.readUInt16LE(peOff + 6);
  const optSize = binaryBuf.readUInt16LE(peOff + 20);
  const optOff = peOff + 24;
  if (optSize < 32 || optOff + optSize + numSecs * 40 > binaryBuf.length) {
    return [];
  }
  const optMagic = binaryBuf.readUInt16LE(optOff);
  if (optMagic !== 0x20b) {
    return [];
  }
  const imageBase = binaryBuf.readBigUInt64LE(optOff + 24);
  const secOff = optOff + optSize;

  let textSec = null;
  let rdataSec = null;
  for (let i = 0; i < numSecs; i += 1) {
    const o = secOff + i * 40;
    const name = readNullTerminatedAscii(binaryBuf, o, 8);
    const vaddr = binaryBuf.readUInt32LE(o + 12);
    const rawSize = binaryBuf.readUInt32LE(o + 16);
    const rawPtr = binaryBuf.readUInt32LE(o + 20);
    if (name === '.text') {
      textSec = { addr: imageBase + BigInt(vaddr), off: rawPtr, size: rawSize };
    } else if (name === '.rdata') {
      rdataSec = { addr: imageBase + BigInt(vaddr), off: rawPtr, size: rawSize };
    }
  }

  if (
    !textSec ||
    !rdataSec ||
    textSec.off + textSec.size > binaryBuf.length ||
    rdataSec.off + rdataSec.size > binaryBuf.length
  ) {
    return [];
  }

  const args = {
    textBuf: binaryBuf.subarray(textSec.off, textSec.off + textSec.size),
    textVa: textSec.addr,
    roText: binaryBuf.subarray(rdataSec.off, rdataSec.off + rdataSec.size).toString('latin1'),
    roVa: rdataSec.addr,
  };
  if (machine === 0xaa64) return extractArm64OAuthClients(args);
  if (machine === 0x8664) return extractX64OAuthClients(args);
  return [];
}

function extractSingleMachO64(binaryBuf) {
  if (!Buffer.isBuffer(binaryBuf) || binaryBuf.length < 32) {
    return [];
  }
  if (binaryBuf.readUInt32LE(0) !== 0xfeedfacf) {
    return [];
  }

  const cputype = binaryBuf.readInt32LE(4);
  const ncmds = binaryBuf.readUInt32LE(16);
  const sizeofcmds = binaryBuf.readUInt32LE(20);
  if (32 + sizeofcmds > binaryBuf.length) {
    return [];
  }

  let textSec = null;
  let rodataSec = null;
  let secondaryRodataSec = null;
  let cmdOff = 32;

  for (let i = 0; i < ncmds && cmdOff + 8 <= 32 + sizeofcmds; i += 1) {
    const cmd = binaryBuf.readUInt32LE(cmdOff);
    const cmdsize = binaryBuf.readUInt32LE(cmdOff + 4);
    if (cmdsize < 8 || cmdOff + cmdsize > binaryBuf.length) break;

    if (cmd === 0x19 && cmdsize >= 72) {
      const nsects = binaryBuf.readUInt32LE(cmdOff + 64);
      let sectOff = cmdOff + 72;
      for (let s = 0; s < nsects && sectOff + 80 <= cmdOff + cmdsize; s += 1) {
        const sectname = readNullTerminatedAscii(binaryBuf, sectOff, 16);
        const segname = readNullTerminatedAscii(binaryBuf, sectOff + 16, 16);
        const addr = binaryBuf.readBigUInt64LE(sectOff + 32);
        const size = Number(binaryBuf.readBigUInt64LE(sectOff + 40));
        const offset = binaryBuf.readUInt32LE(sectOff + 48);

        if (segname === '__TEXT' && sectname === '__text') {
          textSec = { addr, off: offset, size };
        } else if (segname === '__TEXT' && sectname === '__rodata') {
          rodataSec = { addr, off: offset, size };
        } else if (!secondaryRodataSec && (sectname === '__const' || sectname === '__cstring')) {
          secondaryRodataSec = { addr, off: offset, size };
        }
        sectOff += 80;
      }
    }
    cmdOff += cmdsize;
  }

  const roSec = rodataSec || secondaryRodataSec;
  if (
    !textSec ||
    !roSec ||
    textSec.off + textSec.size > binaryBuf.length ||
    roSec.off + roSec.size > binaryBuf.length
  ) {
    return [];
  }

  const args = {
    textBuf: binaryBuf.subarray(textSec.off, textSec.off + textSec.size),
    textVa: textSec.addr,
    roText: binaryBuf.subarray(roSec.off, roSec.off + roSec.size).toString('latin1'),
    roVa: roSec.addr,
  };
  if (cputype === 0x0100000c) return extractArm64OAuthClients(args);
  if (cputype === 0x01000007) return extractX64OAuthClients(args);
  return [];
}

export function extractMachOOAuthClients(binaryBuf) {
  if (!Buffer.isBuffer(binaryBuf) || binaryBuf.length < 16) {
    return [];
  }
  const beMagic = binaryBuf.readUInt32BE(0);
  if (beMagic === 0xcafebabe || beMagic === 0xcafebabf) {
    const is64 = beMagic === 0xcafebabf;
    const archSize = is64 ? 32 : 20;
    const nfat = binaryBuf.readUInt32BE(4);
    if (nfat > 16 || 8 + nfat * archSize > binaryBuf.length) {
      return [];
    }
    for (let i = 0; i < nfat; i += 1) {
      const o = 8 + i * archSize;
      const offset = is64 ? Number(binaryBuf.readBigUInt64BE(o + 8)) : binaryBuf.readUInt32BE(o + 8);
      const size = is64 ? Number(binaryBuf.readBigUInt64BE(o + 16)) : binaryBuf.readUInt32BE(o + 12);
      if (offset >= 0 && size > 0 && offset + size <= binaryBuf.length) {
        const res = extractSingleMachO64(binaryBuf.subarray(offset, offset + size));
        if (res.length > 0) return res;
      }
    }
    return [];
  }
  return extractSingleMachO64(binaryBuf);
}

export function extractBinaryOAuthClients(binaryBuf) {
  if (!Buffer.isBuffer(binaryBuf) || binaryBuf.length < 16) {
    return [];
  }
  if (binaryBuf[0] === 0x7f && binaryBuf[1] === 0x45 && binaryBuf[2] === 0x4c && binaryBuf[3] === 0x46) {
    return extractElfOAuthClients(binaryBuf);
  }
  if (binaryBuf[0] === 0x4d && binaryBuf[1] === 0x5a) {
    return extractPeOAuthClients(binaryBuf);
  }
  return extractMachOOAuthClients(binaryBuf);
}
