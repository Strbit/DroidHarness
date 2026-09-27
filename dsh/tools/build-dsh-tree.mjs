#!/usr/bin/env node
/**
 * build-dsh-tree.mjs — 在 PC 上构建给 Android 用的 DSH 应用树, 并打上必要的补丁.
 *
 * 直接装进 `dsh/module/app`, 不做二次拷贝 (那棵树有 220+ MiB / 两万多个文件).
 *
 * 两个关键点, 都是踩过的:
 *
 *   1. `--ignore-scripts`
 *      安装脚本在 HOST (Windows) 上跑, 但包是给 TARGET (android) 装的.
 *      koffi 的 install 脚本加载不了 android 的 .node, 会回退到从源码编译,
 *      然后因为没有 CMake 而失败. 跳过脚本即可 —— 平台预编译包已经由
 *      `--os=android --cpu=arm64` 装好了.
 *
 *   2. 绝不能用 `--omit=optional`
 *      koffi 的平台预编译包正是 optionalDependencies, 省掉它就等于把 koffi 废掉.
 *
 * 用法:
 *   node dsh/tools/build-dsh-tree.mjs                  # 装 + 打补丁 + 校验
 *   node dsh/tools/build-dsh-tree.mjs --skip-install   # 只打补丁 + 校验 (树已存在)
 *   node dsh/tools/build-dsh-tree.mjs --version 0.1.7-rc.2
 *
 *   node dsh/tools/build-dsh-tree.mjs --skip-install --prune --dry-run
 *       只分析能裁掉什么, 打印清单, 不删任何东西
 *   node dsh/tools/build-dsh-tree.mjs --skip-install --prune
 *       真删
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..'); // 仓库根
const APP = path.join(ROOT, 'dsh', 'module', 'app');
const SHIM_SRC = path.join(ROOT, 'dsh', 'shim', 'node-addon-require-builtin.js');

const argv = process.argv.slice(2);
const SKIP_INSTALL = argv.includes('--skip-install');
const DO_PRUNE = argv.includes('--prune');
const DRY_RUN = argv.includes('--dry-run');
function argValue(name, fallback) {
	const i = argv.indexOf(name);
	if (i === -1) return fallback;
	const v = argv[i + 1];
	return v === undefined || v.startsWith('--') ? true : v;
}
// 与用户当前 PC 上跑的一致. 注意 npm 的 latest 反而更旧, 这个是 next 标签.
const DSH_VERSION = argValue('--version', '0.1.7-rc.2');
const DSH_PKG = `@deepseek-ai/dsh@${DSH_VERSION}`;

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
function die(msg) {
	console.error(`\n[致命] ${msg}\n`);
	process.exit(1);
}
function human(bytes) {
	return bytes > 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(0)} KiB`;
}
function dirSize(dir) {
	let bytes = 0;
	let files = 0;
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
			else {
				try {
					bytes += fs.statSync(full).size;
					files++;
				} catch {}
			}
		}
	};
	walk(dir);
	return { bytes, files };
}

// ─────────────────────────── 1. 安装 ───────────────────────────
if (!SKIP_INSTALL) {
	log(`安装 ${DSH_PKG}  (target: android/arm64)`);
	log(`目标目录: ${APP}`);
	log('');

	if (fs.existsSync(APP)) {
		log('  已存在旧树, 先删除...');
		fs.rmSync(APP, { recursive: true, force: true });
	}
	fs.mkdirSync(APP, { recursive: true });
	fs.writeFileSync(
		path.join(APP, 'package.json'),
		JSON.stringify({ name: 'dsh-android-app', version: '1.0.0', private: true }, null, 2) + '\n'
	);

	const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
	const args = [
		'install',
		'--os=android',
		'--cpu=arm64',
		'--ignore-scripts',
		'--no-audit',
		'--no-fund',
		DSH_PKG,
	];
	log(`  $ ${npm} ${args.join(' ')}`);
	const r = spawnSync(npm, args, { cwd: APP, stdio: 'inherit', shell: process.platform === 'win32' });
	if (r.error) die(`npm 启动失败: ${r.error.message}`);
	if (r.status !== 0) die(`npm install 退出码 ${r.status}`);
	log('');
}

if (!fs.existsSync(path.join(APP, 'node_modules'))) {
	die(`找不到 ${path.join(APP, 'node_modules')} —— 先不带 --skip-install 跑一次`);
}

// ─────────────────────────── 2. 打补丁 ───────────────────────────
//
// 每个 shim 一条. 全部是同一个根因: **原包带的原生模块没有 android 变体**.
// 各 shim 文件顶部写清了"为什么可以降级", 以及降级丢掉了什么.
log('=== 打补丁 ===');

const SHIMS = [
	{
		label: 'node-addon-require-builtin',
		src: SHIM_SRC,
		pkg: 'node-addon-require-builtin',
		target: ['lib', 'index.js'],
		expectMain: 'lib/index.js',
		why: '平台专用原生加载器没有 android 变体',
	},
	{
		label: 'node-addon-system/flock',
		src: path.join(ROOT, 'dsh', 'shim', 'node-addon-system-flock.js'),
		pkg: path.join('@deepseek-ai', 'node-addon-system'),
		target: ['lib', 'flock.js'],
		// 这个包走 exports 映射, 没有 main 字段 —— 只校验落点, 不校验 main
		expectMain: null,
		why: 'flock 原生模块没有 android 变体; 单进程部署下上游自己也这么做',
	},
];

const shimTargets = [];
for (const s of SHIMS) {
	const pkgDir = path.join(APP, 'node_modules', s.pkg);
	if (!fs.existsSync(pkgDir)) die(`找不到 ${pkgDir} —— 这棵树不完整`);
	if (!fs.existsSync(s.src)) die(`找不到 shim 源文件: ${s.src}`);

	const target = path.join(pkgDir, ...s.target);
	// 先确认落点没变, 免得版本升级后换了路径而我们静默没打上.
	if (!fs.existsSync(target)) {
		warn(`! 落点不存在: ${path.relative(APP, target)}`);
		die(`shim 落点不匹配 (${s.label}), 拒绝继续`);
	}
	if (s.expectMain !== null) {
		const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
		const mainField = pj.main ?? 'index.js';
		if (mainField !== s.expectMain) {
			warn(`! 原包 main 变成了 "${mainField}", 与 shim 假设的 ${s.expectMain} 不一致`);
			die(`shim 落点不匹配 (${s.label}), 拒绝继续`);
		}
	}

	fs.copyFileSync(s.src, target);
	log(`  ✓ ${s.label}: 已用 JS 替身覆盖 ${path.relative(APP, target)}`);

	// 顺手清掉装不上的平台 optionalDependencies —— 留着只会让 npm ls 报 unmet.
	const pjPath = path.join(pkgDir, 'package.json');
	const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
	if (pj.optionalDependencies && Object.keys(pj.optionalDependencies).length > 0) {
		pj.optionalDependencies = {};
		pj.description = `JS shim (Android): ${s.why}`;
		fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n');
		log(`  ✓ ${s.label}: 已清掉 optionalDependencies`);
	}
	shimTargets.push(target);
}

// ─────────────────── 2b. 针对第三方库内部逻辑的文本补丁 ───────────────────
//
// 与 shim 的区别: shim 是**整文件替换**(顶替一个在 Android 上装不上的原生模块),
// 这里是**改上游源码里的几行**。所以每条都必须有锚点校验 —— 找不到锚点就 die,
// 不能静默跳过(否则 DSH 升级后补丁悄悄失效, 而症状只在真机上才暴露)。

/** 给 dsh-fs-local 的 writeFileAtomic 加 FUSE 降级。 */
const LINK_FALLBACK_HELPER = `/**
 * [Android 补丁] link() 的 FUSE 降级版。
 *
 * 上游用 link() 给「创建新文件」拿 no-replace 语义(目标已存在则 EEXIST)。
 * 但 Android 的 /sdcard 是 FUSE, **不实现 link()**, 于是新建文件直接报:
 *
 *   ENOSYS: function not implemented, link
 *
 * 而默认工作区就在 /sdcard 上 —— agent 因此无法新建任何文件, 只能改已存在的
 * (覆盖走 rename(), 那个 FUSE 支持)。
 *
 * 降级成 copyFile + COPYFILE_EXCL: 同样是「目标已存在就 EEXIST」的原子语义,
 * 不需要硬链接, 代价是多一次拷贝。
 *
 * **注意不能降级成 rename()** —— 那会丢掉 no-replace 语义, 两个并发创建者会
 * 互相覆盖, 而调用方的 throwGuardedCreateFailure 那套守卫就是为它写的。
 */
async function linkOrCopyExcl(from, to) {
	try {
		await link(from, to);
		return;
	} catch (error) {
		const code = error?.code;
		// 只有「这个文件系统不支持硬链接」才降级; EEXIST 等语义错误必须原样抛出
		if (code !== "ENOSYS" && code !== "EOPNOTSUPP" && code !== "EXDEV" && code !== "EPERM") throw error;
	}
	await copyFile(from, to, fsConstants.COPYFILE_EXCL);
}
`;

const TEXT_PATCHES = [
	{
		label: 'dsh-fs-local: writeFileAtomic 在 FUSE 上把 link() 降级成 copyFile',
		file: ['@deepseek-ai', 'dsh-fs-local', 'lib', 'index.js'],
		edits: [
			{
				// 上游没 import copyFile, 而 constants 是从 node:buffer 来的(另一个东西),
				// 所以两个都要补, 且 constants 要起别名避免撞名。
				find: 'import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";',
				replace:
					'import { chmod, constants as fsConstants, copyFile, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";',
			},
			{
				find: 'async function writeFileAtomic(absolutePath, content, mode, signal, internals = {}, createIfAbsent) {',
				replace: `${LINK_FALLBACK_HELPER}async function writeFileAtomic(absolutePath, content, mode, signal, internals = {}, createIfAbsent) {`,
			},
			{
				find: '\tconst linkFile = internals.linkFile ?? link;',
				replace: '\tconst linkFile = internals.linkFile ?? linkOrCopyExcl;',
			},
		],
	},
];

log('');
log('=== 文本补丁 (改上游内部逻辑) ===');
for (const p of TEXT_PATCHES) {
	const target = path.join(APP, 'node_modules', ...p.file);
	if (!fs.existsSync(target)) die(`找不到补丁目标: ${path.relative(APP, target)}`);
	let text = fs.readFileSync(target, 'utf8');
	// 幂等: 所有 replace 都已经在了 = 补丁过了。否则重跑会找不到锚点而 die。
	if (p.edits.every((e) => text.includes(e.replace))) {
		log(`  · ${p.label} (已经打过, 跳过)`);
		continue;
	}
	let applied = 0;
	for (const [i, e] of p.edits.entries()) {
		const count = text.split(e.find).length - 1;
		if (count === 0) {
			warn(`  ! ${p.label}: 第 ${i + 1} 个锚点找不到 —— 上游可能改过了`);
			warn(`      锚点: ${e.find.slice(0, 90)}${e.find.length > 90 ? '…' : ''}`);
			die('补丁锚点不匹配, 拒绝继续 (宁可失败, 也不要静默失效)');
		}
		if (count > 1) {
			warn(`  ! ${p.label}: 第 ${i + 1} 个锚点出现 ${count} 次, 无法确定改哪个`);
			die('补丁锚点不唯一, 拒绝继续');
		}
		text = text.replace(e.find, e.replace);
		applied++;
	}
	fs.writeFileSync(target, text);
	log(`  ✓ ${p.label} (${applied} 处)`);
}

// ─────────────────────────── 3. 校验 ───────────────────────────
log('\n=== 校验 ===');

const nodeBin = process.env.NODE_BIN ?? 'node';
const checks = [
	['koffi 平台预编译包', path.join(APP, 'node_modules', '@koromix', 'koffi-android-arm64', 'android_arm64', 'koffi.node')],
	['koffi 加载器入口', path.join(APP, 'node_modules', 'koffi', 'src', 'koffi', 'index.cjs')],
	['DSH 入口', path.join(APP, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')],
	...shimTargets.map((t) => [`shim 落点 (${path.relative(APP, t)})`, t]),
];
let bad = 0;
for (const [label, p] of checks) {
	if (fs.existsSync(p)) {
		log(`  ✓ ${label}`);
	} else {
		warn(`  ✗ ${label} 缺失: ${path.relative(APP, p)}`);
		bad++;
	}
}

// 真正跑一次 shim —— 这是唯一能证明"dsh-app-boot 那处无保护的 require 能过"的方法.
// 注意: 这里测的是 shim 的逻辑 (require internal 模块), 在 Windows 上同样成立.
const smoke = spawnSync(
	nodeBin,
	[
		'--expose-internals',
		'-e',
		'const a=require("node-addon-require-builtin");const m=a.requireBuiltin("internal/modules/esm/loader");console.log("shim-ok",typeof m,typeof m.getOrInitializeCascadedLoader);',
	],
	{ cwd: APP, encoding: 'utf8' }
);
const smokeOut = ((smoke.stdout ?? '') + (smoke.stderr ?? '')).trim();
if (/shim-ok object function/.test(smokeOut)) {
	log(`  ✓ shim 实测通过: ${smokeOut}`);
} else {
	warn(`  ✗ shim 实测失败: ${smokeOut}`);
	bad++;
}

// 反面验证: 不带 --expose-internals 时应当给出可读的错误, 而不是冒 ERR_UNKNOWN_BUILTIN_MODULE
const negative = spawnSync(
	nodeBin,
	['-e', 'try{require("node-addon-require-builtin").requireBuiltin("internal/modules/esm/loader")}catch(e){console.log("neg:",e.message.slice(0,60))}'],
	{ cwd: APP, encoding: 'utf8' }
);
log(`  · 不带旗标时: ${((negative.stdout ?? '') + (negative.stderr ?? '')).trim()}`);

// dsh-fs-local 的文本补丁: 至少要能 import 成功 —— 补丁写坏了语法/import 会在这里暴露,
// 而不是等到真机上 agent 想写文件时才发现.
const fsLocalSmoke = spawnSync(
	nodeBin,
	['--input-type=module', '-e', "await import('@deepseek-ai/dsh-fs-local'); console.log('fslocal-ok');"],
	{ cwd: APP, encoding: 'utf8' }
);
const fsLocalOut = ((fsLocalSmoke.stdout ?? '') + (fsLocalSmoke.stderr ?? '')).trim();
if (/fslocal-ok/.test(fsLocalOut)) {
	log('  ✓ dsh-fs-local 补丁后仍能 import');
} else {
	warn(`  ✗ dsh-fs-local import 失败: ${fsLocalOut.slice(0, 300)}`);
	bad++;
}

// 降级路径的语义: copyFile + COPYFILE_EXCL 必须是「目标已存在就 EEXIST」.
// 这是 no-replace 语义的替代品, 语义错了会让两个并发创建者互相覆盖.
const copyExclSmoke = spawnSync(
	nodeBin,
	[
		'--input-type=module',
		'-e',
		[
			"import { copyFile, constants, writeFile, rm } from 'node:fs/promises';",
			"const a = '.__copyexcl_a', b = '.__copyexcl_b';",
			"await writeFile(a, 'x');",
			'await copyFile(a, b, constants.COPYFILE_EXCL);',
			'let eexist = false;',
			'try { await copyFile(a, b, constants.COPYFILE_EXCL); } catch (e) { eexist = e.code === "EEXIST"; }',
			'await rm(a, { force: true }); await rm(b, { force: true });',
			"console.log('copyexcl-ok', eexist);",
		].join(' '),
	],
	{ cwd: APP, encoding: 'utf8' }
);
const copyExclOut = ((copyExclSmoke.stdout ?? '') + (copyExclSmoke.stderr ?? '')).trim();
if (/copyexcl-ok true/.test(copyExclOut)) {
	log('  ✓ copyFile+COPYFILE_EXCL 的 no-replace 语义正确 (已存在 -> EEXIST)');
} else {
	warn(`  ✗ copyFile+COPYFILE_EXCL 语义不对: ${copyExclOut.slice(0, 200)}`);
	bad++;
}

// flock shim 实测: 真开一个文件拿 fd, 走一遍 tryLockExclusive.
// 这是唯一能证明"会话写入路径不会在 Android 上抛 unsupported platform"的方法.
// (该 shim 是 ESM, 所以用 --input-type=module.)
const flockSmoke = spawnSync(
	nodeBin,
	[
		'--input-type=module',
		'-e',
		[
			"import { open, rm } from 'node:fs/promises';",
			"import { tryLockExclusive, FLOCK_IMPLEMENTATION } from '@deepseek-ai/node-addon-system/flock';",
			"const p = '.__flock_smoke.lock';",
			"const h = await open(p, 'w');",
			'await tryLockExclusive(h.fd);',
			'await h.close();',
			'await rm(p, { force: true });',
			"console.log('flock-shim-ok', FLOCK_IMPLEMENTATION);",
		].join(' '),
	],
	{ cwd: APP, encoding: 'utf8' }
);
const flockOut = ((flockSmoke.stdout ?? '') + (flockSmoke.stderr ?? '')).trim();
if (/flock-shim-ok js-shim-single-process/.test(flockOut)) {
	log(`  ✓ flock shim 实测通过: ${flockOut}`);
} else {
	warn(`  ✗ flock shim 实测失败: ${flockOut}`);
	bad++;
}

// ─────────────────────────── 4. 裁剪 ───────────────────────────
// 设计原则: 只删"能证明没人引用"的东西.
//
// 教训: 曾经按目录名把 koffi 的 src/ 当开发目录删掉, 结果 require('koffi') 直接
// MODULE_NOT_FOUND —— 它的 index.cjs 就是 require("./src/koffi/index.cjs").
// 所以这里分三档, 而且都要过一遍引用扫描:
//
//   扩展名档  这些后缀在运行期从不被代码加载 (.map / .pdb), 或只被 package.json
//             的 types 字段引用而 Node 不读 (.d.ts)
//   目录档    test / docs 之类
//   平台档    明确属于别的操作系统的产物
//
// **不碰 src/**: DSH 的包在 exports 里声明了 "./src/*", 那是可达路径.

const PRUNE_BY_EXT = [
	['.map', 'source map, 只被 //# sourceMappingURL 注释引用'],
	['.pdb', 'Windows 调试符号, 只有 Windows 链接器用'],
	['.d.ts', '类型声明, Node 运行期从不加载'],
	['.md', '文档'],
];
const PRUNE_BY_DIR = ['test', 'tests', '__tests__', 'spec', 'docs', 'doc', 'example', 'examples', 'benchmark', 'benchmarks'];
const PRUNE_BY_PLATFORM = [
	'node-pty/prebuilds/win32-x64',
	'node-pty/prebuilds/win32-arm64',
	'node-pty/prebuilds/darwin-x64',
	'node-pty/prebuilds/darwin-arm64',
	'node-pty/third_party/conpty',
	'node-pty/src/win',
];

/** 扫一遍全树的 JS, 收集所有 require/import 的目标, 用来判断"有没有人引用". */
function buildSpecifiers(root) {
	const out = [];
	const re = /(?:require\(|from\s+|import\()\s*["'`]([^"'`]+)["'`]/g;
	const walk = (d) => {
		let entries;
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(d, e.name);
			if (e.isDirectory()) {
				walk(full);
				continue;
			}
			if (!/\.(js|cjs|mjs)$/i.test(e.name)) continue;
			let text;
			try {
				text = fs.readFileSync(full, 'utf8');
			} catch {
				continue;
			}
			// 先去掉块注释. 有些包 (例如 undici) 用 JSDoc 做类型标注:
			//   /** @typedef {import('../../types/x.d.ts').default.Foo} Foo */
			// 那是注释, 运行期从不加载, 但正则会把里面的 import(...) 当成真引用 ——
			// 结果整个 .d.ts 档 (33 MiB) 被误判成"被引用".
			text = text.replace(/\/\*[\s\S]*?\*\//g, ' ');
			let m;
			while ((m = re.exec(text)) !== null) out.push(m[1]);
		}
	};
	walk(root);
	return new Set(out);
}

function analyzePrune(root) {
	log('  扫描全树的 require/import 目标 (要读约 9000 个 JS)...');
	const specs = buildSpecifiers(root);
	log(`  收集到 ${specs.size} 个不同的引用目标`);

	const buckets = new Map();
	const bucket = (key, label, note) => {
		if (!buckets.has(key)) buckets.set(key, { key, label, note, files: [], bytes: 0 });
		return buckets.get(key);
	};
	const collect = (b, dir) => {
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
				else {
					try {
						b.bytes += fs.statSync(full).size;
					} catch {}
					b.files.push(path.relative(root, full).replace(/\\/g, '/'));
				}
			}
		};
		walk(dir);
	};

	const walk = (d) => {
		let entries;
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(d, e.name);
			const rel = path.relative(root, full).replace(/\\/g, '/');
			if (e.isDirectory()) {
				const plat = PRUNE_BY_PLATFORM.find((p) => rel === p || rel.startsWith(p + '/'));
				if (plat) {
					collect(bucket('plat:' + plat, `平台  ${plat}`, '别的操作系统的产物'), full);
					continue;
				}
				if (PRUNE_BY_DIR.includes(e.name.toLowerCase())) {
					collect(bucket('dir:' + e.name.toLowerCase(), `目录  ${e.name}/`, '测试 / 文档 / 示例'), full);
					continue;
				}
				walk(full);
			} else {
				// 注意: 不能用 path.extname —— 它对 foo.d.ts 返回 ".ts", 会让整个
				// .d.ts 档 (33 MiB) 静默漏掉. 用后缀匹配.
				const lower = e.name.toLowerCase();
				const hit = PRUNE_BY_EXT.find(([x]) => lower.endsWith(x));
				if (hit) {
					const b = bucket('ext:' + hit[0], `扩展  *${hit[0]}`, hit[1]);
					try {
						b.bytes += fs.statSync(full).size;
					} catch {}
					b.files.push(rel);
				}
			}
		}
	};
	walk(root);

	// 引用检查
	for (const b of buckets.values()) {
		const key = b.key.slice(b.key.indexOf(':') + 1);
		if (b.key.startsWith('ext:')) {
			b.ref = [...specs].find((s) => s.toLowerCase().endsWith(key));
		} else {
			// 必须按**路径段**判断, 不能用裸子串. 否则:
			//   "vitest"                          被当成引用了 test/
			//   "@shikijs/langs/asciidoc"         被当成引用了 doc/
			//   "registry.example.com/my-org/..." 被当成引用了 example/
			//   "benchmark"                       被当成引用了 benchmark/
			const seg = key.includes('/') ? key : `/${key}`;
			b.ref = [...specs].find((s) => {
				const low = s.toLowerCase();
				return low.includes(seg + '/') || low.endsWith(seg);
			});
		}
	}

	const list = [...buckets.values()].sort((a, b) => b.bytes - a.bytes);
	const totalBytes = list.reduce((n, b) => n + b.bytes, 0);
	const totalFiles = list.reduce((n, b) => n + b.files.length, 0);

	log('');
	log('=== 裁剪分析 ===');
	log('');
	log('  类别                              文件数        大小   引用检查');
	log('  ─────────────────────────────────────────────────────────────────');
	for (const b of list) {
		const verdict = b.ref ? `被引用! ${b.ref}` : '无引用';
		log(
			`  ${b.label.padEnd(32)} ${String(b.files.length).padStart(6)}  ${human(b.bytes).padStart(10)}   ${verdict}`
		);
	}
	log('  ─────────────────────────────────────────────────────────────────');
	log(`  ${'合计'.padEnd(32)} ${String(totalFiles).padStart(6)}  ${human(totalBytes).padStart(10)}`);
	log('');
	const blocked = list.filter((b) => b.ref);
	if (blocked.length > 0) {
		warn(`  ! 有 ${blocked.length} 个类别被代码引用, 不会删:`);
		for (const b of blocked) warn(`      ${b.label}  <- ${b.ref}`);
	}

	const before = dirSize(root);
	log(`  应用树: ${human(before.bytes)} / ${before.files} 文件`);
	log(`  删除后: ${human(before.bytes - totalBytes + list.filter((b) => b.ref).reduce((n, b) => n + b.bytes, 0))} 左右`);

	return { buckets: list, totalBytes, totalFiles, blocked };
}

function applyPrune(analysis) {
	let removed = 0;
	for (const b of analysis.buckets) {
		if (b.ref) continue;
		for (const rel of b.files) {
			const full = path.join(APP, rel);
			try {
				fs.rmSync(full, { force: true });
				removed++;
			} catch {}
		}
	}
	// 清掉空目录
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
		if (empty && d !== APP) {
			try {
				fs.rmdirSync(d);
			} catch {}
		}
		return empty;
	};
	pruneEmpty(APP);
	return removed;
}

if (DO_PRUNE) {
	const analysis = analyzePrune(APP);
	if (DRY_RUN) {
		log('');
		log('  --dry-run: 上面只是分析, 没有删任何东西.');
		log('  确认无误后去掉 --dry-run 重跑即可真正删除.');
	} else {
		const n = applyPrune(analysis);
		const after = dirSize(APP);
		log('');
		log(`  已删除 ${n} 个文件`);
		log(`  应用树: ${human(after.bytes)} / ${after.files} 文件`);
	}
	log('');
}

// ─────────────────────────── 5. 报告 ───────────────────────────
const size = dirSize(APP);
log('\n=== 结果 ===');
log(`  应用树: ${human(size.bytes)} / ${size.files} 文件`);
log(`  位置:   ${APP}`);
if (bad > 0) {
	warn(`\n  ! 有 ${bad} 项校验未通过, 不要打包`);
	process.exit(1);
}
log('\n下一步: node probe/tools/fetch-runtime.mjs --out dsh/module   (取运行时)');
log('        powershell -File probe/tools/build-module.ps1 -ModuleDir dsh/module   (打包)');
