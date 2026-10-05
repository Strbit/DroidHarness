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
import { spawnSync, execFileSync } from 'node:child_process';
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
// 注意: d8 输出文件名固定 classes.dex, 多个 dex 要依次编并**改名保留**。
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

// ── 2b. hook dex (Xposed 模块入口, LSPosed 加载) ──────────────────────
// **先编 hook 再编主 dex**: d8 --output 目录的产物名固定 classes.dex, 后编的
// 会覆盖先编的 —— hook 编完立即改名 hook.dex, 主 dex 最后编就是最终名。
const HOOK_SRC = path.join(ROOT, 'recognize', 'uiaction', 'hook');
// 编译期 stub 必须**跟源码在一起**（放 .build/ 会被 gitignore 掉，新克隆的仓库
// 直接编不出 hook —— 实测踩过）。STUB 是 HOOK_SRC 的子目录，所以下面枚举
// hook 源码时要把它排除，否则 stub 会被当成 hook 源码一起编进去（重复类）。
const STUB = path.join(HOOK_SRC, 'stub');
if (!fs.existsSync(STUB)) die(`! 缺编译期 stub: ${STUB}（它是仓库文件，不该缺失）`);
const hookClassesDir = path.join(OUT, 'hook-classes');
fs.rmSync(hookClassesDir, { recursive: true, force: true });
fs.mkdirSync(hookClassesDir, { recursive: true });
const hookFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (p !== STUB) walk(p); }
    else if (e.name.endsWith('.java')) hookFiles.push(p);
  }
})(HOOK_SRC);
if (hookFiles.length) {
  const stubJar = path.join(OUT, 'xposed-stub.jar');
  // stub 先编成 jar (javac 不能直接吃源码目录做 classpath)
  const stubDir = path.join(OUT, 'stub-classes');
  fs.rmSync(stubDir, { recursive: true, force: true });
  fs.mkdirSync(stubDir, { recursive: true });
  const stubFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.java')) stubFiles.push(p);
    }
  })(STUB);
  const sj = spawnSync('javac', ['--release', '8', '-encoding', 'UTF-8', '-d', stubDir, ...stubFiles], { encoding: 'utf8' });
  if (sj.status !== 0) die(`! stub javac 失败:\n${(sj.stdout || '') + (sj.stderr || '')}`);
  // jar 工具 (JDK 自带) 打包 stub
  const jr = spawnSync('jar', ['cf', stubJar, '-C', stubDir, 'de'], { encoding: 'utf8' });
  if (jr.status !== 0) die(`! jar 失败:\n${(jr.stdout || '') + (jr.stderr || '')}`);
  const jc2 = spawnSync('javac', [
    '--release', '8',
    '-classpath', `${androidJar}${path.delimiter}${stubJar}`,
    '-d', hookClassesDir,
    '-encoding', 'UTF-8',
    ...hookFiles,
  ], { encoding: 'utf8' });
  if (jc2.status !== 0) die(`! hook javac 失败:\n${(jc2.stdout || '') + (jc2.stderr || '')}`);
  const hookClassFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.class')) hookClassFiles.push(p);
    }
  })(hookClassesDir);
  // hook 的 classes 目录独立产出, 不与主 dex 同目录 —— 免覆盖
  const hookOut = path.join(OUT, 'hook-out');
  fs.rmSync(hookOut, { recursive: true, force: true });
  fs.mkdirSync(hookOut, { recursive: true });
  let hr;
  if (process.platform === 'win32') {
    const q = (s) => (/[ ]/.test(s) ? `"${s}"` : s);
    hr = spawnSync(`"${d8}"`, ['--release', '--lib', androidJar, '--output', hookOut, ...hookClassFiles.map(q)], { ...d8Opts, shell: true });
  } else {
    hr = spawnSync(d8, ['--release', '--lib', androidJar, '--output', hookOut, ...hookClassFiles], d8Opts);
  }
  if (hr.status !== 0) die(`! hook d8 失败:\n${(hr.stdout || '') + (hr.stderr || '')}`);
  const hookDex = path.join(OUT, 'hook.dex');
  fs.copyFileSync(path.join(hookOut, 'classes.dex'), hookDex);
  const hb = fs.readFileSync(hookDex);
  if (!(hb.length > 4 && hb[0] === 0x64 && hb[1] === 0x65 && hb[2] === 0x78 && hb[3] === 0x0a)) {
    die('! hook.dex 不是合法 dex');
  }
  log(`  ✓ hook.dex: ${(hb.length / 1024).toFixed(1)} KiB`);

  // hook APK: LSPosed 模块的载体 (Xposed 模块必须是已安装的 APK)。
  // 装进模块的 apk/ 目录, customize.sh 装机时 pm install + 注册作用域。
  //
  // ⚠⚠ 必须**真的调 build-hook-apk.mjs 重新构建**, 不能只"复制 OUT 里已有的"。
  //   原先那段是 `if (existsSync(OUT/dsh-hook.apk)) copyFileSync(...)` —— 于是
  //   改了 `tools/hook-res/values/arrays.xml`(LSPosed 作用域声明)之后跑本脚本,
  //   它会把**上一轮的旧 APK** 复制进模块并打一个 ✓, 让人以为改动生效了。
  //   实测踩到: 把 scope 从 [android] 改成 [android,system,systemui] 后跑本脚本,
  //   `aapt2 dump resources` 显示模块里的 APK 仍是 `size=1 ["android"]`。
  //   所以这里改成调用构建脚本(它自己会读 hook-res 并做 arsc stored 自检)。
  const apkOut = path.join(ROOT, 'dsh', 'module', 'apk');
  fs.mkdirSync(apkOut, { recursive: true });
  const apkDst = path.join(apkOut, 'dsh-hook.apk');
  try {
    const builder = path.join(HERE, 'build-hook-apk.mjs');
    execFileSync(process.execPath, [builder], { stdio: 'inherit' });
    const apkSrc = path.join(OUT, 'dsh-hook.apk');
    if (!fs.existsSync(apkSrc)) {
      die(`! build-hook-apk.mjs 跑完了但没有产出 ${path.relative(ROOT, apkSrc)}`);
    }
    fs.copyFileSync(apkSrc, apkDst);
    log(`  ✓ apk/dsh-hook.apk: ${(fs.statSync(apkDst).size / 1024).toFixed(1)} KiB (装机时 pm install + 注册 LSPosed)`);
  } catch (e) {
    // 构建失败要**响亮地失败**, 不能只 log 一行 ! 然后当作成功继续 ——
    // 装机包里的 APK 是旧的, 而现象是"scope 没生效"这类极难归因的问题。
    die(`! hook APK 构建/复制失败: ${e.message}`);
  }
}
log(`产出: ${path.relative(ROOT, dexPath)}`);
