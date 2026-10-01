#!/usr/bin/env node
/**
 * build-uiaction.mjs — 编译设备侧动作注入的 dex（DshActionMain.java → classes.dex）。
 *
 * 为什么在仓库里放源码、构建时才编译
 * --------------------------------
 * 与 imgtool 同一条纪律：装机产物不入版本库，但**源码必须入库**。
 * dex 由本机 Android SDK 编出（build-tools 的 d8 + platforms 的 android.jar），
 * 缺了会在打包阶段明确报错并给出修复命令，不会悄悄产出一个没有动作能力的包。
 *
 *   recognize/uiaction/DshActionMain.java   源码（入库）
 *   .build/uiaction/classes.dex             产物（不入库，build-dsh-tree 拷进模块）
 *
 * 编译链: javac(17) --release 8 → .class → d8 --release → classes.dex
 * 为什么 --release 8: app_process 的 ART 对新版本 class 文件格式有版本差，
 * 8 是 d8 与各在役 Android 都稳的保守下限。
 *
 * 用法:
 *   node dsh/tools/build-uiaction.mjs
 *   ANDROID_SDK_ROOT=D:\sdk node dsh/tools/build-uiaction.mjs   (显式指定 SDK)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SRC = path.join(ROOT, 'recognize', 'uiaction');
const OUT = path.join(ROOT, '.build', 'uiaction');

const log = (m) => console.log(m);
const die = (m) => { console.error(m); process.exit(1); };

/** 找 Android SDK: 环境变量 → Windows 默认位置。返回 { platforms, buildTools } */
function findSdk() {
  const candidates = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'),
  ].filter(Boolean);
  for (const base of candidates) {
    const platforms = path.join(base, 'platforms');
    const buildTools = path.join(base, 'build-tools');
    if (fs.existsSync(platforms) && fs.existsSync(buildTools)) {
      return { platforms, buildTools };
    }
  }
  return null;
}

log('== uiaction dex 编译 ==');
const sdk = findSdk();
if (!sdk) {
  die(
    '! 找不到 Android SDK（需要 platforms/android-* 与 build-tools/*）。\n' +
    '  安装 Android Studio 命令行工具后重试, 或:\n' +
    '    ANDROID_SDK_ROOT=<sdk路径> node dsh/tools/build-uiaction.mjs',
  );
}

// android.jar: 取版本号最大的那个（API 越高反射目标越全; 源码只反射访问隐藏 API,
// 编译期只引用 android.accessibilityservice / android.view 等公开 API）
const platform = fs.readdirSync(sdk.platforms)
  .filter((d) => /^android-\d+$/.test(d))
  .sort((a, b) => Number(b.slice(8)) - Number(a.slice(8)))[0];
if (!platform) die(`! ${sdk.platforms} 下没有 android-* 平台`);
const androidJar = path.join(sdk.platforms, platform, 'android.jar');

// d8: 取版本号最大的 build-tools
const btVer = fs.readdirSync(sdk.buildTools)
  .filter((d) => /^\d+(\.\d+)*$/.test(d))
  .sort((a, b) => b.split('.').map(Number)[0] - a.split('.').map(Number)[0] || b.localeCompare(a))[0];
if (!btVer) die(`! ${sdk.buildTools} 下没有版本目录`);
const d8 = path.join(sdk.buildTools, btVer, process.platform === 'win32' ? 'd8.bat' : 'd8');
for (const f of [androidJar, d8]) {
  if (!fs.existsSync(f)) die(`! 缺 ${f}`);
}
log(`sdk: platform=${platform} build-tools=${btVer}`);

fs.mkdirSync(OUT, { recursive: true });
const classesDir = path.join(OUT, 'classes');
fs.rmSync(classesDir, { recursive: true, force: true });
fs.mkdirSync(classesDir, { recursive: true });

// 1. javac
const javaFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.java'));
if (!javaFiles.length) die(`! ${SRC} 里没有 .java 源文件`);
const jc = spawnSync('javac', [
  '--release', '8',
  '-classpath', androidJar,
  '-d', classesDir,
  '-encoding', 'UTF-8',
  ...javaFiles.map((f) => path.join(SRC, f)),
], { encoding: 'utf8' });
if (jc.status !== 0) die(`! javac 失败:\n${(jc.stdout || '') + (jc.stderr || '')}`);
const classFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.class')) classFiles.push(p);
  }
})(classesDir);
log(`javac: ${classFiles.length} 个 .class`);

// 2. d8 → classes.dex
// Windows 上 d8 是 .bat —— spawnSync 直接调 .bat 会 ENOENT/EINVAL（Node 需要经
// cmd.exe），所以 win32 走 shell: true；此时参数里的空格路径必须自己加引号。
const dexPath = path.join(OUT, 'classes.dex');
const d8Args = ['--release', '--lib', androidJar, '--output', OUT, ...classFiles];
const d8Opts = { encoding: 'utf8' };
let d8r;
if (process.platform === 'win32') {
  const q = (s) => (/[ ]/.test(s) ? `"${s}"` : s);
  d8r = spawnSync(`"${d8}"`, d8Args.map(q), { ...d8Opts, shell: true });
} else {
  d8r = spawnSync(d8, d8Args, d8Opts);
}
if (d8r.status !== 0) die(`! d8 失败:\n${(d8r.stdout || '') + (d8r.stderr || '')}`);
if (!fs.existsSync(dexPath)) die('! d8 声称成功但没有产出 classes.dex');

// 3. dex 魔数校验 —— "dex\n" 开头。弄错了真机上就是 ClassNotFound, 报错指不到这里。
const buf = fs.readFileSync(dexPath);
const magicOk = buf.length > 4 && buf[0] === 0x64 && buf[1] === 0x65 && buf[2] === 0x78 && buf[3] === 0x0a;
if (!magicOk) die(`! 产物不是合法 dex (magic=${buf.subarray(0, 4).toString('hex')})`);
const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
log(`  ✓ classes.dex: ${(buf.length / 1024).toFixed(1)} KiB  dex v${String.fromCharCode(buf[4])}  sha256:${sha}`);
log(`产出: ${path.relative(ROOT, dexPath)}`);
