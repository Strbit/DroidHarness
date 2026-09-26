#!/usr/bin/env node
/**
 * 把 module/ 打成可刷入 KernelSU / Magisk 的模块 zip。
 *
 * 为什么不用 PowerShell 版 (build-module.ps1)
 * -----------------------------------------
 * 那版功能是对的，但慢得离谱: 实测 28,074 个条目要 **300–360 秒**。
 * 时间几乎全花在 PowerShell 的逐文件开销上 (对象创建、流开关、.NET 互操作),
 * 而不是压缩 —— Deflate 本身能跑 20–50 MB/s, 那版只有约 1 MB/s。
 *
 * 而且它还多了一步完全不必要的 staging: 用 Copy-Item 把 350 MiB 再拷一遍。
 * 这里直接遍历模块目录算相对路径, 一次拷贝都不做。
 *
 * 为什么不用 Compress-Archive / bsdtar / 7z
 * ----------------------------------------
 * · Compress-Archive 在 Windows 上把条目名写成 `usr\bin\node` (反斜杠),
 *   而 ZIP 规范要求 `/`, Android 的解压器会解出一个名字里带反斜杠的文件。
 * · bsdtar 可以出 zip, 但没法可靠地写 Unix 模式位。
 * · 7z 没装。
 * 所以自己写 zip 字节 —— 这样分隔符、模式位、条目顺序都在我们手里。
 *
 * 为什么快
 * -------
 * · 无 staging 拷贝
 * · Node 的 zlib 是 C 实现
 * · 异步 deflateRaw 走 libuv 线程池 (默认 4 线程) → 白拿并行
 *
 * 用法
 * ----
 *   node probe/tools/pack-module.mjs --module dsh/module
 *   node probe/tools/pack-module.mjs --module dsh/module --out dsh/dist
 *   node probe/tools/pack-module.mjs --module dsh/module --level 6
 *   node probe/tools/pack-module.mjs --module dsh/module --skip-runtime
 *   node probe/tools/pack-module.mjs --module dsh/module --no-zip   # 只做检查
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ─────────────────────────── 参数 ───────────────────────────
const argv = process.argv.slice(2);
const argValue = (name, dflt) => {
	const i = argv.indexOf(name);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const MODULE_DIR = path.resolve(argValue('--module', 'probe/module'));
const SKIP_RUNTIME = argv.includes('--skip-runtime');
const NO_ZIP = argv.includes('--no-zip');
const LEVEL = Number(argValue('--level', '9'));
const OUT_DIR = argValue('--out', null) ? path.resolve(argValue('--out', '')) : path.join(path.dirname(MODULE_DIR), 'dist');

const log = (s = '') => process.stdout.write(s + '\n');
const die = (s) => {
	process.stderr.write(`\n! ${s}\n`);
	process.exit(1);
};

// ─────────────────────────── CRC-32 ───────────────────────────
// Node 22.2+ 有 zlib.crc32; 没有就退回自己算 (表驱动, 很快).
const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();
function crc32(buf) {
	if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
	let c = -1;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

// ─────────────────────────── DOS 时间 ───────────────────────────
function dosDateTime(date) {
	const y = Math.max(1980, date.getFullYear());
	return {
		time: ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff,
		date: (((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff,
	};
}

// ─────────────────────────── 主流程 ───────────────────────────
log('DSH Android Module — 打包 (Node 版)');
log('==========================================================');

if (!fs.existsSync(MODULE_DIR)) die(`模块目录不存在: ${MODULE_DIR}`);

// module.prop
const propPath = path.join(MODULE_DIR, 'module.prop');
if (!fs.existsSync(propPath)) die(`找不到 module.prop: ${propPath}`);
const prop = {};
for (const line of fs.readFileSync(propPath, 'utf8').split('\n')) {
	const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
	if (m) prop[m[1]] = m[2].trim();
}
const modId = prop.id;
const modVersion = prop.version;
if (!modId) die('module.prop 里没有 id');
if (!modVersion) die('module.prop 里没有 version');
log(`模块 id:      ${modId}`);
log(`模块版本:     ${modVersion}`);

// 运行时检查
const nodeBin = path.join(MODULE_DIR, 'usr', 'bin', 'node');
if (SKIP_RUNTIME) {
	log('运行时检查:   已跳过 (--skip-runtime)');
} else if (fs.existsSync(nodeBin)) {
	log(`运行时检查:   bin/node 存在 (${(fs.statSync(nodeBin).size / 1048576).toFixed(1)} MiB)`);
} else {
	die('usr/bin/node 不存在。先跑: node probe/tools/fetch-runtime.mjs --out dsh/module\n  只想验证结构的话加 --skip-runtime。');
}

// 遍历模块目录 —— **不做 staging 拷贝**, 直接算相对路径
log('');
log('正在扫描...');
const files = [];
const walk = (dir, relBase) => {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (e) {
		die(`读目录失败: ${dir} (${e.message})`);
	}
	for (const e of entries) {
		const full = path.join(dir, e.name);
		const rel = relBase ? `${relBase}/${e.name}` : e.name;
		if (e.isDirectory()) walk(full, rel);
		else if (e.isFile()) files.push({ full, rel });
		else if (e.isSymbolicLink()) {
			// 模块 zip 里不放符号链接 —— 手机端由 customize.sh 按 .dsh-symlinks 清单重建。
			// 真出现链接说明构建有问题, 直接报出来。
			die(`模块目录里有符号链接, 不该出现: ${rel} (PC 上建不出链接, 应该走 .dsh-symlinks 清单)`);
		}
	}
};
walk(MODULE_DIR, '');
files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

if (files.length > 65535) die(`${files.length} 个条目超过 ZIP 上限 65535, 需要 ZIP64 —— 本脚本不支持`);
log(`  ${files.length} 个文件`);

// module.prop 必须在根部
if (!files.some((f) => f.rel === 'module.prop')) die('module.prop 不在模块目录根部');

if (NO_ZIP) {
	log('');
	log('--no-zip 指定, 只做检查, 没有产出 zip。');
	process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const zipPath = path.join(OUT_DIR, `${modId}-v${modVersion}.zip`);
if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });

log('');
log(`正在压缩 (level ${LEVEL}, 异步 deflate 走 libuv 线程池)...`);
const t0 = Date.now();

const fd = fs.openSync(zipPath, 'w');
const central = []; // 每个条目的中央目录记录
let offset = 0;

/** 顺序写一块, 累加偏移。 */
function write(buf) {
	fs.writeSync(fd, buf, 0, buf.length, offset);
	offset += buf.length;
}

/**
 * 一个条目的本地头 + 压缩数据。
 * 返回 { crc, csize, usize, method }。
 */
async function compressOne(buf, level) {
	const deflated = await new Promise((res, rej) => {
		zlib.deflateRaw(buf, { level }, (e, out) => (e ? rej(e) : res(out)));
	});
	// 压缩反而变大就存原文 —— 小文件很常见
	if (deflated.length >= buf.length) return { data: buf, method: 0 };
	return { data: deflated, method: 8 };
}

const CONCURRENCY = 8;
let done = 0;
let pending = [];
const totalBytes = files.reduce((n, f) => n + fs.statSync(f.full).size, 0);
let readBytes = 0;

for (let i = 0; i < files.length; i++) {
	const f = files[i];
	const st = fs.statSync(f.full);
	const raw = fs.readFileSync(f.full);
	readBytes += raw.length;

	pending.push(
		compressOne(raw, LEVEL).then(({ data, method }) => ({ f, st, raw, data, method }))
	);

	// 维持并发窗口
	if (pending.length >= CONCURRENCY || i === files.length - 1) {
		const results = await Promise.all(pending);
		pending = [];
		for (const { f: file, st: stat, raw: rawBuf, data, method } of results) {
			const crc = crc32(rawBuf);
			const { time, date } = dosDateTime(stat.mtime);
			// Unix 模式位: usr/ 下的东西和 .sh 给 0755, 其余 0644。
			// (KernelSU/Magisk 解压时并不保留 zip 里的模式位 —— customize.sh 会 chmod。
			//  写进去只是为了别的解压工具看到合理值。)
			const isExec = file.rel.startsWith('usr/') || file.rel.endsWith('.sh');
			const mode = isExec ? 0o100755 : 0o100644;
			const nameBuf = Buffer.from(file.rel, 'utf8');

			// 本地文件头
			const lfh = Buffer.alloc(30);
			lfh.writeUInt32LE(0x04034b50, 0);
			lfh.writeUInt16LE(20, 4); // version needed
			lfh.writeUInt16LE(0x0800, 6); // bit 11 = 文件名是 UTF-8
			lfh.writeUInt16LE(method, 8);
			lfh.writeUInt16LE(time, 10);
			lfh.writeUInt16LE(date, 12);
			lfh.writeUInt32LE(crc, 14);
			lfh.writeUInt32LE(data.length, 18);
			lfh.writeUInt32LE(rawBuf.length, 22);
			lfh.writeUInt16LE(nameBuf.length, 26);
			lfh.writeUInt16LE(0, 28); // extra len

			const localOffset = offset;
			write(lfh);
			write(nameBuf);
			write(data);

			central.push({ nameBuf, crc, csize: data.length, usize: rawBuf.length, method, time, date, mode, localOffset });

			done++;
			if (done % 2000 === 0 || done === files.length) {
				const pct = ((done / files.length) * 100).toFixed(0);
				const mb = (readBytes / 1048576).toFixed(0);
				process.stdout.write(`\r  已写 ${done}/${files.length} (${pct}%)  ${mb} MiB`);
			}
		}
	}
}
process.stdout.write('\n');

// 中央目录
const cdStart = offset;
for (const e of central) {
	const cdh = Buffer.alloc(46);
	cdh.writeUInt32LE(0x02014b50, 0);
	cdh.writeUInt16LE(0x031e, 4); // version made by: Unix (3) << 8 | 30
	cdh.writeUInt16LE(20, 6); // version needed
	cdh.writeUInt16LE(0x0800, 8);
	cdh.writeUInt16LE(e.method, 10);
	cdh.writeUInt16LE(e.time, 12);
	cdh.writeUInt16LE(e.date, 14);
	cdh.writeUInt32LE(e.crc, 16);
	cdh.writeUInt32LE(e.csize, 20);
	cdh.writeUInt32LE(e.usize, 24);
	cdh.writeUInt16LE(e.nameBuf.length, 28);
	cdh.writeUInt16LE(0, 30); // extra
	cdh.writeUInt16LE(0, 32); // comment
	cdh.writeUInt16LE(0, 34); // disk
	cdh.writeUInt16LE(0, 36); // internal attrs
	cdh.writeUInt32LE((e.mode << 16) >>> 0, 38); // external attrs: 高 16 位是 Unix 模式
	cdh.writeUInt32LE(e.localOffset, 42);
	write(cdh);
	write(e.nameBuf);
}
const cdSize = offset - cdStart;

// EOCD
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(central.length, 8);
eocd.writeUInt16LE(central.length, 10);
eocd.writeUInt32LE(cdSize, 12);
eocd.writeUInt32LE(cdStart, 16);
eocd.writeUInt16LE(0, 20);
write(eocd);

fs.closeSync(fd);

const secs = ((Date.now() - t0) / 1000).toFixed(1);
const zipMiB = (fs.statSync(zipPath).size / 1048576).toFixed(1);
log('');
log('==========================================================');
log(`打包完成: ${zipPath}`);
log(`大小:     ${zipMiB} MiB`);
log(`耗时:     ${secs} 秒  (${files.length} 条目, 读入 ${(totalBytes / 1048576).toFixed(0)} MiB)`);
log('');
log('刷入方式:');
log('  1. 把 zip 传到手机');
log('  2. KernelSU 管理器 -> 模块 -> 从本地安装 -> 选这个 zip');
