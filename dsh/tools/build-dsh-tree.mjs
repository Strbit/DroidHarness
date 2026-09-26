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
log('=== 打补丁 ===');

const pkgDir = path.join(APP, 'node_modules', 'node-addon-require-builtin');
const shimTarget = path.join(pkgDir, 'lib', 'index.js');

if (!fs.existsSync(pkgDir)) {
	die(`找不到 ${pkgDir} —— 这棵树不完整`);
}
if (!fs.existsSync(SHIM_SRC)) {
	die(`找不到 shim 源文件: ${SHIM_SRC}`);
}

// 原包的 main 是 lib/index.js. 先确认, 免得版本升级后换路径而我们静默没打上.
const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const mainField = pkgJson.main ?? 'index.js';
if (mainField !== 'lib/index.js') {
	warn(`! 原包 main 变成了 "${mainField}", 与 shim 假设的 lib/index.js 不一致`);
	warn('  请更新本脚本的 shimTarget');
	die('shim 落点不匹配, 拒绝继续');
}

fs.copyFileSync(SHIM_SRC, shimTarget);
log(`  ✓ 已用 JS 替身覆盖 ${path.relative(APP, shimTarget)}`);

// 顺手把原包的 optionalDependencies 清掉 —— 它们指向一堆装不上的平台包,
// 留着只会让 npm ls 之类的工具报 unmet.
pkgJson.optionalDependencies = {};
pkgJson.description = 'JS shim (Android): 原包的平台专用原生加载器没有 android 变体';
fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n');
log('  ✓ 已清掉该包的 optionalDependencies');

// ─────────────────────────── 3. 校验 ───────────────────────────
log('\n=== 校验 ===');

const nodeBin = process.env.NODE_BIN ?? 'node';
const checks = [
	['koffi 平台预编译包', path.join(APP, 'node_modules', '@koromix', 'koffi-android-arm64', 'android_arm64', 'koffi.node')],
	['koffi 加载器入口', path.join(APP, 'node_modules', 'koffi', 'src', 'koffi', 'index.cjs')],
	['DSH 入口', path.join(APP, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')],
	['shim 落点', shimTarget],
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

// ─────────────────────────── 4. 报告 ───────────────────────────
const size = dirSize(APP);
log('\n=== 结果 ===');
log(`  应用树: ${human(size.bytes)} / ${size.files} 文件`);
log(`  位置:   ${APP}`);
if (bad > 0) {
	warn(`\n  ! 有 ${bad} 项校验未通过, 不要打包`);
	process.exit(1);
}
log('\n下一步: node probe/tools/fetch-runtime.mjs --out dsh/module   (取运行时)');
log('        powershell -File tools/build-module.ps1              (打包)');
