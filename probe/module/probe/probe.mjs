#!/usr/bin/env node
/**
 * DSH Android Runtime Probe
 *
 * 目的: 在一台已 root 的安卓机上, 用最小代价回答"DSH 能不能在这台机器上跑"这个问题.
 * 它不启动 DSH, 只测 DSH 依赖的那些底层能力.
 *
 * 输出是给人看的, 也是给 grep 的: 每行以 [ OK ] / [FAIL] / [WARN] / [SKIP] 开头.
 * 退出码恒为 0 —— 这是探针, 失败本身就是要观测的结果, 不要让调用方以为脚本坏了.
 */

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const require = createRequire(import.meta.url);

const lines = [];
function out(tag, label, detail) {
	const text = detail === undefined || detail === '' ? label : `${label} — ${detail}`;
	lines.push(`${tag} ${text}`);
	console.log(`${tag} ${text}`);
}
const ok = (l, d) => out('[ OK ]', l, d);
const fail = (l, d) => out('[FAIL]', l, d);
const warn = (l, d) => out('[WARN]', l, d);
const skip = (l, d) => out('[SKIP]', l, d);
const info = (l, d) => out('[INFO]', l, d);

function section(title) {
	const bar = '='.repeat(58);
	console.log(`\n${bar}\n${title}\n${bar}`);
	lines.push(`\n== ${title}`);
}

/** 把异常压成一行可读的东西, 关键是保留 code —— MODULE_NOT_FOUND 与 ERR_DLOPEN_FAILED 是两回事. */
function errText(err) {
	if (err === null || err === undefined) return String(err);
	const code = err.code ? `${err.code}: ` : '';
	const msg = String(err.message ?? err).split('\n')[0];
	return `${code}${msg}`;
}

// ─────────────────────────────────────────────────────────────
section('1. 运行时身份 (npm 的平台判定靠这里)');

info('node', process.versions.node);
info('v8', process.versions.v8);
info('openssl', process.versions.openssl ?? '(未链接 openssl)');
info('modules (ABI)', process.versions.modules);
info('platform', process.platform);
info('arch', process.arch);
info('execPath', process.execPath);
info('cwd', process.cwd());
info('execArgv', process.execArgv.length ? process.execArgv.join(' ') : '(空)');

// process.platform 是否为 android 决定 npm 会不会去取 @koromix/koffi-android-arm64.
if (process.platform === 'android') {
	ok('platform 报 android', 'npm 的 optionalDependencies 平台判定会走对分支');
} else {
	warn(
		'platform 不是 android',
		`报的是 "${process.platform}". 这样 npm 不会安装 @koromix/koffi-android-arm64, ` +
			'需要手工放置平台包或设置 npm_config_platform / npm_config_arch'
	);
}

if (process.arch === 'arm64') ok('arch 报 arm64', '与 K90 Pro Max 一致');
else warn('arch 不是 arm64', `报的是 "${process.arch}"`);

// ─────────────────────────────────────────────────────────────
section('2. 进程身份与权限');

try {
	info('uid / gid', `${process.getuid?.() ?? '?'} / ${process.getgid?.() ?? '?'}`);
	if (process.getuid?.() === 0) ok('以 root 运行', 'uid 0');
	else warn('不是 root', `uid ${process.getuid?.()}`);
} catch (err) {
	warn('取 uid 失败', errText(err));
}

// SELinux 上下文: 决定能 exec 什么、能写哪里. 读不到不算错.
try {
	const ctx = fs.readFileSync('/proc/self/attr/current', 'utf8').trim().replace(/\0/g, '');
	info('SELinux context', ctx);
} catch (err) {
	warn('读不到 SELinux context', errText(err));
}

try {
	const enforce = fs.readFileSync('/sys/fs/selinux/enforce', 'utf8').trim();
	info('SELinux enforce', enforce === '1' ? '1 (enforcing)' : `${enforce} (permissive)`);
} catch (err) {
	info('SELinux enforce', `读不到 (${errText(err)})`);
}

// ─────────────────────────────────────────────────────────────
section('3. 系统资源 (APK 沙箱环境下 os.cpus() 可能返回 0)');

const cpuCount = os.cpus().length;
info('os.cpus().length', String(cpuCount));
if (cpuCount > 0) ok('CPU 数正常', `${cpuCount} 核`);
else fail('CPU 数为 0', 'DSH 里任何按 CPU 数并行的地方都要能容忍 0 —— 这是已知的安卓坑');

info('os.tmpdir()', os.tmpdir());
info('totalmem', `${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB`);
info('freemem', `${(os.freemem() / 1024 ** 3).toFixed(1)} GiB`);

// ─────────────────────────────────────────────────────────────
section('4. 文件系统可写性');

const writeTargets = [
	['TMPDIR', os.tmpdir()],
	['/data/local/tmp', '/data/local/tmp'],
	['$HOME', os.homedir()],
];
for (const [label, dir] of writeTargets) {
	try {
		fs.mkdirSync(dir, { recursive: true });
		const probe = path.join(dir, `.dsh-probe-${process.pid}`);
		fs.writeFileSync(probe, 'probe');
		const readBack = fs.readFileSync(probe, 'utf8');
		fs.unlinkSync(probe);
		if (readBack === 'probe') ok(`可写 ${label}`, dir);
		else warn(`写入 ${label} 后读回不一致`, dir);
	} catch (err) {
		fail(`不可写 ${label}`, `${dir} — ${errText(err)}`);
	}
}

// ─────────────────────────────────────────────────────────────
section('5. 子进程 (DSH 的 bash 工具全靠它)');

function trySpawn(label, cmd, args) {
	try {
		const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000 });
		if (r.error) {
			fail(label, errText(r.error));
			return;
		}
		const text = (r.stdout ?? '').trim().split('\n')[0];
		if (r.status === 0) ok(label, text || '(空输出)');
		else warn(label, `退出码 ${r.status} — ${(r.stderr ?? '').trim().split('\n')[0]}`);
	} catch (err) {
		fail(label, errText(err));
	}
}

trySpawn('spawn /system/bin/id', '/system/bin/id', []);
trySpawn('spawn /system/bin/getprop ro.product.cpu.abi', '/system/bin/getprop', ['ro.product.cpu.abi']);
trySpawn('spawn sh -c echo', '/system/bin/sh', ['-c', 'echo spawn-ok']);

// ─────────────────────────────────────────────────────────────
section('6. 原生模块加载 (决定 DSH 的哪些能力可用)');

const nativeCandidates = [
	['koffi', '有官方 @koromix/koffi-android-arm64, 是 subprocess 的 Linux execve 引导路径'],
	['node-pty', '无 android 预编译; 需要 node-gyp 现编'],
	['sharp', '无 android 变体, 预期失败'],
	['node-addon-require-builtin', '只有 win32 子包, 预期失败; 用 --expose-internals 绕开'],
	['@deepseek-ai/node-addon-system', '只发源码不发 .node, 预期失败; DSH 设计上容忍'],
];

for (const [name, why] of nativeCandidates) {
	try {
		const resolved = require.resolve(name);
		try {
			require(name);
			ok(`require("${name}")`, `已加载 — ${resolved}`);
		} catch (err) {
			fail(`require("${name}") 解析到但加载失败`, `${errText(err)} — ${resolved}`);
		}
	} catch (err) {
		const code = err.code ?? '';
		if (code === 'MODULE_NOT_FOUND') {
			skip(`require("${name}")`, `未安装 — ${why}`);
		} else {
			fail(`require("${name}")`, errText(err));
		}
	}
}

// ─────────────────────────────────────────────────────────────
section('7. Node internals (dsh-app-boot 有一处无保护的 require)');

const hasExposeInternals = process.execArgv.includes('--expose-internals');
info('--expose-internals', hasExposeInternals ? '已开启' : '未开启');

for (const id of ['internal/modules/esm/loader', 'internal/modules/cjs/loader']) {
	try {
		require(id);
		ok(`require("${id}")`, '可直接 require');
	} catch (err) {
		if (hasExposeInternals) fail(`require("${id}")`, errText(err));
		else skip(`require("${id}")`, '需要 --expose-internals');
	}
}

// dsh-app-boot 的 internalModules() 是无保护的 createRequire(...)("node-addon-require-builtin"),
// 而 cordis-plugin-loader 的同名能力有 try/catch. 这一项失败意味着启动路径可能直接抛.
try {
	require('node-addon-require-builtin');
	ok('dsh-app-boot 的硬依赖满足', 'node-addon-require-builtin 可加载');
} catch (err) {
	if (hasExposeInternals) {
		warn('node-addon-require-builtin 不可加载', `${errText(err)} — 但 --expose-internals 已开, 需确认 dsh-app-boot 是否走该分支`);
	} else {
		fail('node-addon-require-builtin 不可加载', `${errText(err)} — 这是目前唯一已知的硬依赖, 见 README`);
	}
}

// ─────────────────────────────────────────────────────────────
section('8. TLS (证明 OpenSSL 与 CA 证书链是活的)');

const tlsHost = process.env.PROBE_TLS_HOST || 'registry.npmjs.org';

function tlsProbe() {
	return new Promise((resolve) => {
		let settled = false;
		const done = (v) => {
			if (!settled) {
				settled = true;
				resolve(v);
			}
		};
		const req = https.request(
			{ host: tlsHost, port: 443, path: '/', method: 'HEAD', timeout: 12000 },
			(res) => {
				done({ ok: true, detail: `HTTP ${res.statusCode}` });
				res.resume();
			}
		);
		req.on('timeout', () => {
			req.destroy();
			done({ ok: false, detail: '超时 (网络不可达, 不代表 TLS 坏)' });
		});
		req.on('error', (err) => done({ ok: false, detail: errText(err) }));
		req.end();
	});
}

const tls = await tlsProbe();
if (tls.ok) ok(`TLS 握手 ${tlsHost}`, tls.detail);
else warn(`TLS 握手 ${tlsHost} 未成功`, tls.detail);

info('SSL_CERT_FILE', process.env.SSL_CERT_FILE || '(未设)');
info('SSL_CERT_DIR', process.env.SSL_CERT_DIR || '(未设)');
try {
	const n = fs.readdirSync('/system/etc/security/cacerts').length;
	ok('安卓系统 CA 库可读', `/system/etc/security/cacerts 有 ${n} 项`);
} catch (err) {
	warn('安卓系统 CA 库不可读', errText(err));
}

// ─────────────────────────────────────────────────────────────
section('9. 关键环境变量 (Termux 二进制写死的路径)');

for (const key of ['OPENSSL_CONF', 'SHELL', 'TMPDIR', 'LD_LIBRARY_PATH', 'HOME', 'PATH']) {
	const v = process.env[key];
	if (v) info(key, v);
	else warn(`${key} 未设`, key === 'OPENSSL_CONF' ? '不设会让 Node 在 bootstrap 阶段静默 exit 13' : '');
}

// OPENSSL_CONF 指向一个不存在的文件同样会炸, 所以单独验证它可读.
if (process.env.OPENSSL_CONF) {
	try {
		fs.accessSync(process.env.OPENSSL_CONF, fs.constants.R_OK);
		ok('OPENSSL_CONF 可读', process.env.OPENSSL_CONF);
	} catch (err) {
		fail('OPENSSL_CONF 指向的文件不可读', `${process.env.OPENSSL_CONF} — ${errText(err)}`);
	}
} else {
	fail('OPENSSL_CONF 未设', '这是 Termux 版 Node 在安卓上最经典的静默失败原因');
}

// ─────────────────────────────────────────────────────────────
section('汇总');

const count = (t) => lines.filter((l) => l.startsWith(t)).length;
const nOk = count('[ OK ]');
const nFail = count('[FAIL]');
const nWarn = count('[WARN]');
const nSkip = count('[SKIP]');

console.log(`[ OK ] ${nOk}   [FAIL] ${nFail}   [WARN] ${nWarn}   [SKIP] ${nSkip}`);
console.log('\n把上面全部输出贴回来即可. 判据见 README.md 的"怎么看结果".');

process.exit(0);
