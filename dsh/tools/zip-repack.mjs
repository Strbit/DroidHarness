// zip-repack.mjs — 可控压缩方式的 zip 读写(为 Android APK 打包用)
//
// 为什么需要它
// ────────────
// Android 11 (API 30) 起, 目标 SDK >= 30 的 APK 要求 `resources.arsc`
// **不压缩(stored)且 4 字节对齐**, 否则 pm install 直接失败:
//   Failure [-124: Failed parse during installPackageLI: Targeting R+ (version 30
//   and above) requires the resources.arsc of installed APKs to be stored
//   uncompressed and aligned on a 4-byte boundary]
// 而 JDK 的 `jar uf`(以及大多数 zip 工具)重写归档时会**把已有条目一并 deflate**,
// 于是 aapt2 原本 stored 的 resources.arsc 变成压缩态 → 装不上(实测踩到)。
//
// 这里自己读写 zip: 每个条目可以指定 stored 还是 deflate。只实现 APK 需要的
// 最小子集(不支持 zip64 / 加密 / 数据描述符), 足够我们这种几十 KB 的模块壳。
import fs from 'node:fs';
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

// CRC32 (自己实现, 不依赖 node 版本里的 zlib.crc32)
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('不是合法的 zip(找不到 EOCD)');
}

/** 读 zip → [{ name, data(已解压), method }] */
export function readZip(file) {
  const buf = fs.readFileSync(file);
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== CD_SIG) throw new Error(`中央目录损坏 @${off}`);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    if (buf.readUInt32LE(lho) !== LFH_SIG) throw new Error(`本地头损坏 @${lho}`);
    const lnlen = buf.readUInt16LE(lho + 26);
    const lelen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lnlen + lelen;
    const raw = buf.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式 ${method} (${name})`);
    out.push({ name, data, method });
    off += 46 + nlen + elen + clen;
  }
  return out;
}

/**
 * 写 zip。entries: [{ name, data }]。
 * storeNames: 这些条目用 stored(不压缩) —— APK 里 resources.arsc /
 * AndroidManifest.xml 必须走这条。
 */
export function writeZip(file, entries, storeNames = []) {
  const storeSet = new Set(storeNames);
  const parts = [];
  const cd = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const useStore = storeSet.has(e.name);
    const body = useStore ? data : zlib.deflateRawSync(data, { level: 9 });
    const method = useStore ? 0 : 8;
    const crc = crc32(data);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(LFH_SIG, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);            // flags: 无数据描述符
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);           // 时间/日期: 0(不关心)
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    parts.push(lfh, nameBuf, body);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(CD_SIG, 0);
    c.writeUInt16LE(20, 4);             // version made by
    c.writeUInt16LE(20, 6);             // version needed
    c.writeUInt16LE(0, 8);              // flags
    c.writeUInt16LE(method, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(0, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt16LE(0, 30);             // extra
    c.writeUInt16LE(0, 32);             // comment
    c.writeUInt16LE(0, 34);             // disk
    c.writeUInt16LE(0, 36);             // internal attrs
    c.writeUInt32LE(0, 38);             // external attrs
    c.writeUInt32LE(offset, 42);        // 本地头偏移
    cd.push(c, nameBuf);

    offset += lfh.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(cd);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  fs.writeFileSync(file, Buffer.concat([...parts, cdBuf, eocd]));
}
