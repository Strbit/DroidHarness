// 在 Git for Windows 的 sh 下实测 customize.sh 的屏幕识别布署段。
//
// 诚实说明覆盖范围
// ----------------
//   · T1~T5 测**布署段**：find 驱动的逐文件拷贝、相对路径提取、数量复核、执行位、幂等。
//   · T6 测 **§7 接入段**：flag 怎么传、STATUS 怎么从输出里抠、六种状态各印什么、
//     SM_OK=0 时该不该动。跑的是**真 register-screen-mcp.mjs + 真宿主 node**。
//   · T7 测 **uninstall.sh**：装→卸→重装可逆、只动标记之间、残留必须是 `[]`。
//   · 段都是从 customize.sh / 模块目录里**原样抽出**跑的，不是手抄一份 —— 手抄的话
//     测的是抄的那份，改源就测不到了。
//   · 替换过的只有三处，且全是**变量赋值**，没改过一行逻辑: §7 的 `run_node` 桩
//     (转宿主 node)、T7 的 `NODE=` 与 `DSH_HOME_DIR=`（理由写在那里）。
//   · ⚠ cp/find/chmod 这里是 GNU 实现，不是 Android 的 toybox。**这排除不了
//     "toybox 行为不同"的风险** —— 真机验证仍然必须做。
//
// 一个踩过的坑（别再踩）
// ---------------------
// 第一版把沙箱路径（含反斜杠的 D:\...）塞进 case 模式，于是断言"永远不匹配"，
// T2 全部 FAIL —— 而报错信息看着像"路径相等"。原因：case 的模式经 fnmatch，
// `\` 是转义符，`D:\projects` 的模式实际匹配 `D:projects`。所以下面统一用
// 正斜杠路径。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = 'D:/projects/DroidHarness';
const SH = 'C:/Program Files/Git/bin/sh.exe';
// 全程正斜杠拼接: path.join 在 Windows 上给反斜杠, 而反斜杠进 sh 的 case 模式
// 会被 fnmatch 当转义符吃掉(见文件头)。Node 的 fs 也接受正斜杠, 两头都能用。
const j = (...p) => p.join('/').replace(/\/{2,}/g, '/');
const CUST = j(ROOT, 'dsh', 'module', 'customize.sh');
const SANDBOX = j(ROOT, '.build', 'sh-deploy-test');

fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });

// ── 从 customize.sh 里真实抽出布署段 ──
const src = fs.readFileSync(CUST, 'utf8');
const start = src.indexOf('if [ "$HAS_SCREEN_MCP" = "1" ]; then');
const end = src.indexOf('# ── webroot/ 故意**不在这里出现**');
if (start < 0 || end < 0 || end <= start) throw new Error('抽不到布署段，结构变了');
const block = src.slice(start, end);
for (const need of ['rm -rf "$SM_TOOLS_DST"', 'find "$SM_TOOLS_SRC" -type f', 'chmod -R 0755 "$SM_TOOLS_DST"']) {
  if (!block.includes(need)) throw new Error(`抽到的段里没有 ${need} —— 抽取范围不对`);
}
// 正斜杠的沙箱落点，替换掉硬编码的字面量（只替换字面量，逻辑一字不动）
const blockSandbox = block.replaceAll('/data/adb/dsh/tools', `${SANDBOX}/tools`);
if (blockSandbox.includes('/data/adb/dsh/tools')) throw new Error('字面量没替换干净');
// 只核**路径**里没有反斜杠。上一版核的是整段文本, 结果被 sh 里合法的
// `tr -d ' \n'` 触发 —— 那个反斜杠属于脚本内容，fnmatch 根本碰不到它。
if (SANDBOX.includes('\\')) throw new Error('沙箱路径含反斜杠，case 模式会被 fnmatch 吃掉');

let pass = 0, fail = 0;
const fails = [];
function check(n, c, d = '') {
  if (c) { pass++; console.log(`  [OK]   ${n}`); }
  else { fail++; fails.push(n); console.log(`  [FAIL] ${n}${d ? `\n           ${String(d).split('\n').filter((x) => x.trim()).slice(0, 6).join('\n           ')}` : ''}`); }
}

/** 跑一次布署。blockText 决定用原始段还是沙箱段。 */
function deployRun(name, vars, blockText = blockSandbox) {
  const f = j(SANDBOX, `${name}.sh`);
  fs.writeFileSync(f, [
    'ui_print() { echo "UI| $*"; }',
    ...Object.entries(vars).map(([k, v]) => `${k}='${v}'`),
    'set -u',
    blockText,
    'echo "RC| $?"',
  ].join('\n'), 'utf8');
  const r = spawnSync(SH, [f], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const show = (out) => {
  for (const l of out.split('\n').filter((x) => x.startsWith('UI|') || x.startsWith('RC|'))) console.log('     ' + l);
};
// ⚠ 正例必须都用同一个 dst (= 替换后 case 模式那个值)。
// 上一版给 T3/T4 各造了 tools3/tools4, 于是**断言分支**先拦住了布署,
// 报出"路径异常" —— 三个失败全是 harness 的错，跟被测逻辑无关。
// 断言按设计就是只认一个固定路径；要测布署逻辑就得用那个路径。
const DST = j(SANDBOX, 'tools');
const cleanDst = () => fs.rmSync(DST, { recursive: true, force: true });

// ── T1: 用**未经修改的原始段**测路径断言 ──
// 不改模式、不改代码，只是把 SM_TOOLS_DST 指到沙箱 —— 真实的那条
// `case ... in /data/adb/dsh/tools)` 必然不匹配，于是应当拒绝布署。
// 这比"把模式改成 __IMPOSSIBLE__"强：后者测的是我改过的东西。
console.log('=== T1 路径前缀断言（跑原始段，不篡改） ===');
const evil = j(SANDBOX, 'evil/tools');
fs.mkdirSync(evil, { recursive: true });
fs.writeFileSync(j(evil, 'MUST_SURVIVE'), 'keep me\n', 'utf8');
const t1 = deployRun('t1', {
  HAS_SCREEN_MCP: '1',
  SM_TOOLS_SRC: `${SANDBOX}/real-mod`,
  SM_TOOLS_DST: `${SANDBOX}/evil/tools`,
  SM_N: '8',
}, block); // ← 原始段
show(t1.out);
check('异常路径 → 报 FAIL 并跳过布署', /tools 目标路径异常/.test(t1.out), t1.out);
check('  MUST_SURVIVE 还在（确实没执行 rm -rf）', fs.existsSync(j(evil, 'MUST_SURVIVE')));
check('  没有真的建出布署目录', !fs.existsSync(j(evil, 'screen-mcp.mjs')));

// ── T2: 正常布署（源 = 模块里那份真实 tools/） ──
console.log('');
console.log('=== T2 正常布署 ===');
const realMod = j(SANDBOX, 'real-mod');
fs.cpSync(j(ROOT, 'dsh', 'module', 'tools'), realMod, { recursive: true });
cleanDst();
const t2 = deployRun('t2', {
  HAS_SCREEN_MCP: '1',
  SM_TOOLS_SRC: `${SANDBOX}/real-mod`,
  SM_TOOLS_DST: `${DST}`,
  SM_N: '8',
});
show(t2.out);
const walkF = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walkF(j(d, e.name)) : [j(d, e.name)]);
check('布署报 OK 且数量对', /屏幕识别已布署 \(8 个文件/.test(t2.out), t2.out);
check('启动器落在 <dst>/screen-mcp，不是 <dst>/tools/screen-mcp', fs.existsSync(j(DST, 'screen-mcp')));
check('  没有多出一层 tools/（这正是 dir/. 写法的风险）', !fs.existsSync(j(DST, 'tools')));
check('lib/ 下 5 个 mjs 全部落地', ['uitree', 'fields', 'spawn-env', 'displays', 'cmd-display'].every((n) => fs.existsSync(j(DST, 'lib', `${n}.mjs`))));
check('patch 模板也在', fs.existsSync(j(DST, 'cordis.patch.example.yml')));
check('screen-mcp.mjs 内容与源逐字节一致', fs.readFileSync(j(DST, 'screen-mcp.mjs')).equals(fs.readFileSync(j(realMod, 'screen-mcp.mjs'))));
check('落地文件一个 CR 都没有', walkF(DST).every((f) => !fs.readFileSync(f).includes(0x0d)));
check('落地文件数 = 8（cp 没漏）', walkF(DST).length === 8, `实际 ${walkF(DST).length}`);
// 布署段自己的复核有没有说"可执行" —— 测的是**脚本的判断**，不是 NTFS 的位。
check('布署段的 -x 复核判定可执行', /screen-mcp 可执行/.test(t2.out), t2.out);
// ⚠ 不在这条路径上断言 Unix 执行位: NTFS 没有 x 位，Git 的 chmod 把它丢弃
//   (实测 chmod 0755 之后 statSync().mode = 0o666)。断它必然红，而红了也不
//   说明 Android 上错。执行位的真验证是: zip 里 mode=0755(已由 verify-zip-tools
//   核过) + 设备上 ls -l。这里留话，不做假断言、也不静默跳过。
console.log('  [SKIP] Unix 执行位 —— NTFS 表达不了；由 zip 核验 + 真机 ls -l 负责');

// ── T3: 复核分支必须会报 FAIL（不是摆设） ──
console.log('');
console.log('=== T3 声称 8 个 / 只落地 7 个：数量复核必须报 FAIL ===');
// 说明: 这是**直接触发复核分支**（SM_N 传 8、源里只放 7 个文件），
// 真实机型上对应"某个 cp 失败"(权限/满盘)。customize.sh 里 SM_N 是从源
// find 出来的，所以端到端要构造出这个不一致需要让 cp 本身失败，本机做不到。
const halfMod = j(SANDBOX, 'half-mod');
fs.cpSync(j(ROOT, 'dsh', 'module', 'tools'), halfMod, { recursive: true });
fs.rmSync(j(halfMod, 'lib', 'fields.mjs'));
cleanDst();
const t3 = deployRun('t3', {
  HAS_SCREEN_MCP: '1',
  SM_TOOLS_SRC: `${SANDBOX}/half-mod`,
  SM_TOOLS_DST: `${DST}`,
  SM_N: '8',
});
show(t3.out);
check('数量不符 → 报 FAIL', /布署后只有 7 个文件，模块里是 8 个/.test(t3.out), t3.out);
check('  并明确警告工具缺失', /mcp__screen__\* 工具会缺失/.test(t3.out));
check('  不许出现"已布署"这种成功字样', !/屏幕识别已布署/.test(t3.out));

// ── T4: 幂等 —— 上一版已删除的模块不许留在设备上 ──
console.log('');
console.log('=== T4 升级：陈旧残留必须被清掉 ===');
fs.mkdirSync(j(DST, 'lib'), { recursive: true });
fs.writeFileSync(j(DST, 'lib', 'gone-in-new-version.mjs'), 'export const stale = 1;\n', 'utf8');
fs.writeFileSync(j(DST, 'screen-mcp'), '#!/system/bin/sh\n# 上一版\n', 'utf8');
const t4 = deployRun('t4', {
  HAS_SCREEN_MCP: '1',
  SM_TOOLS_SRC: `${SANDBOX}/real-mod`,
  SM_TOOLS_DST: `${DST}`,
  SM_N: '8',
});
show(t4.out);
check('陈旧文件被清除', !fs.existsSync(j(DST, 'lib', 'gone-in-new-version.mjs')));
check('陈旧 screen-mcp 被新版覆盖', fs.readFileSync(j(DST, 'screen-mcp'), 'utf8').includes('find_node'));
check('  新文件齐全（8 个）', walkF(DST).length === 8, `实际 ${walkF(DST).length}`);
check('  重跑仍然报 OK（幂等）', /屏幕识别已布署 \(8 个文件/.test(t4.out));

// ── T5: 模块里没有 tools/ 时这段应当完全不执行 ──
console.log('');
console.log('=== T5 HAS_SCREEN_MCP=0（缺 screen-mcp 的包）：不许动目标目录 ===');
const dst5 = j(SANDBOX, 'tools5');
fs.mkdirSync(dst5, { recursive: true });
fs.writeFileSync(j(dst5, 'user-own-file'), 'mine\n', 'utf8');
const t5 = deployRun('t5', {
  HAS_SCREEN_MCP: '0',
  SM_TOOLS_SRC: `${SANDBOX}/real-mod`,
  SM_TOOLS_DST: `${SANDBOX}/tools5`,
  SM_N: '0',
});
check('未布署时用户已有文件安然无恙', fs.existsSync(j(dst5, 'user-own-file')), '整段被 rm 掉了?');
check('  且没有创建任何新文件', walkF(dst5).length === 1, `${walkF(dst5).length}`);
check('  且没有输出布署日志（不该假装成功）', !/屏幕识别已布署/.test(t5.out));

// ── T6: 第 7 节「接入 DSH」的 shell 接线 ────────────────────
// 前面 T1~T5 测的是布署文件，register-screen-test.mjs 测的是 .mjs 自己的判据。
// **中间那段接线没人测**: §7 传哪些 flag、怎么从输出里抠 STATUS、六种状态分别
// 印什么、SM_OK=0 时该不该动。一个 `--patch-src` 拼错、或 sed 表达式改了，
// 结果都是"装机日志说 OK 而设备上没登记"—— 正是本项目反复生产的那类绿灯掩盖。
// 做法和 T1~T5 一样: 段从 customize.sh **原样抽出**跑，只有 run_node 换成宿主
// node 的桩（真机那是模块自带的 Linux ELF，这里跑不了）。
console.log('');
console.log('=== T6 customize.sh §7 接入段（真脚本、真 node）===');
const s7 = src.indexOf('if [ "$HAS_SCREEN_MCP" = "1" ] && [ "$SM_OK" = "1" ]; then');
const e7 = src.indexOf('# ── 结尾提示:');
if (s7 < 0 || e7 < 0 || e7 <= s7) throw new Error('抽不到 §7 接入段，customize.sh 结构变了');
const block7 = src.slice(s7, e7);
for (const need of ['register-screen-mcp.mjs', 'sed -n \'s/^STATUS: //p\'', '--patch-src']) {
  if (!block7.includes(need)) throw new Error(`§7 抽到的段里没有 ${need} —— 抽取范围不对`);
}
check('  (前置) §7 段抽取完整', true);

// 宿主 node 的绝对路径。反斜杠换成正斜杠: 同一份教训，sh 里反斜杠是转义符。
const NODE_EXE = process.execPath.replace(/\\/g, '/');
const MOD7 = j(SANDBOX, 'mod7');
// APP 直接指仓库里那棵真 app 树 —— §7 里 MODPATH 和 APP 是两个独立变量，
// 分开给就不必为了测试去拷两万五千个文件（而真机上两者本来同在模块目录下）。
const APP7 = j(ROOT, 'dsh', 'module', 'app');

/** 搭一个模块树: 脚本和模板都用**要发布的那份**（原样拷，不手抄）。 */
function mod7Setup({ withScript = true, withTemplate = true, templateText = null } = {}) {
  fs.rmSync(MOD7, { recursive: true, force: true });
  fs.mkdirSync(j(MOD7, 'bin'), { recursive: true });
  fs.mkdirSync(j(MOD7, 'tools'), { recursive: true });
  if (withScript) {
    fs.copyFileSync(j(ROOT, 'dsh', 'module', 'bin', 'register-screen-mcp.mjs'), j(MOD7, 'bin', 'register-screen-mcp.mjs'));
  }
  if (withTemplate) {
    fs.writeFileSync(
      j(MOD7, 'tools', 'cordis.patch.example.yml'),
      templateText ?? fs.readFileSync(j(ROOT, 'dsh', 'module', 'tools', 'cordis.patch.example.yml'), 'utf8'),
      'utf8',
    );
  }
}
function regRun(name, home, extraVars = {}) {
  const f = j(SANDBOX, `${name}.sh`);
  fs.writeFileSync(f, [
    'ui_print() { echo "UI| $*"; }',
    `run_node() { "${NODE_EXE}" "$@"; }`,
    `MODPATH='${MOD7}'`,
    `APP='${APP7}'`,
    `DSH_HOME_DIR='${home}'`,
    `HAS_SCREEN_MCP='1'`,
    `SM_OK='1'`,
    ...Object.entries(extraVars).map(([k, v]) => `${k}='${v}'`),
    'set -u',
    block7,
    'echo "RC| $?"',
  ].join('\n'), 'utf8');
  const r = spawnSync(SH, [f], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const readHome = (home) => {
  const p = j(home, 'cordis.patch.yml');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};
const HOME6 = j(SANDBOX, 'home6');
fs.rmSync(HOME6, { recursive: true, force: true });
mod7Setup();
const t6a = regRun('t6a', HOME6);
show(t6a.out);
const h6 = readHome(HOME6);
check('空 home 层: §7 报 [ OK ] 已登记', /\[ OK \] 已登记到/.test(t6a.out), t6a.out.slice(-400));
check('  home 层文件真的建出来了', h6 !== null);
check('  里面是那条 insert（command 指向落点）', !!h6 && h6.includes('serverName: screen') && h6.includes('command: /data/adb/dsh/tools/screen-mcp'), h6);
check('  带我们的托管标记', !!h6 && /# >>> dsh-screen-mcp/.test(h6) && /# <<< dsh-screen-mcp/.test(h6));
check('  §7 没有把安装器带崩（RC 0）', /RC\| 0/.test(t6a.out), t6a.out.slice(-200));

const t6b = regRun('t6b', HOME6);
check('重跑: 报"早已登记且是最新条目"', /早已登记且是最新条目/.test(t6b.out), t6b.out.slice(-400));
check('  重跑之后文件字节一字未动', readHome(HOME6) === h6);

// 陈旧条目 → 原地刷新。这就是"模块升级改了路径"那条真实演进路径。
const STALE = h6.replace('/data/adb/dsh/tools/screen-mcp', '/data/adb/dsh/tools/OLD-screen-mcp');
fs.writeFileSync(j(HOME6, 'cordis.patch.yml'), STALE, 'utf8');
const t6c = regRun('t6c', HOME6);
check('条目过期: 报"原地刷新"', /条目已过期，原地刷新/.test(t6c.out), t6c.out.slice(-400));
check('  刷新后指向新落点', readHome(HOME6).includes('command: /data/adb/dsh/tools/screen-mcp'));
check('  旧路径不再残留', !readHome(HOME6).includes('OLD-screen-mcp'));

// 接线是否真的传了 --patch-src: 换掉**模块里的模板**，写出的块必须跟着变。
// 如果 §7 其实没传、脚本用的是内置副本，这条会失败 —— 而那正是"两份真相"。
mod7Setup({
  templateText:
    '- insert:\n    - id: mcp-screen\n      name: x\n      config:\n        serverName: screen\n        transport: stdio\n        command: /data/adb/dsh/tools/OTHER-mcp\n',
});
fs.rmSync(HOME6, { recursive: true, force: true });
const t6d = regRun('t6d', HOME6);
check('块的内容来自 $MODPATH/tools 那份模板（--patch-src 接线有效）', !!readHome(HOME6) && readHome(HOME6).includes('command: /data/adb/dsh/tools/OTHER-mcp'), readHome(HOME6));

// SM_OK=0（冒烟没过）→ 整段不该执行，也不该留下半截 home 层文件。
mod7Setup();
const HOME7 = j(SANDBOX, 'home7');
fs.mkdirSync(HOME7, { recursive: true });
fs.writeFileSync(j(HOME7, 'keep.txt'), 'mine\n', 'utf8');
const t6e = regRun('t6e', HOME7, { SM_OK: '0' });
check('SM_OK=0: 整段跳过，不写 home 层', readHome(HOME7) === null && !/接入 DSH/.test(t6e.out), t6e.out.slice(-300));
check('  用户目录里的东西没动', fs.existsSync(j(HOME7, 'keep.txt')));

// 脚本缺失（打包事故）→ 必须是 [WARN] 说清是打包问题，而不是把安装带崩。
const HOME8 = j(SANDBOX, 'home8');
mod7Setup({ withScript: false });
const t6f = regRun('t6f', HOME8);
check('没有登记脚本: 报 [WARN] 并点出是打包问题', /\[WARN\] 没有 bin\/register-screen-mcp\.mjs/.test(t6f.out) && /打包问题/.test(t6f.out), t6f.out.slice(-400));
check('  且没有崩（RC 0，安装继续）', /RC\| 0/.test(t6f.out), t6f.out.slice(-200));
check('  且没有伪造登记', readHome(HOME8) === null);

// 模板缺失: 脚本会 REFUSED。§7 必须把它报成 [WARN] + 原话，而不是 [ OK ]。
const HOME9 = j(SANDBOX, 'home9');
mod7Setup({ withTemplate: false });
const t6g = regRun('t6g', HOME9);
check('模板缺失: 不报 OK', !/\[ OK \]/.test(t6g.out), t6g.out.slice(-400));
check('  报 WARN 且把脚本原话印出来', /\[WARN\] 没接进去/.test(t6g.out) && /REFUSED/.test(t6g.out), t6g.out.slice(-500));
check('  且没有崩（RC 0）', /RC\| 0/.test(t6g.out), t6g.out.slice(-200));

// 收尾: 恢复一份正常模块树，别让沙箱留在坏状态影响后面新增的用例。
mod7Setup();

// ── T7: uninstall.sh 真的能把块摘干净 ───────────────────────
// §7 写进去的东西，卸载必须拿走。这条链上唯一被替换的是 **node 解释器的路径**
// （真机是模块自带的 Linux ELF，Windows 上 exec 不了）—— 其余 shell 逻辑
// 一字未改地跑。块本身的行为在 register-screen-test.mjs 里已经用真 DSH 验过
// （"卸载后残留 []，exit=0"），这里验的是 uninstall.sh **有没有把那次调用发对**。
console.log('');
console.log('=== T7 uninstall.sh（真脚本、真 node，只换解释器路径）===');
const UNINST_SRC = j(ROOT, 'dsh', 'module', 'uninstall.sh');
if (!fs.existsSync(UNINST_SRC)) throw new Error('uninstall.sh 不在仓库里');
const uninstText = fs.readFileSync(UNINST_SRC, 'utf8');

/**
 * 跑卸载。只替换**两个变量赋值**，不改任何逻辑:
 *   · NODE=…            真机是模块自带的 Linux ELF，这里 exec 不了
 *   · DSH_HOME_DIR=…    模块里它是硬编码的 /data/adb/dsh（和 env.sh 第 26 行一致，
 *                       这是刻意的: 卸载时没有任何可信来源能给出这个路径），
 *                       不换成沙箱就会去删一个不存在的目录，测了个空。
 * 换 NODE 赋值点而不是换 `"$NODE" "$REG"` 调用点: 脚本里 `[ ! -x "$NODE" ]`
 * 那道守卫查的是**同一个变量** —— 只换调用点会让守卫去查一个不存在的模块路径，
 * 于是整个测试实际跑的是"跳过清理"那条分支，而它看起来像通过了（文件当然没被改，
 * 因为压根没执行到）。上一轮就是这么假的，被"块没了"这条断言抓出来。
 */
function uninstallRun(home, { hostNode = true } = {}) {
  let text = uninstText;
  if (hostNode) {
    const before = text;
    text = text.replace(/^NODE=.*$/m, `NODE='${NODE_EXE}'`).replace(/^DSH_HOME_DIR=.*$/m, `DSH_HOME_DIR='${home}'`);
    if (text === before) throw new Error('没替换到 NODE / DSH_HOME_DIR 赋值行 —— uninstall.sh 结构变了');
  }
  if (/^DSH_HOME_DIR=\/data\/adb\/dsh$/m.test(text) && hostNode) throw new Error('DSH_HOME_DIR 没换成沙箱');
  // $0 决定 MODDIR（脚本里 ${0%/*}），所以必须放在模块树里执行。
  const runFrom = j(MOD7, 'uninstall.sh');
  fs.writeFileSync(runFrom, text, 'utf8');
  const r = spawnSync(SH, [runFrom], { encoding: 'utf8' });
  fs.rmSync(runFrom, { force: true });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
// uninstall.sh 里 ui_print 是**没有**的（KernelSU 单独跑它，不 source common.sh），
// 所以它走的是 `|| echo "dsh uninstall: …"` 那条兜底。show() 只挑 UI| 行，这里看不见，
// 得用自己的打印 —— 顺带这本身就验了"没有 ui_print 时不炸"。
const showU = (out) => {
  for (const l of out.split('\n').filter((x) => x.includes('dsh uninstall:'))) console.log('     ' + l.trim());
};

const HOMEU = j(SANDBOX, 'homeu');
fs.rmSync(HOMEU, { recursive: true, force: true });
mod7Setup();
const installed = regRun('t7-install', HOMEU);
check('  (前置) 先由 §7 装好', /\[ OK \]/.test(installed.out) && /dsh-screen-mcp/.test(readHome(HOMEU) ?? ''), installed.out.slice(-300));
const t7 = uninstallRun(HOMEU);
showU(t7.out);
check('卸载报"清理…登记"并成功', /清理 DSH 里的屏幕识别登记/.test(t7.out), t7.out.slice(-400));
check('  块没了', !/# (>>>|<<<) dsh-screen-mcp/.test(readHome(HOMEU) ?? ''), readHome(HOMEU));
// 残留必须是 []：纯注释/空文件 DSH 直接拒绝启动（实测 exit=1），那等于卸载
// 之后设备上的 DSH 变砖 —— 这正是 uninstall.sh 存在的理由。
check('  残留是 []（不是空文件、不是纯注释）', (readHome(HOMEU) ?? '').trim() === '[]', JSON.stringify(readHome(HOMEU)));
check('  卸载脚本永远 exit 0（不许把卸载卡住）', t7.code === 0, `code=${t7.code}`);
// 沙箱模块树里没有 app/node_modules（那是两万五千个文件的构建产物，不拷），
// 所以脚本会退回文本判据并往输出里说一句"自检不可用"。卸载路径本来就不依赖
// 解析器（--remove 只按标记切区间），这条顺带把**降级路径**也跑了。
check('  降级跑通: 没有 yaml 包时卸载依然成功', /自检不可用/.test(t7.out), t7.out.slice(-300));

// 用户自己的条目不能被顺手带走。
const HOMEV = j(SANDBOX, 'homev');
fs.rmSync(HOMEV, { recursive: true, force: true });
fs.mkdirSync(HOMEV, { recursive: true });
fs.writeFileSync(j(HOMEV, 'cordis.patch.yml'), '- id: my-thing\n  config:\n    foo: bar\n', 'utf8');
regRun('t7-install2', HOMEV);
const beforeUser = readHome(HOMEV);
uninstallRun(HOMEV);
const afterUser = readHome(HOMEV);
check('卸载只动标记之间: 用户条目还在', /my-thing/.test(afterUser ?? ''), JSON.stringify(afterUser));
check('  用户那几行一字未改', !!beforeUser && !!afterUser && afterUser.includes('  config:\n    foo: bar'), JSON.stringify(afterUser));
check('  卸载时没有留下 [] （用户已有真内容）', !/^\s*\[\]\s*$/m.test(afterUser ?? ''), JSON.stringify(afterUser));
// 装→卸→装 必须可逆: 模块升级/重装走的就是这条路。
const t7again = regRun('t7-reinstall', HOMEV);
check('卸载后再装能重新登记（可逆）', /\[ OK \]/.test(t7again.out) && /dsh-screen-mcp/.test(readHome(HOMEV) ?? ''), t7again.out.slice(-300));
check('  重装后用户条目仍在', /my-thing/.test(readHome(HOMEV) ?? ''));

// node 不可用（模块树被删了一半）→ 只能说 [WARN]，但绝不 exit 非 0。
const t7c = uninstallRun(HOMEU, { hostNode: false });
check('node 不在: 报 WARN 并跳过，不阻塞卸载', /\[WARN\]/.test(t7c.out) && t7c.code === 0, `code=${t7c.code} | ${t7c.out.slice(-300)}`);

console.log('');
console.log('='.repeat(52));
console.log(`  汇总: ${pass} 通过 / ${fail} 失败`);
if (fails.length) console.log(`  失败项:\n    - ${fails.join('\n    - ')}`);
console.log('');
console.log('  ⚠ 未覆盖: Android toybox 的 cp/find/chmod 差异、真机 SELinux 上下文、');
console.log('    DSH 能否真的把 MCP 子进程拉起来并列出 4 个工具。要等设备再连上验。');
console.log('    T6/T7 跑的是**宿主 node**，不是模块自带的 Android ELF —— 真机上');
console.log('    `run_node` 那套 env（LD_LIBRARY_PATH / OPENSSL_CONF / TMPDIR）少一个');
console.log('    就 exec 不起来，而那正是 §7 复用第 6 节 run_node 的理由。');
process.exitCode = fail > 0 ? 1 : 0;
