#!/usr/bin/env node
/**
 * 生成 THIRD_PARTY_NOTICES.md。
 *
 * 为什么要有这个文件:
 *   本模块**随包分发**几百个第三方二进制与代码 —— 27 个 Termux 包 (运行时)
 *   加 513 个 npm 包 (DSH 应用树)。其中 bash / readline / git / less 是 GPL,
 *   libiconv 是 LGPL。分发这些二进制时, 附许可证与提供源码是**义务**, 不是礼貌。
 *
 *   仓库根的 LICENSE (Apache-2.0) 只覆盖本项目自己写的代码, 不覆盖它们。
 *   GitHub 只会按那个文件显示一个标签, 所以这份清单必须存在且准确。
 *
 * 为什么是脚本而不是手写:
 *   包会变 (升级 DSH、加运行时包), 手写的清单必然过期。这个脚本可重跑。
 *
 * 用法:
 *   node dsh/tools/gen-third-party-notices.mjs            # 写 THIRD_PARTY_NOTICES.md
 *   node dsh/tools/gen-third-party-notices.mjs --stdout   # 只打印, 不写文件
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const APP_MODULES = path.join(REPO, 'dsh', 'module', 'app', 'node_modules');
const OUT = path.join(REPO, 'THIRD_PARTY_NOTICES.md');
const TO_STDOUT = process.argv.includes('--stdout');

/**
 * 运行时二进制清单。
 *
 * 数据来源 (不是猜的):
 *   · 许可证 —— termux-packages 里各包的 build.sh 中的 TERMUX_PKG_LICENSE
 *   · 版本   —— Termux APT 索引的 Packages 文件
 *   · 拿不到的 —— 包内自带的 usr/share/doc/<pkg>/copyright
 *
 * `gpl: true` 的条目有源码提供义务, 会单独成表。
 */
const RUNTIME = [
	{ name: 'bash', version: '5.3.20', license: 'GPL-3.0', gpl: true, home: 'https://www.gnu.org/software/bash/', src: 'https://ftp.gnu.org/gnu/bash/' },
	{ name: 'readline', version: '8.3.6', license: 'GPL-3.0', gpl: true, home: 'https://tiswww.case.edu/php/chet/readline/rltop.html', src: 'https://ftp.gnu.org/gnu/readline/' },
	{ name: 'git', version: '2.55.0', license: 'GPL-2.0', gpl: true, home: 'https://git-scm.com/', src: 'https://mirrors.kernel.org/pub/software/scm/git/' },
	{ name: 'less', version: '710', license: 'GPL-3.0, custom (BSD-2 式)', gpl: true, home: 'https://www.greenwoodsoftware.com/less/', src: 'https://www.greenwoodsoftware.com/less/' },
	{ name: 'libiconv', version: '1.19', license: 'LGPL-2.1, GPL-3.0', gpl: true, home: 'https://www.gnu.org/software/libiconv/', src: 'https://ftp.gnu.org/gnu/libiconv/' },

	{ name: 'nodejs', version: '26.4.0-1', license: 'MIT', home: 'https://nodejs.org/' },
	{ name: 'npm', version: '11.20.0', license: 'Artistic-2.0', home: 'https://docs.npmjs.com/cli/' },
	{ name: 'pnpm', version: '12.7.0', license: 'MIT', home: 'https://pnpm.io' },
	{ name: 'ripgrep', version: '15.2.0', license: 'MIT OR Unlicense', home: 'https://github.com/BurntSushi/ripgrep' },
	{ name: 'openssl', version: '3.6.3', license: 'Apache-2.0', home: 'https://www.openssl.org/' },
	{ name: 'libicu', version: '78.3', license: 'Unicode-3.0 (ICU)', home: 'https://icu.unicode.org/' },
	{ name: 'libc++', version: '30', license: 'NCSA', home: 'https://libcxx.llvm.org/' },
	{ name: 'ncurses', version: '6.6', license: 'MIT (X11)', home: 'https://invisible-island.net/ncurses/' },
	{ name: 'zlib', version: '1.3.2', license: 'Zlib', home: 'https://www.zlib.net/' },
	{ name: 'pcre2', version: '10.47', license: 'BSD-3-Clause', home: 'https://pcre2project.github.io/pcre2/' },
	{ name: 'c-ares', version: '1.34.8', license: 'MIT', home: 'https://c-ares.org/' },
	{ name: 'libffi', version: '3.8.0', license: 'MIT', home: 'https://sourceware.org/libffi/' },
	{ name: 'libsqlite', version: '3.53.4', license: 'Public Domain', home: 'https://www.sqlite.org' },
	{ name: 'libcurl', version: '8.22.0', license: 'curl (MIT 式)', home: 'https://curl.se/' },
	{ name: 'libssh2', version: '1.11.1-2', license: 'BSD-3-Clause', home: 'https://www.libssh2.org' },
	{ name: 'libexpat', version: '2.8.5', license: 'MIT', home: 'https://libexpat.github.io/' },
	{ name: 'libnghttp2', version: '1.70.0', license: 'MIT', home: 'https://nghttp2.org/' },
	{ name: 'libnghttp3', version: '1.18.0', license: 'MIT', home: 'https://nghttp2.org/nghttp3/' },
	{ name: 'libngtcp2', version: '1.25.0', license: 'MIT', home: 'https://github.com/ngtcp2/ngtcp2' },
	{ name: 'libandroid-support', version: '29-1', license: 'Apache-2.0, MIT', home: 'https://github.com/termux/libandroid-support' },
	{ name: 'ca-certificates', version: '2026.08.13', license: 'MPL-2.0', home: 'https://curl.se/docs/caextract.html' },
	{ name: 'resolv-conf', version: '1.3', license: 'Public Domain', home: 'https://man7.org/linux/man-pages/man5/resolv.conf.5.html' },
];

/**
 * 扫 npm 树, 收集每个包的 name / version / license。
 *
 * 只把 **node_modules 的直接子目录** (以及 @scope 下的一层) 当成包。
 * 否则会把包内的子目录误当成独立包 —— 实测 @google/genai/node、
 * web-streams-polyfill-es2018 这类"有 package.json 的子路径目录"会混进来,
 * 而且它们通常没有 license 字段, 于是清单里出现一堆假的"未声明许可证"。
 */
function scanNpm(root) {
	const seen = new Map();

	const add = (dir) => {
		const pj = path.join(dir, 'package.json');
		if (!fs.existsSync(pj)) return;
		try {
			const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
			if (!j.name || seen.has(j.name)) return;
			let lic = j.license;
			if (!lic && Array.isArray(j.licenses)) lic = j.licenses.map((l) => l.type ?? l).join(', ');
			if (lic && typeof lic === 'object') lic = lic.type;
			seen.set(j.name, {
				name: j.name,
				version: j.version ?? '?',
				license: lic || 'UNKNOWN',
				repo: typeof j.repository === 'string' ? j.repository : j.repository?.url,
			});
		} catch {}
	};

	const readdir = (d) => {
		try {
			return fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return [];
		}
	};

	const visitModules = (modDir) => {
		for (const e of readdir(modDir)) {
			if (!e.isDirectory() || e.name === '.bin' || e.name === '.cache') continue;
			const targets = [];
			if (e.name.startsWith('@')) {
				for (const s of readdir(path.join(modDir, e.name))) {
					if (s.isDirectory()) targets.push(path.join(modDir, e.name, s.name));
				}
			} else {
				targets.push(path.join(modDir, e.name));
			}
			for (const d of targets) {
				add(d);
				const nested = path.join(d, 'node_modules');
				if (fs.existsSync(nested)) visitModules(nested);
			}
		}
	};

	visitModules(root);
	return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 把一堆许可证字符串归到一个组名。 */
function groupOf(lic) {
	const l = String(lic);
	if (/^UNKNOWN$/i.test(l)) return '未声明';
	if (/\bMIT\b/i.test(l) && !/OR|AND|\//i.test(l)) return 'MIT';
	if (/Apache/i.test(l)) return 'Apache-2.0';
	if (/^ISC$/i.test(l)) return 'ISC';
	if (/BSD/i.test(l)) return 'BSD';
	if (/^MPL/i.test(l) || /Mozilla/i.test(l)) return 'MPL';
	if (/GPL/i.test(l)) return 'GPL';
	if (/Unlicense/i.test(l)) return 'Unlicense / Public Domain';
	if (/CC0|Public Domain|Unlicense/i.test(l)) return 'Unlicense / Public Domain';
	return '其他';
}

function main() {
	if (!fs.existsSync(APP_MODULES)) {
		console.error(`找不到 ${APP_MODULES} —— 先跑 build-dsh-tree.mjs`);
		process.exit(1);
	}
	const npm = scanNpm(APP_MODULES);
	const groups = new Map();
	for (const p of npm) {
		const g = groupOf(p.license);
		if (!groups.has(g)) groups.set(g, []);
		groups.get(g).push(p);
	}
	const order = ['MIT', 'ISC', 'Apache-2.0', 'BSD', 'MPL', 'Unlicense / Public Domain', '其他', 'GPL', '未声明'];
	const sorted = [...groups.entries()].sort((a, b) => {
		const ia = order.indexOf(a[0]);
		const ib = order.indexOf(b[0]);
		return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
	});

	const L = [];
	L.push('# 第三方组件与许可证');
	L.push('');
	L.push('本模块**随包分发**下列第三方二进制与代码。它们各自归其版权人所有，并适用各自的许可证。');
	L.push('');
	L.push('> **`LICENSE`（Apache-2.0）只覆盖本项目自己写的代码** —— `dsh/module/*.sh`、`dsh/tools/`、');
	L.push('> `probe/`、`docs/` 等。下面列出的第三方组件**不适用**该许可。');
	L.push('>');
	L.push('> GitHub 只会按仓库根的 `LICENSE` 显示一个标签，那份标签**不代表**整个仓库。');
	L.push('');
	L.push('---');
	L.push('');
	L.push(`## 一、运行时二进制（来自 Termux）—— ${RUNTIME.length} 个`);
	L.push('');
	L.push('这些是从 [Termux](https://termux.dev/) 的 APT 仓库取出 `.deb`，再由');
	L.push('[`probe/tools/fetch-runtime.mjs`](probe/tools/fetch-runtime.mjs) 解包重组的。');
	L.push('');
	L.push('**每个包的许可证跟随其上游**，依据 [termux-packages/LICENSE.md](https://github.com/termux/termux-packages/blob/master/LICENSE.md)：');
	L.push('*"the scripts and patches to build each package is licensed under the same license as the actual package"*。');
	L.push('');

	const gpl = RUNTIME.filter((p) => p.gpl);
	const permissive = RUNTIME.filter((p) => !p.gpl);

	L.push('### 1.1 需要提供源码的组件（GPL / LGPL）');
	L.push('');
	L.push('分发下列二进制时，附许可证与**提供对应源码**是义务。源码地址：');
	L.push('');
	L.push('| 组件 | 版本 | 许可证 | 源码 |');
	L.push('|---|---|---|---|');
	for (const p of gpl) L.push(`| ${p.name} | ${p.version} | ${p.license} | ${p.src} |`);
	L.push('');
	L.push('**构建脚本与补丁**（Termux 对上游的修改）在 [termux-packages](https://github.com/termux/termux-packages)');
	L.push('的 `packages/<名称>/` 目录下，同样按上游许可证发布。');
	L.push('');
	L.push('如果你需要这些组件的源码副本，请开 issue。');
	L.push('');

	L.push('### 1.2 宽松许可组件');
	L.push('');
	L.push('| 组件 | 版本 | 许可证 | 上游 |');
	L.push('|---|---|---|---|');
	for (const p of permissive) L.push(`| ${p.name} | ${p.version} | ${p.license} | ${p.home} |`);
	L.push('');
	L.push('> 许可证全文随包发在模块的 `usr/share/doc/<包名>/copyright`。');
	L.push('> （这些文件**不被裁剪** —— 早期版本的裁剪逻辑删掉了它们，那是错的，已改回。）');
	L.push('');

	L.push('---');
	L.push('');
	L.push(`## 二、DSH 应用树（npm）—— ${npm.length} 个包`);
	L.push('');
	L.push('`dsh/module/app/node_modules/` 下的包。数据从各包自己的 `package.json` 读取。');
	L.push('');
	L.push('| 许可证 | 包数 |');
	L.push('|---|---|');
	for (const [g, list] of sorted) L.push(`| ${g} | ${list.length} |`);
	L.push('');
	for (const [g, list] of sorted) {
		L.push(`### ${g}（${list.length}）`);
		L.push('');
		for (const p of list) {
			const lic = p.license === 'UNKNOWN' ? '⚠️ 未声明' : p.license;
			L.push(`- \`${p.name}@${p.version}\` — ${lic}`);
		}
		L.push('');
	}

	L.push('---');
	L.push('');
	L.push('## 三、生成方式');
	L.push('');
	L.push('```sh');
	L.push('node dsh/tools/gen-third-party-notices.mjs');
	L.push('```');
	L.push('');
	L.push('运行时部分的数据来源：`TERMUX_PKG_LICENSE`（各包的 `build.sh`）、Termux APT 索引的 `Packages`');
	L.push('文件、以及包内自带的 `usr/share/doc/<pkg>/copyright`。**不是手抄的猜测。**');
	L.push('');

	const text = L.join('\n');
	if (TO_STDOUT) {
		process.stdout.write(text);
	} else {
		fs.writeFileSync(OUT, text, 'utf8');
		console.log(`已写入 ${OUT}`);
		console.log(`  运行时: ${RUNTIME.length} 个 (其中 GPL/LGPL ${gpl.length} 个)`);
		console.log(`  npm:    ${npm.length} 个`);
		const unknown = npm.filter((p) => p.license === 'UNKNOWN');
		if (unknown.length > 0) {
			console.log(`  ! ${unknown.length} 个 npm 包没有声明许可证:`);
			for (const p of unknown.slice(0, 10)) console.log(`      ${p.name}@${p.version}`);
		}
	}
}

main();
