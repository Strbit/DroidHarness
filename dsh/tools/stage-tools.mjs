#!/usr/bin/env node
/**
 * stage-tools.mjs — 把设备侧要跑的文件暂存进 dsh/module/tools/，让模块 zip 带上它们。
 *
 * 为什么需要这一步
 * ----------------
 * `recognize/` 是随 PR #11 进 main 的，但打包流水线里没有任何一步把它装到手机上。
 * 结果：模块刷进去之后手机里没有 screen-mcp，DSH 的"眼睛"整套能力等于不存在，
 * 而症状不是报错 —— 是工具列表里就是没有那 4 个 mcp__screen__*，很容易被当成
 * "这功能还没做"。README 里那句"已部署到设备"靠的是手动 adb push，换设备就没了。
 *
 * 为什么落点是 /data/adb/dsh/tools/ 而不是模块目录内
 * ---------------------------------------------------
 * launcher.sh 第 30-31 行用 `SERVER_DIR=${0%/*}` 推导 .mjs 的位置，要求启动器和
 * 服务本体同目录；而模块目录在升级时会被整个替换掉。`/data/adb/dsh/` 在模块目录
 * 之外（customize.sh 第 9 行就是为此选的：重装不丢配置），所以服务文件放那儿。
 * 模块 zip 里带 tools/，装机时由 customize.sh 拷过去。
 *
 * 为什么不直接写 profiles/web/cordis.patch.yml
 * --------------------------------------------
 * profile 是用户数据：手动改过的 patch 会被每次装机覆盖掉，而那种覆盖没有任何
 * 提示。
 *
 * 接入由 module/bin/register-screen-mcp.mjs 在装机时自动完成，写的是 **home 层**
 * `/data/adb/dsh/cordis.patch.yml` —— DSH 的 patch 分层里唯一"既被每次启动读取、
 * 又没有任何 DSH 代码会重写"的一层（bundle → profiles/<p>/cordis.patch.yml →
 * home cordis.patch.yml → --patch → telemetry；profiles/<p>/cordis.yml 反而是机器
 * 会在加载时改写的，绝不能碰）。所以自动登记不覆盖任何用户数据。
 *
 * 那份 cordis.patch.example.yml 因此不是"给人抄的模板"，而是**条目正文的唯一真源**:
 * register-screen-mcp.mjs 装机时从它现场推导出要写入的托管块（见下面第 4 道门）。
 * 脚本里不留副本 —— 留了就会漂移，而漂移的症状是装机日志 [ OK ] 但设备上 spawn
 * 一个不存在的程序，MCP 失败、DSH 主服务照常健康，极难归因。
 *
 * 五道校验，都必须失败时报错而不是静默出包
 * -----------------------------------------
 *  1. 清单：FILES 里每个源都要在 recognize/ 里存在。
 *  2. 闭包：每个 .mjs 的相对 import 都要在目标集合里有对应文件。
 *     漏拷一个 lib 的后果是 MCP 子进程起不来，而 DSH 主服务照常健康、日志干净，
 *     症状只在模型调用那个工具时出现 —— 和 rg 垫片那次一模一样的"错得很难归因"。
 *  3. 行尾 / shebang / 语法：Android 的 sh 会把 `\r` 当命令内容，
 *     `#!/system/bin/sh\r` 不是合法 shebang。`core.autocrlf=true` 在这个仓库里是
 *     开着的，靠 .gitattributes 的 eol=lf 才没出事；这里再独立核一遍 —— 实测
 *     `node --check` **抓不到 CRLF**（语法上完全合法），所以必须显式查字节。
 *     内容本身另过一遍 node --check。
 *  4. 托管块：真跑一遍 register-screen-mcp.mjs（--print-block），确认它能从暂存的
 *     模板推出一条 screen 条目，且条目里的 command 等于本文件算出来的落点。
 *     这一道是"打包时验装配"：装机第 7 节拿 node 跑它，脚本坏了 / 模板改名了都
 *     只会得到一行 [WARN]，模型静静少 4 个工具。
 *  5. 陈旧：tools/ 必须逐字节等于 recognize/ 的 LF 归一化结果（改了源忘了重新
 *     暂存时，前四道门可以全绿而装进包的是旧代码 —— 实测注入过）。
 *
 * 用法
 * ----
 *   node dsh/tools/stage-tools.mjs              # 暂存 + 校验
 *   node dsh/tools/stage-tools.mjs --check      # 只校验已暂存的内容，不写盘
 *   node dsh/tools/stage-tools.mjs --clean      # 删掉 tools/ 后退出
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SRC = path.join(ROOT, 'recognize');
const DEST = path.join(ROOT, 'dsh', 'module', 'tools');

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const CLEAN = argv.includes('--clean');

const log = (s = '') => process.stdout.write(s + '\n');
function die(msg) {
  process.stderr.write(`\n[致命] ${msg}\n`);
  process.exit(1);
}

// 读 → 强制 LF。写入分支和校验分支**必须共用这一个函数**：
// 校验时比的"期望字节"就是写入时会产出的字节，两边走不同代码迟早漂移，
// 而漂移的表现是"重新暂存后 --check 仍说不一致"——比原问题更难查。
// 返回的 buffer 一定不含 0x0d。
function normalizeLf(buf) {
  if (!buf.includes(0x0d)) return buf;
  return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

/**
 * 要装到手机上的文件：源路径 → 目标相对路径。
 *
 * 这份清单是**手工**的而不是"扫 recognize/lib/ 全收"，理由是 lib/ 里的
 * device.mjs 与 observe.mjs 属于 PC 侧 CLI（走 adb，见它们对 Device 的依赖），
 * 装进手机既用不上又误导："手机上有 observe.mjs"会让人以为设备侧也有那套逻辑。
 * 清单写死 = 少拷会在这里报错，多拷会在这里被看见。
 */
const FILES = [
  ['launcher.sh', 'screen-mcp'], // 改名：cordis.patch.yml 里 command 指的就是这个无后缀入口
  ['screen-mcp.mjs', 'screen-mcp.mjs'],
  ['lib/uitree.mjs', 'lib/uitree.mjs'],
  ['lib/fields.mjs', 'lib/fields.mjs'],
  ['lib/spawn-env.mjs', 'lib/spawn-env.mjs'],
  ['lib/displays.mjs', 'lib/displays.mjs'],
  ['lib/cmd-display.mjs', 'lib/cmd-display.mjs'],
  // 接入条目的**唯一真源**。装机时 register-screen-mcp.mjs 从它推导出写进 home 层
  // 的托管块（见第 4 道门）—— 所以它不是"给人抄的模板"，而是装配的输入。
  // 仍放在 tools/ 且名字带 .example：一是它在设备上可读，二是避免任何人以为
  // 它是 DSH 会自己去读的活配置（活配置是 home 层那份，由脚本维护）。
  ['cordis.patch.yml', 'cordis.patch.example.yml'],
];

// ─────────────────────────── 清理 ───────────────────────────
// 先整个删掉再建：上一版残留的文件会一直跟着打包（pack-module 是遍历目录的，
// 不知道哪些已经不该存在）。少一个依赖却留着旧副本 = 装上就报模块里有它。
//
// 但 --check 必须**跳过这一步**：它语义是"校验已暂存的内容、不写盘"。
// 第一版这里无条件 rm，于是 --check 每次都在"tools/ 不存在"上失败 ——
// 退出码确实非 0，可失败原因是假的。反向测试差点因此通过。
const exists = fs.existsSync(DEST);
if (!CHECK_ONLY && exists) fs.rmSync(DEST, { recursive: true, force: true });
if (CLEAN) {
  if (exists) log(`已删除 ${path.relative(ROOT, DEST)}`);
  else log(`${path.relative(ROOT, DEST)} 本来就不存在`);
  process.exit(0);
}
log('DSH Android Module — 暂存设备侧 tools' + (CHECK_ONLY ? '（校验模式）' : ''));
log('='.repeat(58));

if (!fs.existsSync(SRC)) die(`找不到 recognize/：${SRC}`);

// ─────────────────────────── 1. 源文件检查 + 写入 ───────────────────────────
const staged = []; // { rel, abs, bytes }
if (CHECK_ONLY) {
  if (!fs.existsSync(DEST)) die(`--check 但 ${path.relative(ROOT, DEST)} 不存在，先不带 --check 跑一次`);
  for (const [, dstRel] of FILES) {
    const abs = path.join(DEST, dstRel);
    if (!fs.existsSync(abs)) { die(`已暂存的内容缺文件: tools/${dstRel}`); }
    staged.push({ rel: dstRel, abs, bytes: fs.statSync(abs).size });
  }
  log(`校验模式: tools/ 下 ${staged.length} 个文件（不写盘）`);
} else {
  fs.mkdirSync(path.join(DEST, 'lib'), { recursive: true });
  for (const [srcRel, dstRel] of FILES) {
    const srcAbs = path.join(SRC, srcRel);
    if (!fs.existsSync(srcAbs)) die(`recognize 里没有 ${srcRel} —— 清单和仓库不同步，先核对 PR #11 的落点`);
    const dstAbs = path.join(DEST, dstRel);
    fs.mkdirSync(path.dirname(dstAbs), { recursive: true });

    // 读 → 强制 LF → 写。不是"检查后拒绝"而是"直接归一化":
    // 工作区里出现 CRLF 是 autocrlf 的产物，不是谁写错了，内容等价。
    // 归一化后 zip 里的字节就是设备上要执行的字节。
    const lf = normalizeLf(fs.readFileSync(srcAbs));
    if (lf.includes(0x0d)) die(`tools/${dstRel}: 归一化后仍残留 CR，不敢继续`);
    fs.writeFileSync(dstAbs, lf);
    staged.push({ rel: dstRel, abs: dstAbs, bytes: lf.length });
    log(`  + tools/${dstRel.padEnd(24)} ${String(lf.length).padStart(7)} B`);
  }
}

// ─────────────────────────── 2. 闭包校验 ───────────────────────────
// 从 screen-mcp.mjs 出发做传递闭包，和清单比对。两个方向都要报:
//   闭包要而清单没有 → 装上跑不起来（必须修）
//   清单有而闭包不要 → 白占包体（警告）
// 用相对路径本身做集合，不要凭 basename 猜它在不在 lib/ 下 ——
// 上一版无条件加 `lib/` 前缀，于是顶层的 screen-mcp/screen-mcp.mjs 被当成
// lib/ 下的文件，"多拷"警告永远误报，真正的漏拷反而被淹没在假警告里。
const relOf = (abs) => path.relative(DEST, abs).replace(/\\/g, '/');
const destSet = new Set(staged.map((f) => relOf(f.abs)));

function importsOf(file) {
  const t = fs.readFileSync(file, 'utf8');
  return [...t.matchAll(/from\s+['"`](\.\/[^'"`]+)['"`]/g)].map((m) => m[1]);
}

const reachable = new Set(['screen-mcp.mjs']);
const queue = ['screen-mcp.mjs'];
while (queue.length) {
  const cur = queue.shift();
  const abs = path.join(DEST, cur);
  // 文件不在: 不展开它的 import。漏拷由下面的 missing 统一报出，
  // 这里不再单独收集一份 —— 上一版收了 broken 却从不打印，等于假象。
  if (!fs.existsSync(abs)) continue;
  for (const spec of importsOf(abs)) {
    const dep = path.posix.normalize(path.posix.join(path.posix.dirname(cur), spec));
    if (!reachable.has(dep)) {
      reachable.add(dep);
      queue.push(dep);
    }
  }
}
const missing = [...reachable].filter((r) => !fs.existsSync(path.join(DEST, r)));
// "多拷"只对 **.mjs** 有意义: 闭包是 import 图，而 tools/ 里本来就有两类
// 不参与 import 的文件 —— 启动器 screen-mcp（被 exec，不被 import）和
// cordis.patch.example.yml（接入条目的真源，被 register-screen-mcp.mjs 读文本）。
// 把它们算成多余，每次正常打包都会报两条假警告；假警告多了，真漏拷就没人看了。
const nonModuleExempt = new Set(['screen-mcp', 'cordis.patch.example.yml']);
const extra = [...destSet].filter((d) => /\.mjs$/.test(d) && !reachable.has(d) && !nonModuleExempt.has(d));

log('');
log('闭包校验（从 screen-mcp.mjs 出发）:');
for (const r of [...reachable].sort()) log(`  · ${r.padEnd(22)} ${fs.existsSync(path.join(DEST, r)) ? '在' : '缺失 ←'}`);
if (missing.length > 0) die(`闭包里有 ${missing.length} 个文件不在 tools/: ${missing.join(', ')}`);
log(`  ✓ ${reachable.size} 个模块全部可达`);
if (extra.length > 0) log(`  ! 清单里有 ${extra.length} 个不在闭包中（多拷，不阻塞）: ${extra.join(', ')}`);

// ─────────────────────────── 3. 行尾 / shebang / 语法 ───────────────────────────
log('');
log('逐文件校验:');
let bad = 0;
for (const f of staged) {
  const buf = fs.readFileSync(f.abs);
  const cr = buf.includes(0x0d);
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const problems = [];
  if (cr) problems.push('含 CR');
  if (bom) problems.push('含 BOM');
  if (f.rel === 'screen-mcp') {
    const first = buf.subarray(0, buf.indexOf(0x0a) < 0 ? buf.length : buf.indexOf(0x0a)).toString('utf8');
    if (first !== '#!/system/bin/sh') problems.push(`shebang 不是 #!/system/bin/sh (${JSON.stringify(first)})`);
  }
  if (/\.(mjs|js)$/.test(f.rel)) {
    const r = spawnSync(process.execPath, ['--check', f.abs], { encoding: 'utf8' });
    if (r.status !== 0) problems.push(`node --check 失败: ${((r.stderr ?? '') + (r.stdout ?? '')).split('\n')[0]}`);
  }
  if (problems.length > 0) {
    log(`  ✗ tools/${f.rel}: ${problems.join('; ')}`);
    bad++;
  } else {
    log(`  ✓ tools/${f.rel}  LF${bom ? '' : '/无BOM'}${/\.(mjs|js)$/.test(f.rel) ? ' + 语法通过' : ''}`);
  }
}
if (bad > 0) die(`${bad} 个文件校验失败`);

// ───────────────────── 4. patch 条目: 由**真脚本**推导，并核对落点 ─────────────────────
// 这一条查的是"注释/配置承诺了一个不存在的机制"那一类缺陷 ——
// launcher.sh 前一版就死在这上面（注释说运行时推导，case 模式永不命中）。
//
// 装机时写进 home 层的托管块**不是**脚本里抄的一份文本，而是运行
// register-screen-mcp.mjs 从 tools/cordis.patch.example.yml 现场推导出来的
// （见那个脚本的 deriveEntry）。所以这里不能"我以为块长什么样"地再实现一遍
// 推导逻辑来比对 —— 那是自证式测试，两边一起错就一起绿。做法是直接问**要装进
// 手机的那份脚本本人**: `--print-block` 把它准备写入的字节打到 stdout。
//
// 三次问，各挡一种失败:
//   a) --patch-src = 暂存那份  → 暂存的模板读不出 screen 条目（改坏了/改名了）
//   b) --patch-src = recognize/ → 源与暂存推导出的块不同 = 陈旧（gate 5 的交叉验证）
//   c) 块里的 command: 必须等于这里算出来的落点 —— 漂了的后果是 MCP 子进程
//      根本起不来而 DSH 主服务照常健康，一个非常难归因的失败。
const DEVICE_TOOLS = '/data/adb/dsh/tools';
const REG_SCRIPT = path.join(ROOT, 'dsh', 'module', 'bin', 'register-screen-mcp.mjs');
const MODULES_DIR = path.join(ROOT, 'dsh', 'module', 'app', 'node_modules');
const patchAbs = path.join(DEST, 'cordis.patch.example.yml');
if (!fs.existsSync(REG_SCRIPT)) die(`注册脚本不在: ${path.relative(ROOT, REG_SCRIPT)}`);
if (!fs.existsSync(patchAbs)) die('tools/cordis.patch.example.yml 不在 —— 托管块没有真源了');
// dsh/module/app/ 是 gitignore 的构建产物 (build-dsh-tree / fetch-runtime 生成)。
// 没有真解析器时脚本会退回到文本判据 (见 deriveEntry) 并往 stderr 说一句
// "自检不可用" —— stdout 仍然只输出块，所以这道门照样能用。真打包时那棵树
// 必然在 (pack-module 要把它打进 zip)，退化的只是"在裸 checkout 上跑 --check"。
const hasModules = fs.existsSync(MODULES_DIR);
if (!hasModules) log(`  ! ${path.relative(ROOT, MODULES_DIR)} 不在: 本道门退回文本判据`);

/** 问真脚本"你要写什么"。返回块文本（含结尾换行）。 */
function printBlock(srcFile) {
  const args = [REG_SCRIPT, '--print-block', '--patch-src', srcFile];
  if (hasModules) args.push('--modules', MODULES_DIR);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const diag = ((r.stderr ?? '') + (r.stdout ?? '')).split('\n').filter((l) => l.includes('[register]')).join('\n      ');
  if (r.status !== 0) {
    die(`register-screen-mcp.mjs 没能从 ${path.relative(ROOT, srcFile)} 推导出 screen 条目` +
        `\n  (exit=${r.status})\n      ${diag}`);
  }
  return r.stdout;
}

log('');
const blockStaged = printBlock(patchAbs);
log('  ✓ 暂存模板可推导出托管块（装机时写入 home 层的就是这段）');
// 块必须自成一段合法 patch: 首行是 begin 标记、末行是 end 标记，且只有一条 command。
const MARK_BEGIN_RE = /^# >>> dsh-screen-mcp\b/;
const MARK_END_RE = /^# <<< dsh-screen-mcp\b/;
const blockLines = blockStaged.replace(/\n$/, '').split('\n');
if (!MARK_BEGIN_RE.test(blockLines[0]) || !MARK_END_RE.test(blockLines[blockLines.length - 1])) {
  die('推导出的块标记不完整（首/末行不是我们的标记）:\n' + blockStaged);
}
if (blockStaged.split('\n').filter((l) => MARK_BEGIN_RE.test(l)).length !== 1) {
  die('推导出的块里有不止一个 begin 标记:\n' + blockStaged);
}
const cmds = [...blockStaged.matchAll(/^\s*command:\s*(\S+)\s*$/gm)].map((m) => m[1]);
if (cmds.length !== 1) die(`块里应有且仅有 1 个 command:，实际 ${cmds.length} 个:\n${blockStaged}`);
const want = `${DEVICE_TOOLS}/screen-mcp`;
if (cmds[0] !== want) die(`patch 条目的 command 与落点不符:\n  块里写的: ${cmds[0]}\n  应该是:   ${want}`);
log(`  ✓ 块内唯一 command: 指向 ${want}`);
// 内容门**先于**陈旧门: 源和暂存同时都错时，先报"错在哪"而不是"去重新暂存"——
// 照后者做完错还在，白绕一圈且误导人（和本文件第 5 道门的位置同理）。
if (printBlock(path.join(SRC, 'cordis.patch.yml')) !== blockStaged) {
  die('托管块内容: 暂存的那份与 recognize/ 那份推导结果不一致 —— tools/ 陈旧或模板被改坏');
}
log('  ✓ 块内容与 recognize/cordis.patch.yml 的推导结果一致（无第二份副本可比对）');

// ───────────────────── 5. tools/ 必须等于 recognize/ 的归一化结果 ─────────────────────
// 只验 tools/ 自身是否自洽是不够的: 改了 recognize/ 而忘了重新暂存，
// 陈旧的那份依然 LF、依然语法通过、闭包依然可达 —— 前四道门全绿，
// 而装进包的是旧代码。实测注入过(在 recognize/lib/fields.mjs 尾部加一行注释)，
// 加上这道门之前 --check 仍 exit 0。
// 这正是本项目栽过的"PR 合了但包里从来没有这批文件"的同类失败，
// 只是换了一副更难发现的面孔(文件在，内容旧)。
//
// 为什么排在内容门**之后**: 若源本身内容就是错的(command 漂移/shebang 不对)，
// 排前面会先报"陈旧，去重新暂存" —— 而照做之后错还在，白绕一圈且误导人。
// 内容门的结论更靠近根因，所以它先说。
const drifted = [];
for (const [srcRel, dstRel] of FILES) {
  const srcAbs = path.join(SRC, srcRel);
  if (!fs.existsSync(srcAbs)) die(`recognize 里没有 ${srcRel} —— 清单和仓库不同步`);
  if (!normalizeLf(fs.readFileSync(srcAbs)).equals(fs.readFileSync(path.join(DEST, dstRel)))) {
    drifted.push(dstRel);
  }
}
log('');
if (drifted.length > 0) {
  die(
    `tools/ 与 recognize/ 不一致（陈旧）: ${drifted.map((d) => 'tools/' + d).join(', ')}` +
      (CHECK_ONLY ? `\n  重新暂存: node dsh/tools/stage-tools.mjs` : `\n  写入后回读不符 —— 本脚本的写入有问题，别继续打包`)
  );
}
// 数量从 FILES 来，不写死 —— 写死 "8" 之后加第 9 个文件时，这行会说谎。
log(`  ✓ ${staged.length}/${FILES.length} 个文件与 recognize/ 归一化后逐字节一致`);

// ─────────────────────────── 6. 报告 ───────────────────────────
const total = staged.reduce((n, f) => n + f.bytes, 0);
log('');
log('='.repeat(58));
log(`  暂存 ${staged.length} 个文件, ${total} B → ${path.relative(ROOT, DEST)}`);
log(`  装机后落点: /data/adb/dsh/tools/  (由 customize.sh 从 $MODPATH/tools 拷过去)`);
log('');
log('下一步: node probe/tools/pack-module.mjs --module dsh/module --out dsh/dist');
if (!CHECK_ONLY) {
  log('');
  log('接入是**自动**的，不需要手工并 YAML:');
  log('  customize.sh 第 7 节跑 bin/register-screen-mcp.mjs，把上面推导出的那个托管块写进');
  log('  home 层 /data/adb/dsh/cordis.patch.yml —— DSH 的 patch 分层里唯一"每次启动都读、');
  log('  且没有任何 DSH 代码会重写"的一层，所以不覆盖任何用户数据。');
  log('  卸载时 module/uninstall.sh 用同一个脚本 --remove 把块摘掉（并留下 []）。');
  log('  装机日志里那行 [ OK ] 就是接入完成；出岔是 [WARN] 并说明原因，绝不 abort 安装。');
  log('  ⚠ profiles/<p>/cordis.yml 由 DSH 在加载时改写（机器写的），不是接入点。');
}
