// 在 Git for Windows 的 sh 下实测 customize.sh 的屏幕识别布署段。
//
// 诚实说明覆盖范围
// ----------------
//   · 测的是**逻辑**：find 驱动的逐文件拷贝、相对路径提取、数量复核、执行位、幂等。
//   · 段是从 customize.sh 里**原样抽出来**跑的，不是手抄一份 —— 手抄的话
//     测的是抄的那份，改源就测不到了。
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

console.log('');
console.log('='.repeat(52));
console.log(`  汇总: ${pass} 通过 / ${fail} 失败`);
if (fails.length) console.log(`  失败项:\n    - ${fails.join('\n    - ')}`);
console.log('');
console.log('  ⚠ 未覆盖: Android toybox 的 cp/find/chmod 差异、真机 SELinux 上下文、');
console.log('    DSH 能否真的把 MCP 子进程拉起来并列出 4 个工具。要等设备再连上验。');
process.exitCode = fail > 0 ? 1 : 0;
