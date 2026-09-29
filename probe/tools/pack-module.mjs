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
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ─────────────────────────── 参数 ───────────────────────────
const argv = process.argv.slice(2);
const argValue = (name, dflt) => {
	const i = argv.indexOf(name);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const MODULE_DIR = path.resolve(argValue('--module', 'probe/module'));
const SKIP_RUNTIME = argv.includes('--skip-runtime');
const NO_ZIP = argv.includes('--no-zip');
const NO_SCREEN_MCP = argv.includes('--no-screen-mcp');
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

// 屏幕识别 (recognize/ → tools/) 是否在包里。
// 这一条不是洁癖: PR #11 把 screen-mcp 合进 main 之后, 打包流水线里没有任何
// 一步带上它, 于是**刷了模块也看不见屏幕** —— 而 DSH 一切正常、日志干净,
// 症状只是工具列表少 4 项, 极易被当成"功能还没做"。装机的模块应当包含
// 仓库里声称已具备的能力。
// 这里 die 而不是 warn: 忘跑 stage-tools 是个必然被漏掉的失误, 打包时拦住
// 比装机后排查便宜得多。真要出无识别链路的包, 显式 --no-screen-mcp。
const SCREEN_TOOLS = ['tools/screen-mcp', 'tools/screen-mcp.mjs'];
const haveScreen = SCREEN_TOOLS.every((r) => files.some((f) => f.rel === r));
if (!haveScreen && !NO_SCREEN_MCP) {
	die(
		`模块里没有屏幕识别 (${SCREEN_TOOLS.filter((r) => !files.some((f) => f.rel === r)).join(', ')})\n` +
			'  先跑: node dsh/tools/stage-tools.mjs\n' +
			'  确实要出无识别链路的包: 加 --no-screen-mcp'
	);
}
if (haveScreen) {
	// 存在 ≠ 新鲜。上面那道只拦住"压根没暂存"；暂存过但源后来改了
	// （改了 recognize/ 忘了重跑 stage-tools）会带着旧代码打包成功。
	// 所以这里调用 stage-tools --check —— **复用而不是复制**: 五道门的规则
	// 只有 stage-tools 一份实现；复制过来的那份迟早和原作漂移，而漂移之后
	// 两边都会"绿灯"。代价约 1 秒，相对 13 秒打包可忽略。
	//
	// 只在打包目标正是 stage-tools 的写入点时跑：stage-tools 的 SRC/DEST 是
	// 按它自己文件位置硬推的，拿它校验别的 MODULE_DIR 会误报"陈旧"。
	const here = path.dirname(fileURLToPath(import.meta.url));
	const repoRoot = path.resolve(here, '..', '..');
	const stager = path.join(repoRoot, 'dsh', 'tools', 'stage-tools.mjs');
	const stagedDest = path.join(repoRoot, 'dsh', 'module', 'tools');
	const n = files.filter((f) => f.rel.startsWith('tools/')).length;
	if (NO_SCREEN_MCP) {
		log(`屏幕识别:     在包里 (tools/, ${n} 个文件) —— 但已按 --no-screen-mcp 跳过校验`);
	} else if (!fs.existsSync(stager)) {
		die(`找不到 stage-tools.mjs (试的是 ${stager})\n  打包门禁依赖它，不能静默放行`);
	} else if (MODULE_DIR !== path.dirname(stagedDest)) {
		log(`屏幕识别:     在包里 (tools/, ${n} 个文件)`);
		log('新鲜度检查: -- 跳过（--module 不是 dsh/module，stage-tools 校验的是后者）');
	} else {
		const chk = spawnSync(process.execPath, [stager, '--check'], { encoding: 'utf8' });
		if (chk.status !== 0) {
			// die() 写 stderr、逐项 ✓ 写 stdout。优先取 stderr, 才能让人第一眼
			// 看到"到底哪道门没过"；上一版把两路拼起来再 slice(-6)，结果是
			// 5 行 ✓ 顶着 1 行 [致命] —— 拒绝打包的理由被自己的进度输出埋掉。
			const errLines = (chk.stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
			const outLines = (chk.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('[致命]'));
			const why = (errLines.length ? errLines : outLines).slice(0, 6).map((l) => '  ' + l).join('\n');
			die(`tools/ 未通过 stage-tools --check，拒绝打包:\n${why || '  (stage-tools 没有输出原因，直接跑一次看)'}`);
		}
		log(`屏幕识别:     在包里 (tools/, ${n} 个文件) 且与 recognize/ 逐字节一致`);
	}
} else {
	log('屏幕识别:     -- 已按 --no-screen-mcp 排除');
}

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
// 用单调时钟, 不用 Date.now() —— 后者是墙钟, 会被系统对时/NTP 调整影响,
// 而各阶段计时用的是 hrtime。两者混用会给出互相矛盾的数字。
const t0 = process.hrtime.bigint();
const msSince = (t) => Number(process.hrtime.bigint() - t) / 1e6;

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

// 分阶段计时。打包耗时实测在 19~130 秒之间波动过 7 倍, 需要知道时间花在哪。
const T = { stat: 0, read: 0, await: 0, crc: 0, write: 0 };
const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

/**
 * 读 + 压缩串成**一条流水线**, 由 libuv 线程池并发执行。
 *
 * 为什么不用 `readFileSync`: 那会在**主线程**同步阻塞。
 * 实测 295 MiB / 14,207 次 open 要 8.6 秒 —— 而且这个数字**极不稳定**:
 * 单次 open 只要从 0.3ms 变成 7ms (杀软按访问扫描、或缓存失效),
 * 14,207 次就是 **100 秒**, 正好对上实测到的 118/128 秒那两次。
 *
 * 改成异步之后, 读和 deflate 都在线程池里排队, 主线程只做协调 ——
 * 读变慢时它会和压缩重叠, 而不是把整条流水线堵死。
 */
for (let i = 0; i < files.length; i++) {
	const f = files[i];
	let _t = nowMs();
	const st = fs.statSync(f.full);
	T.stat += nowMs() - _t;

	pending.push(
		(async () => {
			const _tr = nowMs();
			const raw = await readFile(f.full);
			const dt = nowMs() - _tr;
			T.read += dt; // 注意: 这是并发读的**累计**墙钟, 会大于总耗时, 只用来对比不同运行
			readBytes += raw.length;
			const { data, method } = await compressOne(raw, LEVEL);
			return { f, st, raw, data, method };
		})()
	);

	// 维持并发窗口
	if (pending.length >= CONCURRENCY || i === files.length - 1) {
		const _ta = nowMs();
		const results = await Promise.all(pending);
		T.await += nowMs() - _ta;
		pending = [];
		for (const { f: file, st: stat, raw: rawBuf, data, method } of results) {
			const _tc = nowMs();
			const crc = crc32(rawBuf);
			T.crc += nowMs() - _tc;
			const { time, date } = dosDateTime(stat.mtime);
			// Unix 模式位: usr/ 下的东西和 .sh 给 0755, 其余 0644。
			// (KernelSU/Magisk 解压时并不保留 zip 里的模式位 —— customize.sh 会 chmod。
			//  写进去只是为了别的解压工具看到合理值。)
			//
			// 但有几条**必须**自己就是可执行的例外 —— 它们不满足上面那两条规则,
			// 却真的会被 exec / spawn:
			//
			//   bin/                             模块的命令行入口 (dsh / dshctl)
			//                                    —— 没有 .sh 后缀
			//   app/.../ripgrep-android-arm64/   rg 垫片: bin/rg 是 wrapper,
			//                                    libexec/rg.real 是被 exec 的二进制
			//   tools/screen-mcp                 屏幕识别 MCP 的启动器, 同样无后缀
			//                                    (cordis.patch.yml 里 command 直接指它)
			//
			// 这三处不可执行的后果不是"权限不整洁", 而是功能在 spawn 时直接 EACCES
			// —— 而 rg 那处的报错会伪装成 "ripgrep launch failed"。
			// 虽然 customize.sh 会兜底 chmod, 但不该把正确性押在安装器上。
			const isExec =
				file.rel.startsWith('usr/') ||
				file.rel.endsWith('.sh') ||
				file.rel.startsWith('bin/') ||
				file.rel === 'tools/screen-mcp' ||
				file.rel.startsWith('app/node_modules/@vscode/ripgrep-android-arm64/');
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
			const _tw = nowMs();
			write(lfh);
			write(nameBuf);
			write(data);
			T.write += nowMs() - _tw;

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

const secs = (msSince(t0) / 1000).toFixed(1);
const zipMiB = (fs.statSync(zipPath).size / 1048576).toFixed(1);
log('');
log('==========================================================');
log(`打包完成: ${zipPath}`);
log(`大小:     ${zipMiB} MiB`);
log(`耗时:     ${secs} 秒  (${files.length} 条目, 读入 ${(totalBytes / 1048576).toFixed(0)} MiB)`);
log('');
// 分阶段拆解 —— 这五项加起来应该接近总耗时, 差额是扫描目录与收尾
const sumMs = T.stat + T.read + T.await + T.crc + T.write;
// ⚠️ 读文件与等压缩是**并发**的, 所以它们各自是"累计墙钟", 加起来会**大于**总耗时。
// 这不是 bug, 正是"它们在重叠执行"的证据 —— 反过来, 若两项之和≈总耗时,
// 说明读把主线程堵住了 (以前用 readFileSync 就是这样)。
log('分阶段耗时:');
log(`  stat()       ${(T.stat / 1000).toFixed(1).padStart(7)} s`);
log(`  读文件       ${(T.read / 1000).toFixed(1).padStart(7)} s`);
log(`  等压缩完成   ${(T.await / 1000).toFixed(1).padStart(7)} s   ← 含 deflate + 线程池争用`);
log(`  CRC32        ${(T.crc / 1000).toFixed(1).padStart(7)} s`);
log(`  写盘         ${(T.write / 1000).toFixed(1).padStart(7)} s`);
log(`  ─────────────────────`);
const overlap = sumMs / 1000 - Number(secs);
log(`  累计         ${(sumMs / 1000).toFixed(1).padStart(7)} s`);
log(`  总耗时       ${Number(secs).toFixed(1).padStart(7)} s`);
log(
	overlap > 1
		? `  重叠         ${overlap.toFixed(1).padStart(7)} s   <- 读与压缩并发执行的量 (越大越好)`
		: `  重叠         ${overlap.toFixed(1).padStart(7)} s   <- 几乎没重叠: 读把主线程堵住了`
);
log(`  线程池       ${process.env.UV_THREADPOOL_SIZE ?? '4'} (默认 4; 实测调大到 16 反而更慢)`);
log('');
log(`  压缩比: ${(totalBytes / 1048576).toFixed(0)} MiB → ${zipMiB} MiB  (${((zipMiB * 1048576 / totalBytes) * 100).toFixed(0)}%)`);
log('');
log('刷入方式:');
log('  1. 把 zip 传到手机');
log('  2. KernelSU 管理器 -> 模块 -> 从本地安装 -> 选这个 zip');
