#!/usr/bin/env node
/**
 * check-blob-eol.mjs — 核**索引/HEAD 里的 blob**（不是工作区文件）有没有 CR 或 BOM。
 *
 * 为什么这要紧
 * ------------
 * 别人 clone 出来的是 blob 的内容。工作区 CR=0 不代表 blob CR=0 —— 本仓库
 * `core.autocrlf=true` 是**开着**的，全靠 .gitattributes 里那句
 * `* text=auto eol=lf` 压住。这句压没压住，只能去看 blob。
 * 而对 Android 模块来说 CR 不是风格问题: `#!/system/bin/sh\r` 不是合法 shebang，
 * service.sh 直接起不来，症状是"装了模块什么都没有"，一行报错都没有。
 *
 * 为什么清单是**算出来的**而不是写死的
 * -------------------------------------
 * 上一版这里写死了 7 个文件名。加第 8 个文件时它不会报错，只会**安静地不查它** ——
 * 而"安静地不查"正好是本项目反复踩的那类假绿灯。现在默认查 git 自己给出的列表。
 *
 * 用法
 * ----
 *   node probe/tools/check-blob-eol.mjs              # 查暂存区（没有暂存内容时查 HEAD）
 *   node probe/tools/check-blob-eol.mjs --staged     # 强制查暂存区
 *   node probe/tools/check-blob-eol.mjs --head       # 强制查 HEAD
 *   node probe/tools/check-blob-eol.mjs --all        # 查所有被跟踪的文件
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);

// shell:false + 直接调 git: 不能让 PowerShell 把字节流转成文本（那会把 CR 洗掉，
// 于是这个检查在最该报警的时候闭嘴）。
function git(args) {
	return execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 26, shell: false });
}
function gitText(args) {
	return git(args).toString('utf8');
}

let mode = 'auto';
if (argv.includes('--staged')) mode = 'staged';
else if (argv.includes('--head')) mode = 'head';
else if (argv.includes('--all')) mode = 'all';

let source = 'index';
let paths = [];
if (mode === 'all') {
	source = 'index';
	paths = gitText(['ls-files']).split('\n').filter(Boolean);
} else {
	if (mode === 'head') {
		source = 'HEAD';
		paths = gitText(['diff', '--name-only', '--diff-filter=ACM', 'HEAD']).split('\n').filter(Boolean);
		// HEAD 模式下"和 HEAD 有差异的文件"才是有意义的一组 —— 全量的话用 --all
		if (paths.length === 0) paths = gitText(['ls-files']).split('\n').filter(Boolean);
	} else {
		paths = gitText(['diff', '--cached', '--name-only', '--diff-filter=ACM']).split('\n').filter(Boolean);
		if (paths.length === 0) {
			// 没东西暂存 → 查 HEAD 全量，而不是报"0 个文件、全绿"。
			// 空列表 + exit 0 是最坏的组合: 它看起来像通过了什么都没查。
			source = 'HEAD';
			paths = gitText(['ls-files']).split('\n').filter(Boolean);
		}
	}
}

let bad = 0;
let skippedBinary = 0;
console.log(`检查 ${paths.length} 个文件 (来源: ${source})`);
for (const rel of paths) {
	let buf;
	try {
		buf = git(source === 'HEAD' ? ['cat-file', 'blob', `HEAD:${rel}`] : ['cat-file', 'blob', `:${rel}`]);
	} catch (e) {
		// 暂存区里的路径在 HEAD 不存在是常态(新文件)，反之亦然 —— 跳过但要说明。
		console.log(`  SKIP ${rel}  (取不到 blob: ${String(e.message).split('\n')[0]})`);
		continue;
	}
	// 二进制判定用 git 自己的规则: blob 里有 NUL 就当二进制。
	// 对二进制查 CR 毫无意义(ELF 里到处是 0x0d)，把它算成失败会让这个门禁
	// 在第一次碰到 node 二进制时就变成"永远的红灯"，而永远的红灯等于没有门禁。
	if (buf.includes(0)) {
		skippedBinary++;
		continue;
	}
	const cr = buf.includes(0x0d);
	const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
	if (cr || bom) {
		bad++;
		let firstCR = -1;
		if (cr) firstCR = buf.indexOf(0x0d);
		console.log(`  FAIL ${rel}  ${cr ? `CR@${firstCR}` : ''}${bom ? ' BOM' : ''} —— blob 里就不是 LF`);
	}
}
console.log('');
if (bad === 0) {
	console.log(`  blob 全部 LF/无 BOM ✓  (${paths.length - skippedBinary} 个文本文件，${skippedBinary} 个二进制跳过)`);
} else {
	console.log(`  ✗ ${bad} 个文件的 blob 里带 CR/BOM`);
	console.log('    .gitattributes 里的 `* text=auto eol=lf` 没起作用，或文件是用');
	console.log('    绕过 git 的方式写进去的（编辑器直接落盘 / 脚本 CRLF 输出）。');
}
process.exitCode = bad > 0 ? 1 : 0;
