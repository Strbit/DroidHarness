#!/usr/bin/env node
/**
 * fetch-runtime.mjs — 在 PC 上把 Termux 的 bionic Node 运行时解出来, 填进模块的 usr/.
 *
 * 为什么要在 PC 上做: 手机端不需要装 Termux, 也不需要有 ar/xz/zstd 这些工具.
 *   · .deb 是 ar 归档      -> 本脚本自己解析 (ar 格式很简单)
 *   · data.tar.zst         -> Node 24 的 zlib.zstdDecompressSync
 *   · data.tar.gz          -> zlib.gunzipSync
 *   · data.tar.xz          -> Node 不支持, 会明确报错并给出绕法
 *   · 内层 tar             -> 交给系统 tar (GNU tar 读 tar 没问题, 只是读不了 ar)
 *
 * 用法:
 *   node tools/fetch-runtime.mjs                          # 默认装到 ../module/usr
 *   node tools/fetch-runtime.mjs --with-koffi             # 顺便放 koffi 平台包, 让探针能测原生模块
 *   node tools/fetch-runtime.mjs --list                   # 只显示会下载什么
 *   node tools/fetch-runtime.mjs --debs <dir>             # 离线模式: 解一个目录里已有的 .deb
 *   node tools/fetch-runtime.mjs --arch aarch64 --repo <base>
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ─────────────────────────── 参数 ───────────────────────────
const argv = process.argv.slice(2);
function argValue(name, fallback) {
	const i = argv.indexOf(name);
	if (i === -1) return fallback;
	const v = argv[i + 1];
	if (v === undefined || v.startsWith('--')) return true;
	return v;
}
// OUT 是 "prefix 的父目录": 剥掉 data/data/com.termux/files 之后文件按 usr/... 落进去,
// 所以默认传模块根目录, 最终得到 module/usr/bin/node —— 正好是 customize.sh 期望的位置.
const OUT = path.resolve(argValue('--out', path.join(ROOT, 'module')));
const ARCH = argValue('--arch', 'aarch64');
const REPO = argValue('--repo', null);
const DEBS_DIR = argValue('--debs', null);
const LIST_ONLY = argv.includes('--list');
const WITH_KOFFI = argv.includes('--with-koffi');

/**
 * 把 deb 的文件名变成当前平台合法的缓存文件名。
 *
 * 为什么需要它
 * -----------
 * Debian 的 epoch 版本号形如 `1:3.6.3`, 会**原样**出现在索引的 `Filename` 里:
 *
 *   Filename: pool/main/o/openssl/openssl_1:3.6.3_aarch64.deb
 *
 * 而 Windows 不允许文件名里有 `:` —— 它被当成 NTFS **备用数据流 (ADS)** 分隔符。
 * 于是 `fs.writeFileSync('openssl_1:3.6.3_aarch64.deb', buf)` 不会报错,
 * 但数据写进了名为 `3.6.3_aarch64.deb` 的 ADS, **基础文件 `openssl_1` 保持 0 字节**。
 *
 * 这个失败是静默的, 而且 Node 自己按同一个路径读能读回来, 所以:
 *   · 在线模式解包是对的, 但大小校验读到基础文件的 0 ≠ 期望值 → **每次运行都重下**
 *   · 离线模式按 `*.deb` 列目录, 看到的是 `openssl_1` (无后缀) → **静默跳过**
 *     (实测漏掉 openssl 与 ca-certificates, 后果是 TLS 彻底坏掉)
 *
 * 所以缓存名要转义掉 Windows 的非法字符。非 Windows 平台保持原名。
 */
function safeCacheName(filename) {
	const base = path.basename(filename);
	if (process.platform !== 'win32') return base;
	return base.replace(/[:*?"<>|]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}
// 默认装这些:
//   nodejs      运行时
//   bash        安卓自带的是 mksh 而不是 bash, 而 agent 写的脚本通常是 bash
//   ripgrep     harness 的 grep / glob 工具要 rg
//   npm, pnpm   DSH 的插件管理器**写死了调用 pnpm** (execa("pnpm", ...)),
//               没有它 GUI 的"添加插件"和 `dsh plugin add` 都会失败
const ROOT_PKGS = String(argValue('--packages', 'nodejs,bash,ripgrep,npm,pnpm'))
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

const REPO_CANDIDATES = [
	'https://packages.termux.dev/apt/termux-main',
	'https://packages-cf.termux.dev/apt/termux-main',
];

// ─────────────────────────── 小工具 ───────────────────────────
const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
function die(msg) {
	console.error(`\n[致命] ${msg}\n`);
	process.exit(1);
}
function human(bytes) {
	if (bytes > 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
	if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
	return `${bytes} B`;
}

async function fetchBuffer(url, { redirects = 5 } = {}) {
	if (redirects < 0) throw new Error(`重定向过多: ${url}`);
	const res = await fetch(url, { redirect: 'manual' });
	if (res.status >= 300 && res.status < 400) {
		const loc = res.headers.get('location');
		if (!loc) throw new Error(`重定向但没有 location: ${url}`);
		return fetchBuffer(new URL(loc, url).href, { redirects: redirects - 1 });
	}
	if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
	return Buffer.from(await res.arrayBuffer());
}

async function tryFetch(urls, what) {
	const errors = [];
	for (const u of urls) {
		try {
			const buf = await fetchBuffer(u);
			log(`  ✓ ${what}: ${u} (${human(buf.length)})`);
			return { buf, url: u };
		} catch (err) {
			errors.push(`  ✗ ${u} — ${err.message}`);
		}
	}
	warn(`  ! 取不到 ${what}, 试过:`);
	for (const e of errors) warn(e);
	return null;
}

// ─────────────────────────── ar 解析 ───────────────────────────
/**
 * .deb 是 ar 归档. 格式: "!<arch>\n" + 每个成员 60 字节头 + 数据(偶数对齐).
 * 头部字段: name[16] mtime[12] uid[6] gid[6] mode[8] size[10] magic[2]
 */
function parseAr(buf) {
	if (buf.length < 8 || buf.toString('latin1', 0, 8) !== '!<arch>\n') {
		throw new Error('不是 ar 归档 (magic 不匹配)');
	}
	const members = [];
	let off = 8;
	while (off + 60 <= buf.length) {
		const hdr = buf.toString('latin1', off, off + 60);
		if (hdr.slice(58, 60) !== '`\n') break; // 头结束标记
		const rawName = hdr.slice(0, 16).trim();
		const size = parseInt(hdr.slice(48, 58).trim(), 10);
		if (!Number.isFinite(size) || size < 0) break;
		const dataStart = off + 60;
		const dataEnd = dataStart + size;
		if (dataEnd > buf.length) break;
		// GNU ar 用 "name/" 结尾; 长名字用 "//" 表, 这里用不到 (deb 成员名都很短)
		const name = rawName.replace(/\/+$/, '');
		if (name && name !== '//' && name !== '/') {
			members.push({ name, data: buf.subarray(dataStart, dataEnd) });
		}
		off = dataEnd + (size % 2); // 成员按 2 字节对齐
	}
	return members;
}

// ─────────── xz 解压: Node 的 zlib 没有 xz, 借外部工具 ───────────
// Termux 的 .deb 实测用的是 data.tar.xz (不是 zst), 所以这一条是必经之路.
let _xzTool;
function findXzTool() {
	if (_xzTool !== undefined) return _xzTool;

	// 1) 真的 xz 二进制
	const xzCandidates = [];
	if (process.env.XZ_BIN) xzCandidates.push(process.env.XZ_BIN);
	xzCandidates.push('xz');
	for (const exe of xzCandidates) {
		const r = spawnSync(exe, ['--version'], { encoding: 'utf8' });
		if (!r.error && r.status === 0) {
			_xzTool = {
				desc: `xz (${exe})`,
				run(inPath) {
					const r2 = spawnSync(exe, ['-dc', inPath], { maxBuffer: 1024 * 1024 * 1024 });
					if (r2.error) throw r2.error;
					if (r2.status !== 0) throw new Error(`xz 退出码 ${r2.status}`);
					return Buffer.from(r2.stdout);
				},
			};
			return _xzTool;
		}
	}

	// 2) Python 的 stdlib lzma —— Windows 上最可能现成的东西, 零安装
	const pyScript =
		'import sys,lzma;open(sys.argv[2],"wb").write(lzma.decompress(open(sys.argv[1],"rb").read()))';
	const pyCandidates = [
		['python', []],
		['python3', []],
		['py', ['-3']],
	];
	for (const [exe, prefix] of pyCandidates) {
		const probe = spawnSync(exe, [...prefix, '-c', 'import lzma'], { encoding: 'utf8' });
		if (probe.error || probe.status !== 0) continue;
		_xzTool = {
			desc: `Python lzma (${exe})`,
			run(inPath, outPath) {
				const r2 = spawnSync(exe, [...prefix, '-c', pyScript, inPath, outPath], { encoding: 'utf8' });
				if (r2.error) throw r2.error;
				if (r2.status !== 0) {
					const tail = (r2.stderr ?? '').trim().split('\n').pop();
					throw new Error(`Python lzma 退出码 ${r2.status}: ${tail}`);
				}
				return fs.readFileSync(outPath);
			},
		};
		return _xzTool;
	}

	_xzTool = null;
	return _xzTool;
}

function decompressXz(name, data) {
	const tool = findXzTool();
	if (!tool) {
		throw new Error(
			`成员 ${name} 是 xz 压缩, 而 Node 的 zlib 不支持 xz.\n` +
				`      需要以下任一: (a) PATH 里有 xz; (b) 设 XZ_BIN 指向 xz 可执行文件; ` +
				`(c) 装个 Python 3 (用它标准库里的 lzma).\n` +
				`      或者用 --debs 指向你自己解好的目录.`
		);
	}
	const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
	const inPath = path.join(os.tmpdir(), `dsh-xz-${stamp}.xz`);
	const outPath = path.join(os.tmpdir(), `dsh-xz-${stamp}.tar`);
	fs.writeFileSync(inPath, data);
	try {
		return tool.run(inPath, outPath);
	} finally {
		try {
			fs.unlinkSync(inPath);
		} catch {}
		try {
			fs.unlinkSync(outPath);
		} catch {}
	}
}

function decompressMember(name, data) {
	if (name.endsWith('.zst')) return zlib.zstdDecompressSync(data);
	if (name.endsWith('.gz')) return zlib.gunzipSync(data);
	if (name.endsWith('.bz2')) return zlib.bunzip2Sync(data);
	if (name.endsWith('.xz')) return decompressXz(name, data);
	if (name.endsWith('.tar')) return data;
	throw new Error(`不认识的压缩: ${name}`);
}

// ─────────── 纯 Node 的 tar 解包 ───────────
// 为什么不用系统 tar: Windows 上它有三个坑 ——
//   1. GNU tar 把 "C:\..." 的冒号当远程主机, 报 "Cannot connect to C: resolve failed"
//   2. Git 自带的 MSYS tar 会把参数里的反斜杠再转义一遍 (C\:\\Users\\...)
//   3. 非管理员/未开开发者模式时建不了符号链接
// tar 格式本身很简单 (512 字节头 + 数据块, 八进制长度), 自己解就一次消掉这三个坑,
// 而且符号链接可以明确地退化成"拷一份目标".

function tarNumber(buf, off, len) {
	// GNU base-256 扩展: 首字节最高位为 1
	if (buf[off] & 0x80) {
		let v = 0;
		for (let i = off + 1; i < off + len; i++) v = v * 256 + buf[i];
		return v;
	}
	const s = buf.toString('latin1', off, off + len).replace(/\0.*$/, '').trim();
	return s === '' ? 0 : parseInt(s, 8);
}

function tarString(buf, off, len) {
	return buf.toString('utf8', off, off + len).replace(/\0.*$/, '');
}

/** 拼路径并挡掉目录穿越. 返回 null 表示这个条目不该写. */
function safeJoin(destDir, rel) {
	const parts = rel.split('/').filter((p) => p !== '' && p !== '.');
	if (parts.length === 0) return null;
	if (parts.some((p) => p === '..')) return null;
	const normDest = path.resolve(destDir);
	const full = path.resolve(path.join(normDest, ...parts));
	if (full !== normDest && !full.startsWith(normDest + path.sep)) return null;
	return full;
}

const block = (n) => Math.ceil(n / 512) * 512;

/**
 * 解一个 tar buffer 到 destDir, 剥掉前 strip 层路径.
 * 符号链接先记下来, 主流程走完再统一处理 —— 因为链接目标可能在归档里排在它后面.
 */
function extractTarBuffer(buf, destDir, strip) {
	const stats = { files: 0, dirs: 0, links: 0, linkCopied: 0, linkFailed: 0, skipped: 0, bytes: 0, symlinks: [] };
	const pendingLinks = [];
	let off = 0;
	let pendingName = null;

	while (off + 512 <= buf.length) {
		const header = buf.subarray(off, off + 512);
		let allZero = true;
		for (let i = 0; i < 512; i++) {
			if (header[i] !== 0) {
				allZero = false;
				break;
			}
		}
		if (allZero) break; // 归档结束标记

		const name = tarString(header, 0, 100);
		const size = tarNumber(header, 124, 12);
		const typeflag = String.fromCharCode(header[156]) || '0';
		const linkname = tarString(header, 157, 100);
		const prefix = tarString(header, 345, 155);
		const dataStart = off + 512;
		const dataEnd = dataStart + size;
		const next = dataStart + block(size);

		let fullName = pendingName !== null ? pendingName : prefix ? `${prefix}/${name}` : name;
		pendingName = null;

		if (typeflag === 'L') {
			// GNU longname: 数据块里是下一个条目的完整路径
			pendingName = buf.toString('utf8', dataStart, dataEnd).replace(/\0.*$/, '');
			off = next;
			continue;
		}
		if (typeflag === 'x' || typeflag === 'g') {
			// PAX 扩展头: 从 "NN path=..." 里取真实路径
			const text = buf.toString('utf8', dataStart, dataEnd);
			const m = /^\d+ path=(.*)$/m.exec(text);
			if (m && typeflag === 'x') pendingName = m[1];
			off = next;
			continue;
		}

		let rel = fullName.replace(/^\.\//, '').replace(/\/+$/, '');
		if (strip > 0) rel = rel.split('/').slice(strip).join('/');

		if (!rel) {
			off = next;
			continue;
		}

		const target = safeJoin(destDir, rel);
		if (!target) {
			stats.skipped++;
			off = next;
			continue;
		}

		if (typeflag === '5') {
			fs.mkdirSync(target, { recursive: true });
			stats.dirs++;
		} else if (typeflag === '2') {
			// 符号链接不在这里建. 两个理由:
			//   1. Windows 上非管理员建不了符号链接
			//   2. Termux 的 libfoo.so -> libfoo.so.78.3 这种, 物化成副本会让
			//      zip 里出现几十 MB 的重复内容 (实测 libicudata 一个就浪费 66 MB)
			// 改成记进清单, 由 customize.sh 在手机上用 ln -s 重建.
			stats.symlinks.push({ rel, target: linkname });
		} else if (typeflag === '1') {
			stats.links++;
			pendingLinks.push({ target, linkname, rel, hard: true });
		} else if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			const data = buf.subarray(dataStart, dataEnd);
			fs.writeFileSync(target, data);
			stats.files++;
			stats.bytes += data.length;
		} else {
			stats.skipped++;
		}

		off = next;
	}

	// 第二遍: 只剩硬链接 (数量很少, 直接拷一份)
	for (const link of pendingLinks) {
		fs.mkdirSync(path.dirname(link.target), { recursive: true });
		try {
			const src = resolveLink(destDir, link);
			if (src && fs.existsSync(src) && fs.statSync(src).isFile()) {
				fs.copyFileSync(src, link.target);
				stats.linkCopied++;
			} else {
				stats.linkFailed++;
			}
		} catch {
			stats.linkFailed++;
		}
	}

	return stats;
}

/** 把一个链接条目解析成 destDir 下的实际路径. */
function resolveLink(destDir, link) {
	const raw = link.hard ? link.linkname : path.posix.join(path.posix.dirname(link.rel), link.linkname);
	if (raw.startsWith('/')) return null; // 指向系统绝对路径, 在 PC 上没有意义
	return safeJoin(destDir, path.posix.normalize(raw));
}

// ─────────── 裁剪: 只留运行时真正需要的东西 ───────────
// Termux 的包会带一堆开发用文件 (ICU 头文件、man 页、pkgconfig、cmake 配置),
// 在手机上一点用都没有. 实测能砍掉约三分之一体积.

const PRUNE_IN_PREFIX = [
	'include', // 头文件, 编译期才需要
	'share/man',
	'share/info',
	'share/icu',
	'share/aclocal',
	'lib/pkgconfig',
	'lib/cmake',
	'lib/icu',
	// ⚠️ 故意**不裁** share/doc.
	// Debian/Termux 的包把许可证文本放在 share/doc/<pkg>/copyright,
	// 裁掉它 = 随包分发第三方二进制却不附许可证, 那是违规的.
	// (曾经裁过, 是个真错误, 已改回.)
];

// 裁剪候选. 注意这些是"候选"而不是"要删的" —— 删之前必须扫一遍包里的代码,
// 确认没有任何 require/import 引用它.
//
// 教训: 曾把 koffi 的 src/ 当开发目录删掉, 结果 require('koffi') 直接 MODULE_NOT_FOUND.
// 它的 index.cjs 就是 `module.exports = require("./src/koffi/index.cjs")` —— src/ 是运行时必需的.
const PRUNE_CANDIDATES = [
	'doc',
	'docs',
	'test',
	'tests',
	'__tests__',
	'example',
	'examples',
	'benchmark',
	'benchmarks',
	'src',
	'vendor',
];
const PRUNE_FILES = ['CHANGELOG.md', 'HISTORY.md'];
const SCAN_EXT = /\.(js|cjs|mjs|json)$/i;

/**
 * 删掉一个路径 (目录或**文件**), 返回释放的字节数.
 *
 * ⚠️ 历史 bug: 这个函数原来无条件先 `fs.readdirSync(p)` 再 `fs.rmSync`。
 * 对**文件**调用时 readdirSync 抛 ENOTDIR, 被 catch 吞掉, 于是 rmSync 从没执行 ——
 * 静默地什么都没删, 还返回 0。
 *
 * 后果: `pruneRuntime` 里删 `.a` / `.la` 静态库那段一直没生效,
 * 而 `pruneShareDoc` 第一次写就踩了这个坑 (163 个文件一个没删, 省下 0 字节).
 *
 * 现在按 lstat 分派: 目录才递归统计, 文件直接取 size。
 */
function removeIfExists(p) {
	let st;
	try {
		st = fs.lstatSync(p);
	} catch {
		return 0;
	}
	let bytes = 0;
	try {
		if (st.isDirectory()) {
			const walk = (d) => {
				for (const e of fs.readdirSync(d, { withFileTypes: true })) {
					const full = path.join(d, e.name);
					if (e.isDirectory()) walk(full);
					else {
						try {
							bytes += fs.statSync(full).size;
						} catch {}
					}
				}
			};
			walk(p);
		} else {
			bytes = st.size;
		}
		fs.rmSync(p, { recursive: true, force: true });
	} catch {}
	return bytes;
}

/** 裁掉 Termux prefix 里的开发文件. 返回省下的字节数. */
function pruneRuntime(out) {
	const prefix = path.join(out, 'usr');
	let saved = 0;
	for (const rel of PRUNE_IN_PREFIX) {
		saved += removeIfExists(path.join(prefix, ...rel.split('/')));
	}
	// 静态库与 libtool 描述文件
	for (const dir of [path.join(prefix, 'lib'), path.join(prefix, 'lib64')]) {
		if (!fs.existsSync(dir)) continue;
		for (const f of fs.readdirSync(dir)) {
			if (f.endsWith('.a') || f.endsWith('.la')) saved += removeIfExists(path.join(dir, f));
		}
	}
	// share/doc: **只留许可证文本**, 删掉手册 / changelog / HTML 文档.
	//
	// 为什么不是整个删: 分发 GPL/LGPL 二进制时附许可证是**义务**, 不是礼貌.
	// 为什么不是整个留: 实测 share/doc 共 5.4 MiB, 其中只有 0.2 MiB 是许可证 ——
	//   剩下 5.2 MiB 是 bash 的 HTML 手册、pcre2 的文档、各家的 CHANGES.
	saved += pruneShareDoc(path.join(prefix, 'share', 'doc'));
	return saved;
}

/** share/doc 下只保留许可证类文件, 其余删掉. 返回省下的字节数. */
function pruneShareDoc(docDir) {
	if (!fs.existsSync(docDir)) return 0;
	let saved = 0;
	const isLicense = (n) => /^(copyright|licen[cs]e|copying|notice|authors)/i.test(n);
	const walk = (d) => {
		let entries;
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(d, e.name);
			if (e.isDirectory()) walk(full);
			else if (!isLicense(e.name)) saved += removeIfExists(full);
		}
	};
	walk(docDir);
	// 清掉因此变空的目录
	const pruneEmpty = (d) => {
		let entries;
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return true;
		}
		let empty = true;
		for (const e of entries) {
			const full = path.join(d, e.name);
			if (e.isDirectory()) {
				if (!pruneEmpty(full)) empty = false;
			} else empty = false;
		}
		if (empty && d !== docDir) {
			try {
				fs.rmdirSync(d);
			} catch {}
		}
		return empty;
	};
	pruneEmpty(docDir);
	return saved;
}

/** 收集包里的 JS/JSON 文件 (跳过嵌套 node_modules). */
function collectScanFiles(dir, out = []) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === 'node_modules') continue;
			collectScanFiles(full, out);
		} else if (SCAN_EXT.test(e.name)) {
			out.push(full);
		}
	}
	return out;
}

/** 包里有代码引用这个名字吗. 返回引用它的文件 (相对包根), 没有则 null. */
function findReference(dest, name) {
	const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	// 匹配 require("name…") / require('./name…') / from "name…" / import("name…")
	const re = new RegExp(`(?:require\\(|from\\s+|import\\()\\s*["'\`][./]*${esc}[/"'\`]`);
	for (const f of collectScanFiles(dest)) {
		let text;
		try {
			text = fs.readFileSync(f, 'utf8');
		} catch {
			continue;
		}
		if (re.test(text)) return path.relative(dest, f);
	}
	return null;
}

/**
 * 裁掉 npm 包里的开发文件.
 * 只删"没有任何代码引用"的目录 —— 按目录名猜会删掉运行时必需的东西 (见 PRUNE_CANDIDATES 的注释).
 */
function pruneNpmPackage(dest) {
	let saved = 0;
	const kept = [];
	for (const rel of PRUNE_CANDIDATES) {
		const target = path.join(dest, rel);
		if (!fs.existsSync(target)) continue;
		const ref = findReference(dest, rel);
		if (ref) {
			kept.push(`${rel} <- ${ref}`);
			continue;
		}
		saved += removeIfExists(target);
	}
	for (const rel of PRUNE_FILES) saved += removeIfExists(path.join(dest, rel));
	return { saved, kept };
}

// ─────────── 符号链接清单 ───────────
// PC 上不建链接 (建不了, 而且物化会让 zip 里塞进几十 MB 重复内容),
// 只记录 rel -> target, 由 customize.sh 在手机上用 ln -s 重建.
const SYMLINK_MANIFEST = [];
const MANIFEST_NAME = '.dsh-symlinks';

function writeSymlinkManifest(out) {
	const file = path.join(out, 'usr', MANIFEST_NAME);
	const prefix = path.join(out, 'usr');

	// 路径存成"相对 prefix"的形式 (去掉 usr/ 前缀):
	// 清单文件本身就在 usr/ 里, customize.sh 的 relink 也以 prefix 为根,
	// 带前缀会拼成 $PREFIX/usr/lib/... 多一层.
	const seen = new Map();
	for (const l of SYMLINK_MANIFEST) {
		const rel = l.rel.startsWith('usr/') ? l.rel.slice(4) : l.rel;
		seen.set(rel, l.target);
	}

	// 已被裁掉的目录里的链接要丢掉, 否则 relink 会把删掉的目录又建出来,
	// 里面挂一堆悬空链接 (实测 usr/share/doc/*、usr/lib/icu/* 会命中).
	const kept = [];
	for (const [rel, target] of seen) {
		const parent = path.dirname(path.join(prefix, ...rel.split('/')));
		if (fs.existsSync(parent)) kept.push(`${rel}\t${target}`);
	}

	if (kept.length === 0) {
		removeIfExists(file);
		return 0;
	}
	fs.writeFileSync(file, kept.join('\n') + '\n');
	return kept.length;
}

/** 扫一遍 tar 头, 找出 "usr" 在第几段 —— 用来决定剥几层.
 *  Termux 的包路径是 data/data/com.termux/files/usr/..., 所以答案是 4. */
function detectStripFromTar(buf) {
	const tally = new Map();
	let off = 0;
	let pendingName = null;
	while (off + 512 <= buf.length) {
		const header = buf.subarray(off, off + 512);
		let allZero = true;
		for (let i = 0; i < 512; i++) {
			if (header[i] !== 0) {
				allZero = false;
				break;
			}
		}
		if (allZero) break;

		const name = tarString(header, 0, 100);
		const size = tarNumber(header, 124, 12);
		const typeflag = String.fromCharCode(header[156]) || '0';
		const prefix = tarString(header, 345, 155);
		const dataStart = off + 512;
		const next = dataStart + block(size);

		const fullName = pendingName !== null ? pendingName : prefix ? `${prefix}/${name}` : name;
		pendingName = null;

		if (typeflag === 'L') {
			pendingName = buf.toString('utf8', dataStart, dataStart + size).replace(/\0.*$/, '');
			off = next;
			continue;
		}
		if (typeflag === 'x' || typeflag === 'g') {
			const m = /^\d+ path=(.*)$/m.exec(buf.toString('utf8', dataStart, dataStart + size));
			if (m && typeflag === 'x') pendingName = m[1];
			off = next;
			continue;
		}

		const i = fullName.replace(/^\.\//, '').split('/').indexOf('usr');
		if (i > 0) tally.set(i, (tally.get(i) ?? 0) + 1);
		off = next;
	}
	if (tally.size === 0) return 0;
	return [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * 解一个 .deb 到 dest.
 * dest 是 "prefix 的父目录" —— 剥掉 data/data/com.termux/files 之后, 文件按 usr/... 落进去,
 * 所以 dest 应当传模块根目录 (module/), 这样最终得到 module/usr/bin/node.
 */
function extractDeb(debPath, dest, label) {
	const buf = fs.readFileSync(debPath);
	const members = parseAr(buf);
	const dataMember = members.find((m) => m.name.startsWith('data.tar'));
	if (!dataMember) {
		throw new Error(`${label}: .deb 里没有 data.tar.* (成员: ${members.map((m) => m.name).join(', ')})`);
	}

	const tarBytes = decompressMember(dataMember.name, dataMember.data);
	const strip = detectStripFromTar(tarBytes);
	fs.mkdirSync(dest, { recursive: true });
	const stats = extractTarBuffer(tarBytes, dest, strip);
	for (const s of stats.symlinks) SYMLINK_MANIFEST.push(s);
	return { strip, ...stats };
}

// ─────────────────────────── 索引解析 ───────────────────────────
function parsePackagesIndex(text) {
	const stanzas = text.split(/\n\s*\n/);
	const byName = new Map();
	for (const st of stanzas) {
		const fields = {};
		let lastKey = null;
		for (const line of st.split('\n')) {
			if (/^\s/.test(line) && lastKey) {
				fields[lastKey] += ` ${line.trim()}`;
				continue;
			}
			const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
			if (!m) continue;
			fields[m[1]] = m[2];
			lastKey = m[1];
		}
		if (fields.Package) byName.set(fields.Package, fields);
	}
	return byName;
}

/** "libc++ (>= 1), foo | bar, baz:any" -> ["libc++", "foo", "baz"] */
function parseDepends(s) {
	if (!s) return [];
	return s
		.split(',')
		.map((part) => part.split('|')[0].trim()) // 取第一个可选分支
		.map((part) => part.replace(/\s*\(.*?\)\s*/g, '').trim()) // 去版本约束
		.map((part) => part.replace(/:.*$/, '').trim()) // 去 arch 限定
		.filter(Boolean);
}

// 这些包是 Termux app 专用的包装器. 在模块环境里不但没用, 还会 shadow 系统命令 ——
// termux-am 会往 $PREFIX/bin/am 放一个只跟 Termux app 通信的包装器, 而 $PREFIX/bin
// 在 PATH 里靠前, 于是我们的 am 调用会打到它而不是 /system/bin/am.
// termux-exec 还会改 exec 行为 (LD_PRELOAD).
const EXCLUDE_PKGS = new Set(['termux-am', 'termux-am-socket', 'termux-exec', 'termux-tools']);

function resolveClosure(index, roots, exclude = EXCLUDE_PKGS) {
	const seen = new Map(); // name -> fields
	const queue = [...roots];
	const missing = [];
	const skipped = [];
	while (queue.length) {
		const name = queue.shift();
		if (seen.has(name)) continue;
		if (exclude.has(name)) {
			skipped.push(name);
			continue;
		}
		const f = index.get(name);
		if (!f) {
			missing.push(name);
			continue;
		}
		seen.set(name, f);
		for (const d of parseDepends(f.Depends)) {
			if (!seen.has(d)) queue.push(d);
		}
	}
	return { closure: seen, missing, skipped };
}

// ─────────────────────────── npm 包 (给探针测原生模块) ───────────────────────────
async function fetchNpmPackage(name, version, dest) {
	const base = name.startsWith('@') ? name.split('/')[1] : name;
	const url = `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
	log(`  · npm ${name}@${version}`);
	const buf = await fetchBuffer(url);
	const tarBytes = zlib.gunzipSync(buf);
	fs.mkdirSync(dest, { recursive: true });
	// npm tarball 顶层统一是 package/, 剥掉
	const stats = extractTarBuffer(tarBytes, dest, 1);
	const prune = pruneNpmPackage(dest);
	if (!fs.existsSync(path.join(dest, 'package.json'))) {
		throw new Error(`解包 ${name} 后没有 package.json (写出 ${stats.files} 个文件)`);
	}
	return prune;
}

/**
 * koffi 的 index.cjs 就是 `module.exports = require("./src/koffi/index.cjs")`.
 * 所以 src/ 是运行时必需的 —— 布局坏了在 PC 上看不出来, 到设备上才炸.
 * 这里显式校验一次.
 */
function verifyKoffiLayout(koffiDir) {
	const entry = path.join(koffiDir, 'src', 'koffi', 'index.cjs');
	if (fs.existsSync(entry)) {
		log(`    ✓ koffi 加载器入口在位 (src/koffi/index.cjs)`);
	} else {
		warn(`    ✗ koffi 加载器入口缺失: src/koffi/index.cjs`);
		warn('      设备上 require("koffi") 会报 MODULE_NOT_FOUND');
	}
}

async function installKoffi() {
	log('\n=== 顺便安装 koffi 平台包 (让探针能测原生模块) ===');
	const dest = path.join(ROOT, 'module', 'node_modules');
	const meta = await tryFetch(['https://registry.npmjs.org/koffi/latest'], 'koffi 元数据');
	if (!meta) {
		warn('  取不到 npm 元数据, 跳过. 探针里 koffi 一项会显示"未安装".');
		return;
	}
	const json = JSON.parse(meta.buf.toString('utf8'));
	const version = json.version;
	const platformPkg = '@koromix/koffi-android-arm64';
	const platformVersion = json.optionalDependencies?.[platformPkg];
	if (!platformVersion) {
		warn(`  koffi ${version} 的 optionalDependencies 里没有 ${platformPkg}, 跳过`);
		return;
	}
	log(`  koffi ${version}, 平台包 ${platformPkg}@${platformVersion}`);
	const a = await fetchNpmPackage('koffi', version, path.join(dest, 'koffi'));
	const b = await fetchNpmPackage(platformPkg, platformVersion, path.join(dest, '@koromix', 'koffi-android-arm64'));
	for (const [label, prune] of [
		['koffi', a],
		['koffi-android-arm64', b],
	]) {
		log(`    裁剪 ${label}: 省 ${human(prune.saved)}`);
		for (const k of prune.kept) log(`      保留 ${k}  (有代码引用, 删了会坏)`);
	}
	verifyKoffiLayout(path.join(dest, 'koffi'));
	log(`  ✓ 已放到 ${dest}`);
}

// ─────────────────────────── 主流程 ───────────────────────────
async function main() {
	log('DSH Android Runtime Probe — 运行时获取');
	log('==========================================================');
	log(`输出目录: ${OUT}`);
	log(`目标架构: ${ARCH}`);
	log('');

	// 不需要任何外部解压工具: ar 解析与 tar 解包都是本脚本自己做的.

	if (DEBS_DIR) {
		// 离线模式
		const dir = path.resolve(DEBS_DIR);
		if (!fs.existsSync(dir)) die(`--debs 目录不存在: ${dir}`);
		const debs = fs.readdirSync(dir).filter((f) => f.endsWith('.deb'));
		if (debs.length === 0) die(`${dir} 里没有 .deb`);
		log(`离线模式: ${dir} 下找到 ${debs.length} 个 .deb`);
		let totalFiles = 0;
		let totalLinkFailed = 0;
		for (const f of debs) {
			const r = extractDeb(path.join(dir, f), OUT, f);
			totalFiles += r.files;
			totalLinkFailed += r.linkFailed;
			log(`  ✓ ${f} — ${r.files} 文件 / ${r.dirs} 目录 / ${r.linkCopied} 链接, 剥 ${r.strip} 层`);
		}
		log(`\n共 ${totalFiles} 个文件.`);
		if (totalLinkFailed > 0) warn(`有 ${totalLinkFailed} 个链接没能还原 (见下方说明).`);
		const savedOffline = pruneRuntime(OUT);
		log(`裁剪开发文件: 省下 ${human(savedOffline)}`);
		log('重写脚本 shebang:');
		rewriteShebangs(OUT);
		wrapPnpm(OUT);
		const nLinksOffline = writeSymlinkManifest(OUT);
		if (nLinksOffline > 0) log(`符号链接清单: ${nLinksOffline} 条 -> usr/${MANIFEST_NAME}`);
		verify(OUT);
		if (WITH_KOFFI) await installKoffi();
		return;
	}

	// 在线模式
	const repos = REPO ? [REPO] : REPO_CANDIDATES;
	const indexUrls = [];
	for (const r of repos) {
		indexUrls.push(`${r}/dists/stable/main/binary-${ARCH}/Packages`);
		indexUrls.push(`${r}/dists/stable/main/binary-${ARCH}/Packages.gz`);
	}

	log('=== 1/4 取包索引 ===');
	const idx = await tryFetch(indexUrls, 'Packages 索引');
	if (!idx) die('取不到 Termux 包索引. 检查网络, 或用 --repo 指定镜像, 或用 --debs 离线模式.');

	let indexText;
	if (idx.url.endsWith('.gz')) indexText = zlib.gunzipSync(idx.buf).toString('utf8');
	else indexText = idx.buf.toString('utf8');

	const index = parsePackagesIndex(indexText);
	log(`  索引里有 ${index.size} 个包`);
	const repoBase = idx.url.split('/dists/')[0];

	log('\n=== 2/4 解析依赖 ===');
	const { closure, missing, skipped } = resolveClosure(index, ROOT_PKGS);
	if (missing.length) warn(`  ! 索引里找不到: ${missing.join(', ')} (可能是 provides 的虚拟包, 通常无害)`);
	if (skipped.length) log(`  已排除 Termux app 专用包装器: ${skipped.join(', ')}`);
	const pkgs = [...closure.values()].sort((a, b) => a.Package.localeCompare(b.Package));
	let totalSize = 0;
	for (const f of pkgs) totalSize += parseInt(f.Size ?? '0', 10);
	log(`  需要 ${pkgs.length} 个包, 合计约 ${human(totalSize)}`);
	for (const f of pkgs) log(`    ${f.Package.padEnd(24)} ${String(f.Version).padEnd(18)} ${human(parseInt(f.Size ?? '0', 10))}`);

	if (LIST_ONLY) {
		log('\n--list 指定, 到此为止.');
		return;
	}

	log('\n=== 3/4 下载并解包 ===');
	const cacheDir = path.join(ROOT, '.cache', 'debs');
	fs.mkdirSync(cacheDir, { recursive: true });
	let totalFiles = 0;
	let totalLinkFailed = 0;
	for (const f of pkgs) {
		const url = `${repoBase}/${f.Filename}`;
		const local = path.join(cacheDir, safeCacheName(f.Filename));
		const expected = parseInt(f.Size ?? '0', 10);
		if (!fs.existsSync(local) || fs.statSync(local).length !== expected) {
			const buf = await fetchBuffer(url);
			fs.writeFileSync(local, buf);
			// 下完立刻核大小. 没有这道校验的话, "写进了 ADS 而基础文件是 0 字节"
			// 这种静默失败会一路带到解包 (见 safeCacheName 的注释).
			const got = fs.statSync(local).size;
			if (expected > 0 && got !== expected) {
				die(`下载后大小不符: ${path.basename(local)}\n  期望 ${expected} 字节, 实际 ${got} 字节\n  如果实际是 0, 多半是文件名里有平台非法字符 (Windows 的 ':')`);
			}
		}
		const r = extractDeb(local, OUT, f.Package);
		totalFiles += r.files;
		totalLinkFailed += r.linkFailed;
		log(
			`  ✓ ${f.Package.padEnd(24)} ${r.files} 文件 / ${r.dirs} 目录 / ${r.linkCopied} 链接, 剥 ${r.strip} 层`
		);
	}

	log('\n=== 4/4 裁剪与校验 ===');
	log(`共 ${totalFiles} 个文件.`);
	if (totalLinkFailed > 0) {
		warn('');
		warn(`! 有 ${totalLinkFailed} 个链接没能还原 (目标不在归档里, 或指向系统绝对路径).`);
		warn('  这些通常是 Termux 内部自指的链接, 影响很小.');
		warn('  但如果下面的 node 校验失败, 就是它. 绕法: 在 WSL/Linux 里跑这个脚本.');
		warn('');
	}
	const saved = pruneRuntime(OUT);
	log(`裁剪开发文件 (include / man / doc / pkgconfig / cmake): 省下 ${human(saved)}`);
	log('重写脚本 shebang:');
	rewriteShebangs(OUT);
	wrapPnpm(OUT);
	const nLinks = writeSymlinkManifest(OUT);
	if (nLinks > 0) log(`符号链接清单: ${nLinks} 条 -> usr/${MANIFEST_NAME} (手机上由 customize.sh 重建)`);
	verify(OUT);

	if (WITH_KOFFI) await installKoffi();

	log('\n完成. 下一步: 用 tools/build-module.ps1 打包, 然后刷进 KernelSU.');
}

/**
 * 模块最终会被挂到 `/data/adb/modules/<id>/`，而安装期间在 `modules_update/<id>/`。
 * 写进脚本的绝对路径必须是**最终**那个，否则重启后就断了。
 * id 从 out 目录里的 module.prop 读，避免写死。
 */
function moduleRuntimePrefix(out) {
	let id = 'dsh_android';
	try {
		const prop = fs.readFileSync(path.join(out, 'module.prop'), 'utf8');
		const m = /^id=(.+)$/m.exec(prop);
		if (m) id = m[1].trim();
	} catch {}
	return `/data/adb/modules/${id}/usr`;
}

/**
 * 重写脚本文件的 shebang。
 *
 * 问题
 * ----
 * Termux 的包里，**脚本**文件的 shebang 写死了 Termux 路径：
 *
 *     #!/data/data/com.termux/files/usr/bin/sh
 *
 * ELF 二进制不受影响（它们不读 shebang），所以之前只验证二进制"能跑"是不够的。
 * 脚本的表现是「文件明明在，却报 No such file or directory」—— execve 找不到解释器。
 *
 * 最阴的一例：`git-submodule` / `git-mergetool` 是 git 自带的 shell 脚本，
 * 在 `usr/libexec/git-core/` 下。git 找得到它们、但 execve 失败，于是**谎报**成：
 *
 *     git: 'submodule' is not a git command.
 *
 * 这个错误信息会把排查方向带偏到「git 装得不全」。实际影响：
 * `git clone --recurse-submodules` / `git submodule update` / `git mergetool` /
 * `git filter-branch` 全部不可用；`npm` / `npx` / `wcurl` / `curl-config` 也是
 * **加了但不能用**。
 *
 * 改法
 * ----
 *   sh / env sh  →  `#!/system/bin/sh`     Android 自带，不依赖模块挂载，最稳
 *   bash         →  `#!/data/adb/modules/<id>/usr/bin/bash`
 *   env node     →  `#!/data/adb/modules/<id>/usr/bin/node`
 *
 * **不动的**：`env python3` / `perl` / `python` —— 模块里没有这些解释器，
 * 重写 shebang 也跑不了（14 + 7 + 1 = 22 个）。这些功能由 README 标注为不支持。
 *
 * 只改**文本脚本**：先判前两字节是不是 `#!`（ELF 的首字节是 \x7f，天然排除）。
 */
function rewriteShebangs(out) {
	const prefix = path.join(out, 'usr');
	const runtime = moduleRuntimePrefix(out);
	const termux = '/data/data/com.termux/files/usr';

	// shebang 里的解释器路径 → 替换成什么
	const rules = [
		[`#!${termux}/bin/env sh`, '#!/system/bin/sh'],
		[`#!${termux}/bin/sh`, '#!/system/bin/sh'],
		[`#!${termux}/bin/env node`, `#!${runtime}/bin/node`],
		[`#!${termux}/bin/bash`, `#!${runtime}/bin/bash`],
	];

	const stats = new Map();
	const skipped = new Map();
	let scanned = 0;

	const walk = (dir) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				walk(full);
				continue;
			}
			// 只看小文件；真正的脚本不会很大（最大的是 npm 的 completion.sh）
			let st;
			try {
				st = fs.statSync(full);
			} catch {
				continue;
			}
			if (st.size > 512 * 1024) continue;
			scanned++;

			let buf;
			try {
				buf = fs.readFileSync(full);
			} catch {
				continue;
			}
			if (buf.length < 2 || buf[0] !== 0x23 || buf[1] !== 0x21) continue; // '#!'
			const nl = buf.indexOf(0x0a);
			const firstLine = buf.subarray(0, nl === -1 ? buf.length : nl).toString('utf8').replace(/\r$/, '');
			if (!firstLine.includes(termux)) continue;

			const rule = rules.find(([from]) => firstLine === from || firstLine.startsWith(from + ' '));
			if (!rule) {
				// python / perl / python3 —— 没有解释器，改了也没用
				const key = firstLine.replace(termux, 'TERMUX');
				skipped.set(key, (skipped.get(key) ?? 0) + 1);
				continue;
			}
			const [from, to] = rule;
			const rest = firstLine.slice(from.length);
			const newLine = to + rest;
			// 只换第一行，其余字节原样保留
			const out2 = Buffer.concat([Buffer.from(newLine, 'utf8'), nl === -1 ? Buffer.alloc(0) : buf.subarray(nl)]);
			try {
				fs.writeFileSync(full, out2, { mode: st.mode });
			} catch (err) {
				warn(`  ! 改不了 ${path.relative(out, full)}: ${err.message}`);
				continue;
			}
			const key = `${firstLine.replace(termux, 'TERMUX')}  →  ${newLine.split(' ')[0].replace(runtime, '<RUNTIME>')}`;
			stats.set(key, (stats.get(key) ?? 0) + 1);
		}
	};
	walk(prefix);

	let total = 0;
	for (const [k, n] of [...stats.entries()].sort((a, b) => b[1] - a[1])) {
		log(`  ✓ ${String(n).padStart(3)}  ${k}`);
		total += n;
	}
	for (const [k, n] of [...skipped.entries()].sort((a, b) => b[1] - a[1])) {
		log(`  · ${String(n).padStart(3)}  ${k}  (模块里没有该解释器, 不动)`);
	}
	log(`  扫描 ${scanned} 个文件, 重写 ${total} 个 shebang`);
	return total;
}

/**
 * 给 pnpm 包一层启动器，只改它自己的 HOME。
 *
 * 为什么
 * ------
 * pnpm 的 **store 操作锁目录**取自 `$HOME/.cache`，并要求它是「当前用户拥有的真实目录」。
 * 而本模块的 `HOME` 是 `/sdcard/DroidHarness`（有意为之：GUI 的工作区选择器从 HOME 起步），
 * 它属于 `u0_a257:media_rw`，而 DSH 进程是 root，于是：
 *
 *     ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK
 *       lock directory must be a real directory owned by the current user:
 *       /sdcard/DroidHarness/.cache/pnpm-store-operation-locks-0
 *
 * 实测 `npm_config_cache_dir` / `npm_config_store_dir` / `npm_config_state_dir` /
 * `XDG_CACHE_HOME` / `--cache-dir` / `--config.cacheDir` / `--store-dir` **全都挪不动它**
 * —— pnpm 根本不读那三个 `npm_config_*`。唯一有效的是给它一个单独的 `HOME`。
 *
 * 另外 store 必须和 profile 目录（`/data/adb/dsh/profiles/*`）在同一个真实文件系统上
 * （它靠硬链接把 store 里的文件链进 node_modules），而 `/sdcard` 是 FUSE，
 * **不支持硬链接** → `Cross-device link not permitted`。把 HOME 指到 `/data/adb/dsh`
 * 顺带把这条也解决了。
 *
 * 做法
 * ----
 *   `usr/bin/pnpm-bin`  ← 原来的 ELF 改名
 *   `usr/bin/pnpm`      ← `#!/system/bin/sh`，只 export HOME 再 exec pnpm-bin
 *
 * 这样是**自包含**的（不依赖模块外的文件），而且 `.dsh-symlinks` 里的
 * `bin/pnpx → pnpm` 仍然正确（指向包装脚本）。
 *
 * 注意本模块的 pnpm 是 **NDK 编的 Android ELF**，不读 shebang，所以不需要
 * 「`#!/usr/bin/env node` 在 Android 上不存在」那条绕法（那条只对 npm 上的
 * pnpm JS 包成立）。
 */
function wrapPnpm(out) {
	const prefix = path.join(out, 'usr');
	const binDir = path.join(prefix, 'bin');
	const pnpm = path.join(binDir, 'pnpm');
	const pnpmBin = path.join(binDir, 'pnpm-bin');

	if (!fs.existsSync(pnpm)) {
		log('  · 没有 usr/bin/pnpm, 跳过包装');
		return 0;
	}
	// 幂等: 已经包过就不重复
	if (fs.existsSync(pnpmBin)) {
		log('  · usr/bin/pnpm 已经包过, 跳过');
		return 0;
	}
	// 只包 ELF —— 如果 pnpm 本身是脚本, 说明包布局变了, 应该停下来看
	const head = fs.readFileSync(pnpm).subarray(0, 4);
	if (!(head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46)) {
		warn('  ! usr/bin/pnpm 不是 ELF, 与预期不符, 跳过包装');
		return 0;
	}

	fs.renameSync(pnpm, pnpmBin);
	const wrapper = [
		'#!/system/bin/sh',
		'# pnpm 启动器 —— 只给 pnpm 换一个 HOME, 不动 DSH 的 HOME。',
		'#',
		'# 为什么必须换 HOME (见 probe/tools/fetch-runtime.mjs 里 wrapPnpm 的注释):',
		'#   · pnpm 的 store 操作锁目录取自 $HOME/.cache, 且要求它是「当前用户拥有的真实目录」;',
		'#     而 DSH 的 HOME 是 /sdcard/DroidHarness (属于 u0_a257:media_rw, 进程是 root),',
		'#     于是报 ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK。',
		'#     实测 npm_config_cache_dir / XDG_CACHE_HOME / --cache-dir / --store-dir 全都挪不动它。',
		'#   · store 还必须和 profile 目录在同一个真实文件系统上 (它靠硬链接),',
		'#     而 /sdcard 是 FUSE, 不支持硬链接 → Cross-device link not permitted。',
		'#',
		'# 把 HOME 指到 /data/adb/dsh 同时解决这两条。',
		'',
		`DSH_HOME_DIR="\${DSH_HOME:-/data/adb/dsh}"`,
		'export HOME="$DSH_HOME_DIR"',
		'export PNPM_HOME="${PNPM_HOME:-$DSH_HOME_DIR/pnpm-home}"',
		'mkdir -p "$PNPM_HOME" "$DSH_HOME_DIR/tmp" 2>/dev/null',
		'export TMPDIR="${TMPDIR:-$DSH_HOME_DIR/tmp}"',
		'',
		'exec "${0%/*}/pnpm-bin" "$@"',
		'',
	].join('\n');
	fs.writeFileSync(pnpm, wrapper, { mode: 0o755 });
	log('  ✓ usr/bin/pnpm 已包启动器 (只改 HOME), 原 ELF 改名 pnpm-bin');
	return 1;
}

function verify(out) {
	const prefix = path.join(out, 'usr');
	const nodeBin = path.join(prefix, 'bin', 'node');
	log('');
	if (fs.existsSync(nodeBin)) {
		const st = fs.statSync(nodeBin);
		log(`✓ 找到 usr/bin/node — ${human(st.size)}`);
	} else {
		warn(`✗ 没有 ${nodeBin}`);
		warn('  可能原因: (1) 索引里没有 nodejs 包; (2) 需要手工指定 --packages; (3) 符号链接目标缺失');
	}
	const libDir = path.join(prefix, 'lib');
	if (fs.existsSync(libDir)) {
		const n = fs.readdirSync(libDir).filter((f) => f.includes('.so')).length;
		log(`✓ usr/lib/ 下有 ${n} 个共享库`);
	} else {
		warn('✗ 没有 usr/lib/ 目录');
	}
}

main().catch((err) => {
	console.error('\n[未捕获错误]', err);
	process.exit(1);
});
