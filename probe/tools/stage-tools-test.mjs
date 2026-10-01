#!/usr/bin/env node
/**
 * stage-tools-test.mjs — 证明 stage-tools.mjs 的校验有约束力
 *
 * 为什么要有这个文件
 * ------------------
 * 上一轮的教训：`test-serve.mjs` 只打印期望值、不断言，于是 B1~B5 那批缺陷
 * 以"绿灯"的形式连过两轮。所以这里每个用例都**主动把东西弄坏**，要求：
 *   (a) 退出码非 0
 *   (b) 报错信息里点到**该点的那个东西**
 * 只看 (a) 是不够的 —— 本次开发中用例1 就是因为只看了 (a) 而差点通过：
 * stage-tools 的 --check 模式自己先把 tools/ 删了，于是它以"目录不存在"为由失败，
 * 退出码非 0，测试却以为在测"漏拷依赖"。信息断言才把那层假象戳破。
 *
 * 用法: node probe/tools/stage-tools-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const STAGE = path.join(ROOT, 'dsh', 'tools', 'stage-tools.mjs');
const DEST = path.join(ROOT, 'dsh', 'module', 'tools');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  [OK]   ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? `\n           ${String(detail).split('\n').slice(0, 4).join('\n           ')}` : ''}`);
  }
}
const run = (args = []) => {
  const r = spawnSync(process.execPath, [STAGE, ...args], { encoding: 'utf8', cwd: ROOT });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};
/** 恢复一份干净的暂存，用例之间互不污染。返回输出以便核对它做了什么。 */
function restage() {
  const r = run();
  if (r.code !== 0) throw new Error(`前置 restage 失败: ${r.out.slice(-300)}`);
  return r;
}

console.log('=== 0. 基线 ===');
restage();
check('正常暂存 exit 0', true);
const base = run(['--check']);
check('--check 正常 exit 0', base.code === 0, base.out.slice(-300));
// 这条是防"假阳性"的地基：--check 不许删目录
check(
  '--check 之后 tools/ 仍存在（不许自己删掉自己要校验的东西）',
  fs.existsSync(DEST) && fs.existsSync(path.join(DEST, 'screen-mcp.mjs')),
  `DEST 存在=${fs.existsSync(DEST)}`
);

console.log('');
console.log('=== 1. 漏拷依赖：闭包必须报错并点名 ===');
restage();
const gone = path.join(DEST, 'lib', 'uitree.mjs');
fs.rmSync(gone);
const r1 = run(['--check']);
check('漏 uitree.mjs → 非 0 退出', r1.code !== 0, `code=${r1.code}`);
check('  报错点名 uitree.mjs', /uitree\.mjs/.test(r1.out), r1.out.slice(-300));

console.log('');
console.log('=== 2. 间接漏拷：删掉二级依赖 ===');
// uitree 是 screen-mcp 直接 import 的；displays 也是。
// 真正的二级依赖测试：observe.mjs 引 device.mjs，但 observe 不打包。
// 这里改用「删掉 lib/ 整个目录」验证递归闭包不会静默放过。
restage();
fs.rmSync(path.join(DEST, 'lib'), { recursive: true, force: true });
const r2 = run(['--check']);
check('删掉整个 lib/ → 非 0 退出', r2.code !== 0, `code=${r2.code}`);

console.log('');
console.log('=== 3. CRLF：Android sh 的头号杀手 ===');
restage();
const victim = path.join(DEST, 'screen-mcp');
const orig = fs.readFileSync(victim);
fs.writeFileSync(victim, Buffer.from(orig.toString('utf8').replace(/\n/g, '\r\n'), 'utf8'));
const r3 = run(['--check']);
check('启动器含 CRLF → 非 0 退出', r3.code !== 0, `code=${r3.code}`);
check('  报错点名 CR', /\bCR\b/.test(r3.out), r3.out.slice(-300));
fs.writeFileSync(victim, orig);

// 对照组必须用 .mjs: 上一版这里拿 shell 脚本喂 node --check，它因为
// "这不是 JS"而失败，于是测出来一个毫无意义的"node 能抓到 CRLF"。
// 真正的对照是: .mjs 带 CRLF 时 node --check 仍然 0 —— 语法完全合法，
// 但 Android 的 sh / 某些 loader 会出事。这才证明 CR 检查不可被替代。
const mjsVictim = path.join(DEST, 'lib', 'fields.mjs');
const mjsOrig = fs.readFileSync(mjsVictim);
fs.writeFileSync(mjsVictim, Buffer.from(mjsOrig.toString('utf8').replace(/\n/g, '\r\n'), 'utf8'));
const nd = spawnSync(process.execPath, ['--check', mjsVictim], { encoding: 'utf8' });
check('  (对照) node --check 抓不到 .mjs 里的 CRLF → 证明这项检查不可替代', nd.status === 0, `node --check exit=${nd.status}`);
const r3b = run(['--check']);
check('  .mjs 含 CRLF → stage-tools 非 0 退出', r3b.code !== 0, `code=${r3b.code}`);
check('    且点名 CR 与 fields.mjs', /\bCR\b/.test(r3b.out) && /fields\.mjs/.test(r3b.out), r3b.out.slice(-300));
fs.writeFileSync(mjsVictim, mjsOrig);

console.log('');
console.log('=== 4. shebang 被换：launcher 必须认 Android 的 sh ===');
restage();
const v4 = fs.readFileSync(victim, 'utf8').replace('#!/system/bin/sh', '#!/bin/bash');
fs.writeFileSync(victim, v4);
const r4 = run(['--check']);
check('shebang 改成 bash → 非 0 退出', r4.code !== 0, `code=${r4.code}`);
check('  报错点名 shebang', /shebang/.test(r4.out), r4.out.slice(-300));

console.log('');
console.log('=== 5. 语法错误：打包不该带坏文件上车 ===');
restage();
const v5 = path.join(DEST, 'lib', 'fields.mjs');
const o5 = fs.readFileSync(v5);
fs.appendFileSync(v5, '\nconst broken = ;\n');
const r5 = run(['--check']);
check('fields.mjs 语法坏 → 非 0 退出', r5.code !== 0, `code=${r5.code}`);
fs.writeFileSync(v5, o5);

console.log('');
console.log('=== 6. 陈旧残留：全量暂存必须清掉上一版多余文件 ===');
restage();
const stale = path.join(DEST, 'lib', 'zzz-stale-from-old-build.mjs');
fs.writeFileSync(stale, 'export const gone = 1;\n');
run(); // 全量
check('重新暂存后陈旧文件被删除', !fs.existsSync(stale));

console.log('');
console.log('=== 7. 清单与仓库同步：源文件缺失要报错 ===');
// 不真删 recognize/, 而是检查 FILES 清单里每个源都真实存在（漏一个就报）
restage();
const need = ['launcher.sh', 'screen-mcp.mjs', 'lib/uitree.mjs', 'lib/fields.mjs', 'lib/spawn-env.mjs', 'lib/ui-lock.mjs', 'lib/displays.mjs', 'lib/cmd-display.mjs', 'cordis.patch.yml'];
const missSrc = need.filter((f) => !fs.existsSync(path.join(ROOT, 'recognize', f)));
check(`recognize/ 里 ${need.length} 个源文件都在`, missSrc.length === 0, `缺: ${missSrc.join(', ')}`);

console.log('');
console.log('=== 8. 内容一致性：tools/ 与 recognize/ 只差行尾 ===');
// 与 stage-tools 的 FILES 保持同序；漏一个就等于"内容核对没覆盖到它"。
const pairs = [
  ['launcher.sh', 'screen-mcp'],
  ['screen-mcp.mjs', 'screen-mcp.mjs'],
  ['lib/uitree.mjs', 'lib/uitree.mjs'],
  ['lib/fields.mjs', 'lib/fields.mjs'],
  ['lib/spawn-env.mjs', 'lib/spawn-env.mjs'],
  ['lib/ui-lock.mjs', 'lib/ui-lock.mjs'],
  ['lib/displays.mjs', 'lib/displays.mjs'],
  ['lib/cmd-display.mjs', 'lib/cmd-display.mjs'],
  // 动作层: 文本, 与其他 lib 同一条比对路径
  ['lib/uiaction.mjs', 'lib/uiaction.mjs'],
  ['cordis.patch.yml', 'cordis.patch.example.yml'],
];
// dex 的源不在 recognize/（在 .build/uiaction/，由 build-uiaction.mjs 编出），
// 不进 pairs（utf8 逐字节比对会炸）；但必须在暂存对账里出现。
const BINARY_STAGED = ['dsh-action.dex'];
// 不靠正则解析 stage-tools 源码(脆)，直接核对它**实际写出的文件**。
// 光数行数不够: 清单里加一个新文件而 pairs 没跟上时行数会不一致(能抓到),
// 但 pairs 里有名字写错的文件时行数是平的(抓不到) —— 所以逐个比对名字。
const fin0 = restage();
const stagedNames = fin0.out
  .split('\n')
  .filter((l) => /^\s*\+ tools\//.test(l))
  .map((l) => l.trim().replace(/^\+ tools\//, '').replace(/\s+\d+ B$/, '').trim());
const wantNames = [...pairs.map(([, d]) => d), ...BINARY_STAGED];
const nameMismatch = [...new Set([...stagedNames, ...wantNames])].filter(
  (n) => !stagedNames.includes(n) || !wantNames.includes(n)
);
check(
  `实际暂存的 ${stagedNames.length} 个文件与内容核对清单完全一致`,
  nameMismatch.length === 0 && stagedNames.length === wantNames.length,
  `不一致: ${nameMismatch.join(', ')} | 暂存=${stagedNames.join(', ')}`
);
const diff = [];
for (const [s, d] of pairs) {
  const a = fs.readFileSync(path.join(ROOT, 'recognize', s), 'utf8').replace(/\r\n/g, '\n');
  const b = fs.readFileSync(path.join(DEST, d), 'utf8');
  if (a !== b) diff.push(`${d} (${a.length} vs ${b.length})`);
}
check('tools/ 内容与 recognize/ 归一化后逐字节相同', diff.length === 0, diff.join(', '));

console.log('');
console.log('=== 9. patch 的 command 与真实落点必须一致 ===');
// 这条防的是"配置承诺了一个不存在的机制": command 指向别处时 MCP 子进程根本
// 起不来，而 DSH 主服务照常健康 —— 和 rg 垫片一样难归因。
restage();
const pFile = path.join(DEST, 'cordis.patch.example.yml');
const pOrig = fs.readFileSync(pFile);
// 必须锚定到 command 行。上一版用 String.replace(旧, 新) 注入, 而模板里
// 那个路径**第一次出现在注释**(第 12 行), 于是注释被改了、command 没动,
// 检查当然通过 —— 测出来一个假失败。
const pText = pOrig.toString('utf8').replace(/^(\s*command:\s*)\S+$/m, '$1/data/adb/dsh/tools/screen-mcp.v2');
check('  (前置) 注入确实改到了 command 行', /command:\s*\/data\/adb\/dsh\/tools\/screen-mcp\.v2/.test(pText));
fs.writeFileSync(pFile, Buffer.from(pText, 'utf8'));
const r9 = run(['--check']);
check('command 漂移 → 非 0 退出', r9.code !== 0, `code=${r9.code}`);
// 断言"点名到那个漂移值"，而不是只匹配 command 字样 —— 正常输出里本来就有 command:
check('  报错点名漂移值与落点', /screen-mcp\.v2/.test(r9.out) && /落点/.test(r9.out), r9.out.slice(-300));
fs.writeFileSync(pFile, pOrig);

console.log('');
console.log('=== 9b. 托管块由真脚本推导：模板里没有 screen 条目要报错 ===');
// 第 4 道门现在是"**跑一遍要装进手机的那份脚本**，问它准备写什么"。
// 要测的不是"我以为它能推导出什么"，而是它实际会写出的字节 —— 所以这里破坏
// 的是**输入**：把模板里那条 insert 改名，脚本应当拒绝推导（exit 2），
// 门必须把这件事报成致命而不是放行。
// 反过来说：如果门里另写了一份解析逻辑，这个用例就会通过得莫名其妙。
restage();
{
  const f = path.join(DEST, 'cordis.patch.example.yml');
  const orig = fs.readFileSync(f);
  const text = orig.toString('utf8').replace(/^(\s*)serverName:\s*screen$/m, '$1serverName: not-screen');
  check('  (前置) 注入确实改到了 serverName 行', /^\s*serverName:\s*not-screen$/m.test(text));
  fs.writeFileSync(f, Buffer.from(text, 'utf8'));
  const r = run(['--check']);
  check('模板里找不到 screen 条目 → 非 0 退出', r.code !== 0, `code=${r.code}`);
  check('  报错点名"推不出 screen 条目"这件事', /推导出 screen|没能从/.test(r.out), r.out.slice(-400));
  check('  报错点名是哪个源文件推不出来', /cordis\.patch\.example\.yml/.test(r.out), r.out.slice(-400));
  fs.writeFileSync(f, orig);
  const back = run(['--check']);
  check('  还原后恢复 exit 0', back.code === 0, back.out.slice(-300));
}

console.log('');
console.log('=== 9c. 真源文件缺失：绝不能"没有块也照样出包" ===');
// 托管块的内容来自 tools/cordis.patch.example.yml。这份文件不在（改名/漏暂存）
// 时，装机第 7 节会静默跳过，模型少了 4 个工具而日志只有一行 WARN ——
// 打包阶段就该拒绝。
restage();
{
  const f = path.join(DEST, 'cordis.patch.example.yml');
  const orig = fs.readFileSync(f);
  fs.rmSync(f);
  const r = run(['--check']);
  check('模板文件缺失 → 非 0 退出', r.code !== 0, `code=${r.code}`);
  // 报"缺文件"还是报"没有真源"都行 —— 前者其实更准（是清单门先说话），
  // 这条测的是**绝不静默出包**，不是某一句措辞。
  check('  报错点名那个缺失的文件', /cordis\.patch\.example\.yml/.test(r.out), r.out.slice(-300));
  fs.writeFileSync(f, orig);
}

console.log('');
console.log('=== 9d. 注册脚本自己坏了：语法错也要在打包时拦住 ===');
// 第 7 节是拿 node 跑它。脚本语法坏了的后果不是装机失败而是**静默不登记**
// （run_node 非零 → case 落到 *)，正是"绿灯掩盖"的老配方。
restage();
{
  const reg = path.join(ROOT, 'dsh', 'module', 'bin', 'register-screen-mcp.mjs');
  const orig = fs.readFileSync(reg);
  fs.appendFileSync(reg, '\nthis is not javascript at all (;\n');
  const r = run(['--check']);
  check('注册脚本语法坏 → 非 0 退出', r.code !== 0, `code=${r.code}`);
  check('  报错点名那个脚本推不出条目', /register-screen-mcp\.mjs|推导出 screen/.test(r.out), r.out.slice(-400));
  fs.writeFileSync(reg, orig);
  const back = run(['--check']);
  check('  还原后恢复 exit 0', back.code === 0, back.out.slice(-300));
}

console.log('');
console.log('=== 10. 源改了而暂存没跟上：--check 必须发现陈旧 ===');
// 这条防的是本项目真正栽过的失败的**变体**：PR 合了、recognize/ 变了，
// 但打包用的 tools/ 还是旧的。旧版 --check 只验 tools/ 自身是否自洽 ——
// 陈旧的那份依然 LF、依然语法通过、闭包依然可达，于是四道门全绿而装进包的是旧代码。
// 注入用**改源文件**的方式（不是删 tools/），因为"文件在但内容旧"才是难点。
// 还原不靠 git checkout: 直接把原始字节写回去更可靠，也避免误伤别人的改动，
// 并且**必须断言还原成功** —— 测试改坏源却没还原，比测试失败更糟。
restage();
const driftSrc = path.join(ROOT, 'recognize', 'lib', 'fields.mjs');
const driftOrig = fs.readFileSync(driftSrc);
try {
  fs.writeFileSync(driftSrc, Buffer.concat([driftOrig, Buffer.from('\n// stage-tools-test drift probe\n', 'utf8')]));
  const r10 = run(['--check']);
  check('源漂移 → 非 0 退出', r10.code !== 0, `code=${r10.code}（旧版这里正是 exit 0，缺这道门）`);
  check('  报错点名漂移的那个文件', /tools\/lib\/fields\.mjs/.test(r10.out), r10.out.slice(-300));
  check('  并说清是"不一致/陈旧"而不是"缺文件"', /不一致|陈旧/.test(r10.out), r10.out.slice(-300));
  check('  并给出可执行的下一步(重新暂存)', /stage-tools\.mjs/.test(r10.out), r10.out.slice(-200));
  // 反向: 重新暂存之后必须恢复绿灯, 否则这扇门会把正常流程也堵死
  const re = run();
  check('  重新暂存后 --check 恢复 exit 0', run(['--check']).code === 0 && re.code === 0, re.out.slice(-200));
} finally {
  fs.writeFileSync(driftSrc, driftOrig);
  check('  (收尾) 源文件已按字节还原', fs.readFileSync(driftSrc).equals(driftOrig));
}

console.log('');
console.log('=== 11. 打包门禁：pack-module 会调用 --check，陈旧就拒绝打包 ===');
// §10 证明 --check 能发现陈旧；这里证明**打包真的听了它**。
// 两层要分开测: 如果只测 --check，而 pack-module 里那句调用被删/被条件跳过，
// 全套测试仍然全绿，包却照样是旧的 —— 又是一次"绿灯掩盖"。
// 手工注入过 4 条分支(D/E/F/G)，这里把它们固化下来，否则保护只活在那一次会话里。
const PACK = path.join(ROOT, 'probe', 'tools', 'pack-module.mjs');
const pack = (extra = []) => {
  const r = spawnSync(process.execPath, [PACK, '--module', 'dsh/module', '--no-zip', ...extra], { encoding: 'utf8', cwd: ROOT });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};
restage();
// 每个 pack() 都要扫 14216 个文件(约 3~6 秒)，所以跑一次存下来复用 ——
// 写成 `check(pack().code === 0, ..., pack().out)` 会把同一件事跑两遍。
const okPack = pack();
check('  干净状态可打包 (--no-zip exit 0)', okPack.code === 0, okPack.out.slice(-300));
{
  const gsrc = path.join(ROOT, 'recognize', 'lib', 'cmd-display.mjs');
  const gOrig = fs.readFileSync(gsrc);
  let blocked = null;
  let escaped = null;
  try {
    fs.writeFileSync(gsrc, Buffer.concat([gOrig, Buffer.from('\n// pack-gate drift probe\n', 'utf8')]));
    blocked = pack();
    escaped = pack(['--no-screen-mcp']);
  } finally {
    fs.writeFileSync(gsrc, gOrig);
    check('  (收尾) 源已按字节还原', fs.readFileSync(gsrc).equals(gOrig));
  }
  check('  源漂移时打包被拒绝 (exit 非 0)', (blocked?.code ?? 0) !== 0, `code=${blocked?.code}`);
  check('  拒绝理由点名"陈旧"', /不一致|陈旧/.test(blocked?.out ?? ''), (blocked?.out ?? '').slice(-300));
  // 再验"绕过校验"的开关确实按语义放行 —— 门禁不该挡住一个明确说了"我知道"的人。
  check('  --no-screen-mcp 显式放行', (escaped?.code ?? 1) === 0, (escaped?.out ?? '').slice(-200));
}

console.log('');
console.log('=== 12. 收尾：一切恢复可打包状态 ===');
const fin = run();
check('最终重跑 exit 0', fin.code === 0, fin.out.slice(-300));

console.log('');
console.log('='.repeat(52));
console.log(`  汇总: ${pass} 通过 / ${fail} 失败`);
if (failures.length) console.log(`  失败项:\n    - ${failures.join('\n    - ')}`);
// 断言而不是打印: 上一轮的缺陷就是"打印完就绿"
process.exitCode = fail > 0 ? 1 : 0;
