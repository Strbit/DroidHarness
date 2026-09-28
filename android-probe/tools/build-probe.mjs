#!/usr/bin/env node
// build-probe -- 把 android-probe/src/*.java 编成可被 app_process 跑的 dex
//
// 为什么需要这个脚本（而不是文档里写一遍手工命令）
// ----------------------------------------------
// 探针是 Java 而不是 JS，必须有一步 javac -> d8 的构建。手工命令的问题是：
//   · 参数多且都必需（-bootclasspath / --min-api / -encoding），漏一个就出怪错
//   · `javac -encoding` 漏了会按系统默认码页读源码 —— 中文注释直接编译失败
//   · android.jar 里**没有** @hide API，所以源码里的反射不是可选写法而是必须
// 把它固化成脚本，构建就是一条命令，CI 也能直接调。
//
// 用法:
//   node android-probe/tools/build-probe.mjs
//   node android-probe/tools/build-probe.mjs --out <dir>
//
// 依赖（都在环境变量或默认位置找）:
//   JAVA_HOME 或 PATH 里的 javac / java
//   ANDROID_SDK_ROOT 或 ANDROID_HOME 或 --sdk <dir>，其下有
//     platforms/android-<N>/android.jar 与 build-tools/<ver>/d8
//
// 产物: <out>/classes.dex（默认 android-probe/dist/）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE_ROOT = path.resolve(HERE, '..');
const SRC_DIR = path.join(PROBE_ROOT, 'src');

// ── 参数 ────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const OUT_DIR = path.resolve(arg('--out', path.join(PROBE_ROOT, 'dist')));
const MIN_API = Number(arg('--min-api', '30'));   // Android 11；getWindowsOnAllDisplays 是 API 30+
const SDK_ARG = arg('--sdk', null);
const KEEP_INTERMEDIATE = argv.includes('--keep-intermediate');

// ── 找 JDK ──────────────────────────────────────────────────
function findJdk() {
  const cands = [];
  if (process.env.JAVA_HOME) cands.push(process.env.JAVA_HOME);
  // PATH 里找 javac（Windows 上是 javac.exe）
  for (const p of (process.env.PATH || '').split(path.delimiter)) {
    if (!p) continue;
    cands.push(path.resolve(p, '..'));
  }
  for (const c of cands) {
    for (const exe of ['javac.exe', 'javac']) {
      const p = path.join(c, 'bin', exe);
      if (fs.existsSync(p)) return { javac: p, java: path.join(c, 'bin', exe === 'javac.exe' ? 'java.exe' : 'java') };
    }
  }
  return null;
}

// ── 找 Android SDK ──────────────────────────────────────────
function findSdk() {
  const roots = [SDK_ARG, process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk')]
    .filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    // android.jar：取版本号最大的 platforms/android-*
    const pf = path.join(root, 'platforms');
    let androidJar = null;
    if (fs.existsSync(pf)) {
      const vers = fs.readdirSync(pf)
        .filter((d) => /^android-\d+$/.test(d))
        .sort((a, b) => Number(b.slice(8)) - Number(a.slice(8)));
      for (const v of vers) {
        const j = path.join(pf, v, 'android.jar');
        if (fs.existsSync(j)) { androidJar = j; break; }
      }
    }
    // d8：取版本号最大的 build-tools/*
    const bt = path.join(root, 'build-tools');
    let d8jar = null;
    let d8bat = null;
    if (fs.existsSync(bt)) {
      const vers = fs.readdirSync(bt).sort((a, b) => {
        const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
        for (let i = 0; i < 3; i++) if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
        return 0;
      });
      for (const v of vers) {
        // 优先 d8.jar：可以直接 `java -cp` 调，**避开 .bat 与 shell:true**。
        // 用 .bat 时 Node 必须开 shell，会触发 DEP0190 弃用警告
        // （"Passing args to a child process with shell option true ...
        //   arguments are not escaped"）—— 参数本来是我们自己拼的，
        //  但没有 shell 就没有这类隐患，也能正确处理路径里的空格。
        const jar = path.join(bt, v, 'lib', 'd8.jar');
        if (!d8jar && fs.existsSync(jar)) d8jar = jar;
        for (const exe of ['d8.bat', 'd8']) {
          const p = path.join(bt, v, exe);
          if (!d8bat && fs.existsSync(p)) d8bat = p;
        }
        if (d8jar && d8bat) break;
      }
    }
    if (androidJar && (d8jar || d8bat)) return { root, androidJar, d8jar, d8bat };
  }
  return null;
}

// ── 前置检查 ────────────────────────────────────────────────
console.log('═══ 构建 android-probe ═══');
const sources = fs.existsSync(SRC_DIR)
  ? fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.java'))
  : [];
if (!sources.length) {
  console.error(`✗ ${SRC_DIR} 下没有 .java 源文件`);
  process.exit(1);
}
console.log(`  源文件: ${sources.join(', ')}`);

// ── 先验证输出目录**真的可写** ──────────────────────────────
// javac 写不出去时报的是 `error while writing X.class` —— 一个看起来像编译错误、
// 实际是环境权限问题的信息。实测（受控矩阵）：
//     A 绝对 -d, cwd 同盘          OK
//     B 相对 -d, cwd=输出目录(同盘)  OK
//     C 绝对 -d, cwd=项目盘         OK
//     D 相对 -d, 输出目录在项目盘     FAIL
//     E 输出到 %TEMP%              FAIL
// 结论：**与 javac 参数无关，是写入位置**。所以这里先探一次，
// 失败时直接说"目录不可写 + 怎么换成别的"，而不是把 javac 的原话抛出去让人误解。
function ensureWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return null;
  } catch (e) {
    return e.message;
  }
}
const writeErr = ensureWritable(OUT_DIR);
if (writeErr) {
  console.error(`✗ 输出目录不可写: ${OUT_DIR}\n  ${writeErr}\n` +
    `  用 --out <dir> 换一个可写目录（例如仓库外的临时位置）。`);
  process.exit(1);
}

const jdk = findJdk();
if (!jdk) {
  console.error('✗ 找不到 javac。设置 JAVA_HOME，或把 JDK 的 bin 加进 PATH。');
  process.exit(1);
}
console.log(`  javac : ${jdk.javac}`);

const sdk = findSdk();
if (!sdk) {
  console.error('✗ 找不到 Android SDK（需要 platforms/android-*/android.jar 与 build-tools/*/d8）。\n' +
    '  用 --sdk <dir> 指定，或设置 ANDROID_SDK_ROOT / ANDROID_HOME。');
  process.exit(1);
}
console.log(`  SDK   : ${sdk.root}`);
console.log(`  android.jar: ${sdk.androidJar}`);
console.log(`  d8    : ${sdk.d8jar || sdk.d8bat}${sdk.d8jar ? "  (java -cp)" : "  (直接执行)"}`);
console.log(`  min-api: ${MIN_API}`);

// ── 编译 ────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
// ⚠️ 实测踩到的坑：**跨盘 cwd 会让 Windows 找不到 exe**
// ------------------------------------------------------------
// 受控矩阵（本机 D 盘是项目盘，JDK/SDK 在 C 盘）：
//     A 绝对 -d, cwd 同盘              OK
//     B 相对 -d, cwd=输出目录(同盘)      OK
//     C 绝对 -d, cwd=项目盘(D)          OK   <- 用这个
//     D 相对 -d, cwd=输出目录(D盘)       FAIL（javac 写不出 .class）
//     E 输出到 %TEMP%                  FAIL（javac 写不出 .class）
//     F cwd=D盘 + 绝对 exe(在 C 盘)      FAIL ENOENT（跨盘找不到 exe）
//
// 所以正确形态是：**cwd 保持默认**（别切盘），**输出目录用绝对路径**。
// 输出目录本身必须落在当前环境允许写入的位置 —— 见上面的 ensureWritable 探测。
const CLASS_DIR = path.join(OUT_DIR, KEEP_INTERMEDIATE ? 'classes' : '_classes');
fs.mkdirSync(CLASS_DIR, { recursive: true });
try {
  console.log('\n── javac ──');
  // `-encoding UTF-8` 是**必须**的：漏了会按系统默认码页读源码，
  // 中文注释直接编译失败（Windows 上是 GBK）。
  execFileSync(jdk.javac, [
    '-encoding', 'UTF-8',
    '-source', '8', '-target', '8',
    '-bootclasspath', sdk.androidJar,
    '-nowarn',
    '-d', CLASS_DIR,
    ...sources.map((f) => path.join(SRC_DIR, f)),
  ], { stdio: 'inherit' });
  const classes = fs.readdirSync(CLASS_DIR).filter((f) => f.endsWith('.class'));
  console.log(`  ✓ 产出 ${classes.length} 个 .class: ${classes.join(', ')}`);

  console.log('\n── d8 ──');
  // 优先 `java -cp d8.jar com.android.tools.r8.D8`：不经 shell，参数不会被拼接
  // （路径带空格也安全）。找不到 jar 时退回 d8 可执行文件（Windows 上是 .bat，必须开 shell）。
  if (sdk.d8jar) {
    execFileSync(jdk.java, [
      '-cp', sdk.d8jar, 'com.android.tools.r8.D8',
      '--min-api', String(MIN_API),
      '--output', CLASS_DIR,
      ...classes.map((f) => path.join(CLASS_DIR, f)),
    ], { stdio: 'inherit' });
  } else {
    const env = { ...process.env };
    if (!env.JAVA_HOME) env.JAVA_HOME = path.resolve(path.dirname(jdk.javac), '..');
    env.PATH = `${path.dirname(jdk.java)}${path.delimiter}${env.PATH || ''}`;
    execFileSync(sdk.d8bat, [
      '--min-api', String(MIN_API),
      '--output', CLASS_DIR,
      ...classes.map((f) => path.join(CLASS_DIR, f)),
    ], { stdio: 'inherit', env, shell: process.platform === 'win32' });
  }

  const dexSrc = path.join(CLASS_DIR, 'classes.dex');
  if (!fs.existsSync(dexSrc)) {
    console.error('✗ d8 跑完但没有 classes.dex');
    process.exit(1);
  }
  const dex = path.join(OUT_DIR, 'classes.dex');
  if (path.resolve(dexSrc) !== path.resolve(dex)) fs.copyFileSync(dexSrc, dex);
  console.log(`  ✓ ${dex}  (${fs.statSync(dex).size} B)`);

  // ── 交付位置（与 recognize 的部署约定一致：DSH_HOME/tools/probe/）──
  console.log('\n═══ 完成 ═══');
  console.log(`  产物: ${dex}`);
  console.log('  部署到设备（需要 root）:');
  console.log('    adb push android-probe/dist/classes.dex /data/local/tmp/probe.dex');
  console.log('    adb shell su -c \'mkdir -p /data/adb/dsh/tools/probe && \\');
  console.log('      cp /data/local/tmp/probe.dex /data/adb/dsh/tools/probe/classes.dex && \\');
  console.log('      chmod 644 /data/adb/dsh/tools/probe/classes.dex\'');
  console.log('  跑一次:');
  console.log('    adb shell su -c \'CLASSPATH=/data/adb/dsh/tools/probe/classes.dex \\');
  console.log('      app_process /system/bin Displays\'');
} finally {
  if (!KEEP_INTERMEDIATE) {
    try { fs.rmSync(CLASS_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}
