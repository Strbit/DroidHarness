#!/usr/bin/env node
// build-hook-apk.mjs — 把 hook.dex 打成 LSPosed 可识别的最小 APK
//
// LSPosed 识别一个 Xposed 模块的要件:
//   1. AndroidManifest.xml 里 application 的 meta-data:
//      xposedmodule=true / xposeddescription / xposedminversion
//   2. assets/xposed_init 文件: 一行入口类名
//   3. APK 内含入口类的 dex
// 4. LSPosed 会把**已安装**的模块 APK 注册进作用域后, 在 system_server 里
//    加载它的 dex (从 APK 内读, 不是 assets 里的独立 dex —— 所以 hook.dex
//    要作为 APK 的一个 dex 文件打进根目录, 名字 classes.dex 或 classes2.dex)
//
// 本脚本用 build-tools 的 aapt2 + apksigner? 不 —— 签名用 debug keystore 太重;
// 实测 LSPosed 不校验签名, 但 pm install 需要**已签名** APK。所以:
//   aapt2 link 出未签名 APK (带 manifest) → zip 追加 dex/assets → apksigner 签名
// debug keystore 自动生成到 .build/hook-keystore.jks (首次)。
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readZip, writeZip } from './zip-repack.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, '.build', 'uiaction');
const BT = process.env.ANDROID_BUILD_TOOLS || findBuildTools();

function findBuildTools() {
  const base = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME
    || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
  const dir = path.join(base, 'build-tools');
  const ver = fs.readdirSync(dir).sort().pop();
  return path.join(dir, ver);
}

const die = (m) => { console.error(m); process.exit(1); };
const log = (m) => console.log(m);

const manifestSrc = path.join(HERE, 'hook-manifest.xml');
// ⚠ res 目录必须在仓库里（tools/hook-res），**不能放 .build/**：
//   它是 APK 的构建输入，放 gitignore 目录里会让新克隆的仓库编不出 APK。
//   （同类问题踩过一次：Xposed 的编译期 stub 原先也在 .build/ 里，见
//     recognize/uiaction/hook/stub/ 的注释。）
//   目前它只声明 xposed_scope（LSPosed 作用域），见 hook-res/values/arrays.xml。
const resDir = path.join(HERE, 'hook-res');
const hookDex = path.join(OUT, 'hook.dex');
for (const f of [manifestSrc, hookDex, resDir]) if (!fs.existsSync(f)) die(`! 缺 ${f}`);
for (const tool of ['aapt2.exe', 'aapt2', 'apksigner.bat', 'apksigner']) {
  if (fs.existsSync(path.join(BT, tool))) continue;
}
const aapt2 = fs.existsSync(path.join(BT, 'aapt2.exe')) ? path.join(BT, 'aapt2.exe') : path.join(BT, 'aapt2');
const apksigner = fs.existsSync(path.join(BT, 'apksigner.bat')) ? path.join(BT, 'apksigner.bat') : path.join(BT, 'apksigner');
log(`aapt2: ${aapt2}`);

// 1. aapt2 compile res + link manifest → base.apk
const work = path.join(OUT, 'apk-work');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const flat = path.join(work, 'flat');
fs.mkdirSync(flat, { recursive: true });
execSync(`"${aapt2}" compile --dir "${resDir}" -o "${flat}"`, { stdio: 'inherit' });
const baseApk = path.join(work, 'base.apk');
const flats = fs.readdirSync(flat).filter((f) => f.endsWith('.flat')).map((f) => path.join(flat, f));
execSync(`"${aapt2}" link -o "${baseApk}" --manifest "${manifestSrc}" -I "${androidJarFor()}" ${flaps_q(flats)}`, { cwd: work, stdio: 'inherit' });
function flaps_q(files) { return files.map((f) => `"${f}"`).join(' '); }function androidJarFor() {
  const platforms = path.join(path.dirname(path.dirname(BT)), 'platforms');
  const ver = fs.readdirSync(platforms).sort().pop();
  return path.join(platforms, ver, 'android.jar');
}

// 2. 追加 dex + assets, 并**保证 resources.arsc 不被压缩**
//
// ⚠ 这里曾经用 `jar uf` 追加入口, 结果装不上:
//   Failure [-124: Failed parse during installPackageLI: Targeting R+ (version 30
//   and above) requires the resources.arsc of installed APKs to be stored
//   uncompressed and aligned on a 4-byte boundary]
//   原因: jar 重写归档时把 aapt2 原本 stored 的 resources.arsc 一并 deflate 了。
//   修法: 自己读写 zip(见 zip-repack.mjs), 逐条目控制压缩方式;
//        再用 build-tools 的 zipalign -p 4 做对齐。
const packedApk = path.join(work, 'packed.apk');
{
  const entries = readZip(baseApk).map((e) => ({ name: e.name, data: e.data }));
  entries.push({ name: 'classes.dex', data: fs.readFileSync(hookDex) });
  entries.push({
    name: 'assets/xposed_init',
    data: Buffer.from('com.dsh.hook.DshHookEntry\n'),
  });
  // 这两个必须 stored: Android 11+ 对 resources.arsc 有硬要求;
  // AndroidManifest.xml 一并 stored 更稳(体积几 KB, 不值当省)。
  writeZip(packedApk, entries, ['resources.arsc', 'AndroidManifest.xml']);
}

// 2b. 4 字节对齐 (Android 11+ 要求 resources.arsc 对齐; -p 顺带页对齐 .so)
const zipalign = fs.existsSync(path.join(BT, 'zipalign.exe'))
  ? path.join(BT, 'zipalign.exe') : path.join(BT, 'zipalign');
const alignedApk = path.join(work, 'aligned.apk');
fs.rmSync(alignedApk, { force: true });
execSync(`"${zipalign}" -p -f 4 "${packedApk}" "${alignedApk}"`, { stdio: 'inherit' });

// 2c. 自检: resources.arsc 必须是 stored(方式 0), 否则装机必失败
{
  const arsc = readZip(alignedApk).find((e) => e.name === 'resources.arsc');
  if (!arsc) die('! 打包后找不到 resources.arsc');
  if (arsc.method !== 0) {
    die(`! resources.arsc 压缩方式=${arsc.method}, 必须为 0(stored) —— Android 11+ 会拒装`);
  }
  log(`  resources.arsc: stored ✓  ${arsc.data.length} B`);
}

// 2d. 自检: LSPosed 作用域必须**真的编进 APK**, 且与 customize.sh 注册的一致
//
// ⚠ 这道自检要防的是"改了声明但 APK 没重建"这个**构建编排**问题, 不是
//   arrays.xml 本身写错(那是 Edit 时就该看出来的)。实测踩到: `build-uiaction.mjs`
//   原先只把 OUT 里**已有的** APK 复制进模块, 不重新构建 —— 改了 hook-res 之后
//   跑它, 会拿旧 APK 打一个 ✓。真相是 `aapt2 dump resources` 里 scope 仍是
//   `size=1 ["android"]`(期望 3 项)。
//
//   所以这里: ① dump 出 APK 里真实的数组; ② 与**期望集合**比对(不是与刚读的
//   arrays.xml 比 —— 那样在同一个构建里必然相等, 是个假自检)。
//   期望集合同时要和 customize.sh 里写进 LSPosed 数据库的那三个 scope 一致。
{
  const EXPECTED_SCOPES = ['android', 'system', 'com.android.systemui'];
  let dump = '';
  try {
    dump = execSync(`"${aapt2}" dump resources "${alignedApk}"`, { encoding: 'utf8' });
  } catch (e) {
    die(`! aapt2 dump resources 失败, 无法校验作用域: ${e.message}`);
  }
  const got = [...dump.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    .filter((s) => !s.includes('/') && s !== 'array' && s !== 'xposed_scope');
  const missing = EXPECTED_SCOPES.filter((w) => !got.includes(w));
  const extra = got.filter((s) => !EXPECTED_SCOPES.includes(s) && /^[a-z][a-z0-9._]*$/i.test(s));
  if (missing.length) {
    die(`! APK 里的 xposed_scope 缺项: ${missing.join(', ')}\n` +
        `    期望: ${JSON.stringify(EXPECTED_SCOPES)}\n    实际: ${JSON.stringify(got)}\n` +
        `    (记得同步 dsh/tools/hook-res/values/arrays.xml 与 customize.sh 的 scope 注册)`);
  }
  if (extra.length) {
    die(`! APK 里的 xposed_scope 有多余项: ${extra.join(', ')}\n    实际: ${JSON.stringify(got)}`);
  }
  if (got.length !== EXPECTED_SCOPES.length) {
    die(`! APK 里的 xposed_scope 项数不对: 期望 ${EXPECTED_SCOPES.length}, 实得 ${got.length} (${JSON.stringify(got)})`);
  }
  log(`  xposed_scope: ${JSON.stringify(got)} ✓ (已编进 APK, 与 customize.sh 注册的 3 个一致)`);
}

// 3. 签名 (debug keystore 自动生成)
const ks = path.join(ROOT, '.build', 'hook-keystore.jks');
if (!fs.existsSync(ks)) {
  log('生成调试 keystore...');
  execSync(`keytool -genkeypair -keystore "${ks}" -alias dshhook -keyalg RSA -keysize 2048 -validity 10000 -storepass dshhook -keypass dshhook -dname "CN=dsh-hook"`, { stdio: 'inherit' });
}
const signedApk = path.join(OUT, 'dsh-hook.apk');
fs.rmSync(signedApk, { force: true });
execSync(`"${apksigner}" sign --ks "${ks}" --ks-pass pass:dshhook --key-pass pass:dshhook --out "${signedApk}" "${alignedApk}"`, { stdio: 'inherit' });
log(`  ✓ ${path.relative(ROOT, signedApk)} (${(fs.statSync(signedApk).size / 1024).toFixed(1)} KiB)`);
